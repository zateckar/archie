import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import { estimateTokens, recordUsage, type UsageKind } from './usage';

/**
 * Model provider abstraction.
 *
 * This module exposes three primitive operations used across the app — text
 * generation, chat streaming, and embeddings — plus a native document reranker.
 * Each primitive is served by a PRIMARY provider (a custom OpenAI-compatible
 * LiteLLM gateway configured via LLM_* env vars) and transparently FALLS BACK
 * to Gemini (GEMINI_* env vars) when the primary is unconfigured or errors.
 *
 * Callers in llm.ts keep their existing shapes:
 *   - generateContent(...) returns { response: { text() } }
 *   - startChatStream(...) yields chunks with a .text() method
 *   - embedContent(...) returns { embedding: { values } }
 * so the rest of the codebase does not need to change.
 *
 * This is also where token usage is METERED. Every path out of this module —
 * both providers, all four primitives, success and failure — reports to ./usage,
 * which is what makes the admin dashboard's totals complete by construction: a
 * new LLM feature cannot be added without going through one of these functions.
 * Callers pass an `op` label identifying the task; the spend *category* comes
 * from the ambient AsyncLocalStorage context (see ./usage for why).
 */

// ── Environment resolution ─────────────────────────────────────────────────
let geminiApiKey = process.env.GEMINI_API_KEY || '';

let litellmBaseUrl = process.env.LLM_BASE_URL || '';
let litellmApiKey = process.env.LLM_API_KEY || '';
let litellmTextModel = process.env.LLM_TEXT_MODEL || '';
let litellmEmbeddingModel = process.env.LLM_EMBEDDING_MODEL || '';
let litellmRerankModel = process.env.LLM_RERANK_MODEL || '';
// The native LiteLLM /rerank endpoint is OPT-IN. It is disabled by default
// because the configured gateway reranker was observed returning inverted /
// nonsensical relevance scores (ranking unrelated documents above relevant
// ones), which degrades retrieval. When off, rerank() uses the LLM-as-reranker
// path (text model, Gemini fallback) instead. Set LLM_RERANK_ENABLED=true only
// once the gateway reranker is verified to produce correct ordering.
let litellmRerankEnabled = /^(1|true|yes|on)$/i.test(process.env.LLM_RERANK_ENABLED || '');

// If we are in SvelteKit, prefer values from $env/dynamic/private.
try {
    // @ts-ignore - resolved only inside the SvelteKit runtime
    const { env } = await import('$env/dynamic/private');
    if (env.GEMINI_API_KEY) geminiApiKey = env.GEMINI_API_KEY;
    if (env.LLM_BASE_URL) litellmBaseUrl = env.LLM_BASE_URL;
    if (env.LLM_API_KEY) litellmApiKey = env.LLM_API_KEY;
    if (env.LLM_TEXT_MODEL) litellmTextModel = env.LLM_TEXT_MODEL;
    if (env.LLM_EMBEDDING_MODEL) litellmEmbeddingModel = env.LLM_EMBEDDING_MODEL;
    if (env.LLM_RERANK_MODEL) litellmRerankModel = env.LLM_RERANK_MODEL;
    if (env.LLM_RERANK_ENABLED) litellmRerankEnabled = /^(1|true|yes|on)$/i.test(env.LLM_RERANK_ENABLED);
} catch (e) {
    // Not in SvelteKit environment
}

// Normalize the base URL (strip trailing slash) so path joins are predictable.
litellmBaseUrl = litellmBaseUrl.replace(/\/+$/, '');

const genAI = new GoogleGenAI({ apiKey: geminiApiKey });

/** Whether the LiteLLM gateway has enough config to be used as the primary. */
export const litellmConfigured = Boolean(litellmBaseUrl && litellmApiKey);

/**
 * Max characters per section for whole-text tasks (document cleaning, semantic
 * chunking) that must generate large, near-verbatim output. The LiteLLM gateway
 * generates slowly (~40 tok/s) with a hard ~120s cap, so 80K-char sections
 * always time out there; a small section finishes comfortably. Gemini is fast
 * with a 1M context, so it keeps the large section size for better cross-section
 * consistency. Override the gateway value via LLM_SECTION_MAX_CHARS.
 */
export function sectionMaxChars(geminiSectionMaxChars: number): number {
    if (!litellmConfigured) return geminiSectionMaxChars;
    const override = Number(process.env.LLM_SECTION_MAX_CHARS);
    return Number.isFinite(override) && override > 0 ? override : 6000;
}

// ── Shared types ────────────────────────────────────────────────────────────
export interface GenerationConfig {
    temperature?: number;
    responseMimeType?: string;
    /**
     * Maximum tokens the model may emit. Gemini defaults to a modest cap
     * (~8192 tokens) which silently TRUNCATES tasks that echo large text back
     * (document cleaning, semantic chunking) mid-string, producing unparseable
     * JSON. Callers that expect large output must set this explicitly. Mapped to
     * Gemini's `maxOutputTokens` and the LiteLLM/OpenAI `max_tokens`.
     */
    maxOutputTokens?: number;
}

export interface GenerateResult {
    response: { text: () => string };
}

/** A single streamed chunk, mirroring the Gemini SDK's chunk.text() shape. */
export interface StreamChunk {
    text: () => string;
}

export interface ChatMessage {
    role: string; // 'user' | 'model' | 'assistant' | 'system'
    content: string;
}

export interface EmbedResult {
    embedding: { values: number[] };
}

// ── Token metering helpers ──────────────────────────────────────────────────

/**
 * Task label attached to every metered call, e.g. 'clean_document'. Optional so
 * an un-labelled call still records (as 'unlabelled') rather than being lost —
 * a missing label is a reporting gap worth seeing, not a reason to drop the row.
 */
export interface MeteredOptions {
    op?: string;
}

/** The `usage` block OpenAI-compatible gateways return. */
interface OpenAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

/** Gemini's equivalent, on both generateContent results and stream chunks. */
interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
}

function readOpenAIUsage(usage: unknown): { prompt: number; completion: number; total: number } | null {
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as OpenAIUsage;
    const prompt = Number(u.prompt_tokens);
    const completion = Number(u.completion_tokens);
    const total = Number(u.total_tokens);
    // A gateway that returns the key but leaves it empty is no better than one
    // that omits it — treat it as absent so the caller estimates instead of
    // recording a confident zero.
    if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) return null;
    const p = Number.isFinite(prompt) ? prompt : 0;
    const c = Number.isFinite(completion) ? completion : 0;
    return { prompt: p, completion: c, total: Number.isFinite(total) ? total : p + c };
}

function readGeminiUsage(meta: unknown): { prompt: number; completion: number; total: number } | null {
    if (!meta || typeof meta !== 'object') return null;
    const m = meta as GeminiUsageMetadata;
    const prompt = Number(m.promptTokenCount);
    const completion = Number(m.candidatesTokenCount);
    const total = Number(m.totalTokenCount);
    if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) return null;
    const p = Number.isFinite(prompt) ? prompt : 0;
    const c = Number.isFinite(completion) ? completion : 0;
    return { prompt: p, completion: c, total: Number.isFinite(total) ? total : p + c };
}

/**
 * Records one metered call, preferring provider-reported counts and falling back
 * to character-length estimation over the text we actually sent and received.
 *
 * The fallback matters more than it looks: Gemini's embedding endpoint reports no
 * usage at all, and ingestion is embedding-dominated, so without an estimate the
 * document-processing bucket would under-report by most of its real volume.
 * Estimated rows carry a flag so the dashboard can state how much of a figure is
 * approximate.
 */
function meter(args: {
    op: string | undefined;
    provider: 'litellm' | 'gemini';
    model: string;
    kind: UsageKind;
    reported: { prompt: number; completion: number; total: number } | null;
    inputText: string;
    outputText: string;
    startedAt: number;
    failed?: boolean;
}): void {
    const reported = args.reported;
    recordUsage({
        operation: args.op || 'unlabelled',
        provider: args.provider,
        model: args.model,
        kind: args.kind,
        promptTokens: reported ? reported.prompt : estimateTokens(args.inputText),
        completionTokens: reported ? reported.completion : estimateTokens(args.outputText),
        totalTokens: reported ? reported.total : undefined,
        estimated: !reported,
        durationMs: Date.now() - args.startedAt,
        failed: args.failed
    });
}

/**
 * Records a call that threw.
 *
 * The prompt was transmitted, so the input tokens were spent even though nothing
 * usable came back — a LiteLLM generation that runs for 120s and then hits the
 * gateway's hard cap is real, billable work. Recording it with estimated input
 * tokens and zero output is a defensible floor; recording nothing would make the
 * most expensive failure mode in this pipeline completely invisible. `failed` is
 * set so these rows can be told apart from productive spend.
 */
function meterFailure(
    op: string | undefined,
    provider: 'litellm' | 'gemini',
    model: string,
    kind: UsageKind,
    inputText: string,
    startedAt: number
): void {
    meter({
        op,
        provider,
        model,
        kind,
        reported: null,
        inputText,
        outputText: '',
        startedAt,
        failed: true
    });
}

/** Flattens a chat message array into the text whose length approximates its tokens. */
function messagesText(messages: { role: string; content: string }[]): string {
    return messages.map((m) => m.content).join('\n');
}

// ── LiteLLM (OpenAI-compatible) low-level calls ─────────────────────────────

function litellmHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${litellmApiKey}`
    };
}

/**
 * Per-request timeout (ms) for LiteLLM gateway calls. Override via LLM_TIMEOUT_MS.
 * Default is 125000 (just above the gateway's observed ~120s hard cap) so the
 * gateway's own error (and response body) surfaces for diagnostics instead of a
 * premature client-side abort.
 */
const litellmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 125000;

/**
 * fetch wrapper that aborts after `litellmTimeoutMs` so a hung gateway surfaces
 * as a catchable error (and thus a clean Gemini fallback) instead of stalling.
 */
async function litellmFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), litellmTimeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if ((e as Error).name === 'AbortError') {
            throw new Error(`request timed out after ${litellmTimeoutMs}ms`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Builds a rich Error for a non-OK LiteLLM response, capturing the endpoint,
 * status, and full response body so failures are diagnosable in logs.
 */
async function litellmError(op: string, url: string, res: Response): Promise<Error> {
    const detail = await res.text().catch(() => '<no body>');
    const err: any = new Error(
        `LiteLLM ${op} failed: ${res.status} ${res.statusText} @ ${url} | body: ${detail || '<empty>'}`
    );
    err.status = res.status;
    err.endpoint = url;
    err.body = detail;
    return err;
}

/**
 * Converts the app's generation config + optional system instruction + history
 * into an OpenAI-style chat/completions message array.
 */
function buildChatMessages(
    prompt: string,
    systemInstruction: string | undefined,
    history: ChatMessage[]
): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [];
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }
    for (const msg of history) {
        // Gemini uses 'model' for the assistant; OpenAI-compatible APIs use 'assistant'.
        const role = msg.role === 'model' || msg.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: msg.content });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
}

/**
 * Whether the gateway honours `stream_options: { include_usage: true }` — the
 * only way an OpenAI-compatible stream reports token counts, since a streamed
 * response otherwise ends without a usage block.
 *
 * Learned at runtime rather than configured, because guessing either way has a
 * cost: assume unsupported and every streamed chat answer (the single most
 * user-visible spend in the app) is only ever estimated; assume supported and a
 * gateway that rejects the unknown field would 400 every chat request. So it is
 * sent optimistically, and a 400/422 while it was set flips this to false and
 * retries the same request without it — one degraded request, then correct
 * behaviour for the process lifetime.
 */
let streamUsageSupported: boolean | null = null;

function litellmBody(
    messages: { role: string; content: string }[],
    config: GenerationConfig | undefined,
    stream: boolean,
    includeStreamUsage = false
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: litellmTextModel,
        messages,
        stream
    };
    if (stream && includeStreamUsage) {
        body.stream_options = { include_usage: true };
    }
    if (config?.temperature !== undefined) body.temperature = config.temperature;
    if (config?.maxOutputTokens !== undefined) body.max_tokens = config.maxOutputTokens;
    if (config?.responseMimeType === 'application/json') {
        body.response_format = { type: 'json_object' };
    }
    return body;
}

async function litellmChatComplete(
    messages: { role: string; content: string }[],
    config?: GenerationConfig
): Promise<{ text: string; usage: { prompt: number; completion: number; total: number } | null }> {
    const url = `${litellmBaseUrl}/chat/completions`;
    const res = await litellmFetch(url, {
        method: 'POST',
        headers: litellmHeaders(),
        body: JSON.stringify(litellmBody(messages, config, false))
    });
    if (!res.ok) {
        throw await litellmError('chat/completions', url, res);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return {
        text: typeof content === 'string' ? content : '',
        usage: readOpenAIUsage(data?.usage)
    };
}

/**
 * Streams an OpenAI-style SSE chat/completions response, yielding StreamChunk
 * objects whose .text() returns each delta — matching what the Gemini SDK's
 * stream produces so consumers stay unchanged.
 *
 * Also meters the call itself, because a stream's cost is only knowable once it
 * ends: the usage frame (when the gateway sends one) arrives last, and the
 * emitted text has to be accumulated to estimate when it doesn't. The `finally`
 * is load-bearing — a client that disconnects mid-answer abandons this generator,
 * and the tokens generated up to that point were still spent.
 */
async function* litellmChatStream(
    messages: { role: string; content: string }[],
    config?: GenerationConfig,
    op?: string
): AsyncGenerator<StreamChunk> {
    const url = `${litellmBaseUrl}/chat/completions`;

    const send = (withUsage: boolean) =>
        litellmFetch(url, {
            method: 'POST',
            headers: litellmHeaders(),
            body: JSON.stringify(litellmBody(messages, config, true, withUsage))
        });

    const startedAt = Date.now();
    const inputText = messagesText(messages);
    let askedForUsage = streamUsageSupported !== false;
    let res = await send(askedForUsage);

    // A gateway that doesn't know `stream_options` rejects the whole request.
    // Retry once without it and remember, so this costs at most one request.
    if (!res.ok && askedForUsage && (res.status === 400 || res.status === 422)) {
        console.warn(
            '[Providers] LiteLLM rejected stream_options.include_usage (%s) — retrying without it; ' +
            'streamed answers will use estimated token counts.',
            res.status
        );
        streamUsageSupported = false;
        askedForUsage = false;
        res = await send(false);
    } else if (res.ok && askedForUsage && streamUsageSupported === null) {
        streamUsageSupported = true;
    }

    if (!res.ok || !res.body) {
        meterFailure(op, 'litellm', litellmTextModel, 'stream', inputText, startedAt);
        throw await litellmError('streaming', url, res);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outputText = '';
    let reported: { prompt: number; completion: number; total: number } | null = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE frames are separated by double newlines; process line by line.
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') return;
                try {
                    const parsed = JSON.parse(payload);
                    // The usage frame carries no delta (`choices` is empty), and
                    // some gateways attach usage to the final content frame
                    // instead — so check every frame rather than only the last.
                    const frameUsage = readOpenAIUsage(parsed?.usage);
                    if (frameUsage) reported = frameUsage;
                    const delta = parsed?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        const text = delta;
                        outputText += text;
                        yield { text: () => text };
                    }
                } catch {
                    // Ignore keep-alives / partial frames.
                }
            }
        }
    } finally {
        meter({
            op,
            provider: 'litellm',
            model: litellmTextModel,
            kind: 'stream',
            reported,
            inputText,
            outputText,
            startedAt
        });
    }
}

async function litellmEmbed(
    text: string
): Promise<{ values: number[]; usage: { prompt: number; completion: number; total: number } | null }> {
    const url = `${litellmBaseUrl}/embeddings`;
    const res = await litellmFetch(url, {
        method: 'POST',
        headers: litellmHeaders(),
        body: JSON.stringify({ model: litellmEmbeddingModel, input: text })
    });
    if (!res.ok) {
        throw await litellmError('embeddings', url, res);
    }
    const data = await res.json();
    const values = data?.data?.[0]?.embedding;
    if (!Array.isArray(values)) {
        throw new Error('LiteLLM embeddings returned no vector');
    }
    return { values, usage: readOpenAIUsage(data?.usage) };
}

/**
 * Calls the LiteLLM native /rerank endpoint. Returns document indices ordered
 * most→least relevant. Throws if unconfigured or on error so the caller can
 * fall back to the LLM-as-reranker path.
 */
async function litellmRerank(
    query: string,
    documents: string[],
    op?: string
): Promise<number[]> {
    if (!litellmRerankModel) throw new Error('LLM_RERANK_MODEL not configured');
    const url = `${litellmBaseUrl}/rerank`;
    const startedAt = Date.now();
    // A cross-encoder reads the query alongside every document, so the input it
    // processes is the query repeated per document plus all their text.
    const inputText = documents.map((d) => `${query}\n${d}`).join('\n');
    let res: Response;
    try {
        res = await litellmFetch(url, {
            method: 'POST',
            headers: litellmHeaders(),
            body: JSON.stringify({
                model: litellmRerankModel,
                query,
                documents,
                top_n: documents.length
            })
        });
    } catch (e) {
        meterFailure(op, 'litellm', litellmRerankModel, 'rerank', inputText, startedAt);
        throw e;
    }
    if (!res.ok) {
        meterFailure(op, 'litellm', litellmRerankModel, 'rerank', inputText, startedAt);
        throw await litellmError('rerank', url, res);
    }
    const data = await res.json();
    // Rerank endpoints rarely report token usage (Cohere-style responses carry
    // `meta.billed_units` in search units, not tokens), so this is normally an
    // estimate — flagged as such in the recorded row.
    meter({
        op,
        provider: 'litellm',
        model: litellmRerankModel,
        kind: 'rerank',
        reported: readOpenAIUsage(data?.usage),
        inputText,
        outputText: '',
        startedAt
    });
    const ranked = data?.results;
    if (!Array.isArray(ranked)) {
        throw new Error('LiteLLM rerank returned no results');
    }
    // Each result carries an `index` into the input `documents` array.
    const indices = ranked
        .map((r: any) => r?.index)
        .filter((i: unknown): i is number => typeof i === 'number');
    if (indices.length === 0) throw new Error('LiteLLM rerank returned no indices');
    return indices;
}

// ── Gemini (fallback) low-level calls ───────────────────────────────────────

async function geminiGenerate(
    model: string,
    prompt: string,
    config?: GenerationConfig,
    op?: string
): Promise<string> {
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof genAI.models.generateContent>>;
    try {
        result = await genAI.models.generateContent({
            model,
            contents: prompt,
            config
        });
    } catch (e) {
        meterFailure(op, 'gemini', model, 'generate', prompt, startedAt);
        throw e;
    }
    const text = result.text ?? '';
    meter({
        op,
        provider: 'gemini',
        model,
        kind: 'generate',
        reported: readGeminiUsage((result as { usageMetadata?: unknown }).usageMetadata),
        inputText: prompt,
        outputText: text,
        startedAt
    });
    return text;
}

async function* geminiChatStream(
    model: string,
    prompt: string,
    systemInstruction: string | undefined,
    history: ChatMessage[],
    config?: GenerationConfig,
    op?: string
): AsyncGenerator<StreamChunk> {
    const startedAt = Date.now();
    // What the model actually reads: system instruction + history + this turn.
    const inputText = [systemInstruction ?? '', ...history.map((m) => m.content), prompt].join('\n');
    const chat = genAI.chats.create({
        model,
        config: { ...config, systemInstruction },
        history: history.map((msg): Content => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }))
    });

    let stream: Awaited<ReturnType<typeof chat.sendMessageStream>>;
    try {
        stream = await chat.sendMessageStream({ message: prompt });
    } catch (e) {
        meterFailure(op, 'gemini', model, 'stream', inputText, startedAt);
        throw e;
    }

    let outputText = '';
    let reported: { prompt: number; completion: number; total: number } | null = null;
    try {
        for await (const chunk of stream) {
            // Gemini repeats usageMetadata on chunks, each time with the running
            // cumulative counts — so the last one seen is the authoritative
            // total, and keeping the newest is correct rather than summing.
            const chunkUsage = readGeminiUsage((chunk as { usageMetadata?: unknown }).usageMetadata);
            if (chunkUsage) reported = chunkUsage;
            const text = chunk.text ?? '';
            outputText += text;
            yield { text: () => text };
        }
    } finally {
        // See litellmChatStream: a client disconnect abandons this generator, and
        // the tokens produced before that point were still spent.
        meter({
            op,
            provider: 'gemini',
            model,
            kind: 'stream',
            reported,
            inputText,
            outputText,
            startedAt
        });
    }
}

async function geminiEmbed(
    model: string,
    text: string,
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
    title?: string,
    op?: string
): Promise<number[]> {
    const config: Record<string, unknown> = { taskType };
    if (title && taskType === 'RETRIEVAL_DOCUMENT') config.title = title;
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof genAI.models.embedContent>>;
    try {
        result = await genAI.models.embedContent({
            model,
            contents: text,
            config
        });
    } catch (e) {
        meterFailure(op, 'gemini', model, 'embed', text, startedAt);
        throw e;
    }
    // Gemini's embedding endpoint reports no usage metadata, so this is always an
    // estimate. It is also the highest-volume call in ingestion (one per chunk),
    // which is why the estimate exists at all rather than recording zero.
    meter({
        op,
        provider: 'gemini',
        model,
        kind: 'embed',
        reported: readGeminiUsage((result as { usageMetadata?: unknown }).usageMetadata),
        inputText: text,
        outputText: '',
        startedAt
    });
    const values = result.embeddings?.[0]?.values;
    if (!Array.isArray(values)) {
        throw new Error('Gemini embedContent returned no vector');
    }
    return values;
}

// ── Public provider API (primary → fallback) ────────────────────────────────

export interface GeminiFallback {
    /** Gemini model id to use if the primary provider is unavailable. */
    model: string;
}

/** Options controlling provider routing for a single generateContent call. */
export interface GenerateOptions extends MeteredOptions {
    /**
     * When true, skip the LiteLLM primary and use Gemini directly. Used for
     * whole-document tasks (e.g. summarization) that exceed the LiteLLM
     * gateway's generation time cap and are better served by Gemini's large
     * context + throughput.
     */
    preferGemini?: boolean;
}

/**
 * Text generation. Uses LiteLLM when configured, otherwise Gemini. On a LiteLLM
 * error, transparently retries once against Gemini so a gateway outage degrades
 * to the fallback instead of failing the request. Pass { preferGemini: true }
 * to bypass LiteLLM entirely for this call.
 */
export async function generateContent(
    prompt: string,
    fallback: GeminiFallback,
    config?: GenerationConfig,
    options?: GenerateOptions
): Promise<GenerateResult> {
    if (litellmConfigured && !options?.preferGemini) {
        const startedAt = Date.now();
        try {
            const messages = buildChatMessages(prompt, undefined, []);
            const { text, usage } = await litellmChatComplete(messages, config);
            meter({
                op: options?.op,
                provider: 'litellm',
                model: litellmTextModel,
                kind: 'generate',
                reported: usage,
                inputText: messagesText(messages),
                outputText: text,
                startedAt
            });
            return { response: { text: () => text } };
        } catch (e) {
            // Metered as a failure, then the Gemini attempt below is metered
            // separately — a fallback costs input tokens at BOTH providers, and
            // reporting only the successful one would understate it.
            meterFailure(options?.op, 'litellm', litellmTextModel, 'generate', prompt, startedAt);
            console.error('[Providers] LiteLLM generateContent failed, falling back to Gemini | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        }
    }
    const text = await geminiGenerate(fallback.model, prompt, config, options?.op);
    return { response: { text: () => text } };
}

/**
 * Chat streaming. Returns an async iterable of chunks whose .text() yields the
 * incremental text, matching the Gemini SDK stream that the chat endpoint
 * already consumes. Falls back to Gemini on primary failure.
 */
export async function startChatStream(
    prompt: string,
    systemInstruction: string,
    history: ChatMessage[],
    fallback: GeminiFallback,
    config?: GenerationConfig,
    options?: MeteredOptions
): Promise<AsyncIterable<StreamChunk>> {
    if (litellmConfigured) {
        try {
            const messages = buildChatMessages(prompt, systemInstruction, history);
            // litellmChatStream meters itself — see the comment on its `finally`.
            const iterator = litellmChatStream(messages, config, options?.op);
            // Pull the first chunk eagerly so an immediate HTTP error surfaces
            // here (and we can fall back) rather than mid-stream after the
            // caller has already committed to the primary provider.
            const first = await iterator.next();
            return (async function* () {
                if (!first.done) yield first.value;
                yield* iterator;
            })();
        } catch (e) {
            console.error('[Providers] LiteLLM chat stream failed, falling back to Gemini | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        }
    }
    return geminiChatStream(fallback.model, prompt, systemInstruction, history, config, options?.op);
}

/**
 * Embeddings. Uses LiteLLM when configured, otherwise Gemini. Falls back to
 * Gemini on primary failure.
 *
 * Note: `taskType`/`title` are Gemini-specific retrieval hints; the LiteLLM
 * OpenAI-compatible embeddings endpoint takes plain text, so those are only
 * applied on the Gemini path.
 */
export async function embedContent(
    text: string,
    fallback: GeminiFallback,
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT',
    title?: string,
    options?: MeteredOptions
): Promise<EmbedResult> {
    if (litellmConfigured && litellmEmbeddingModel) {
        const startedAt = Date.now();
        try {
            const { values, usage } = await litellmEmbed(text);
            meter({
                op: options?.op,
                provider: 'litellm',
                model: litellmEmbeddingModel,
                kind: 'embed',
                reported: usage,
                inputText: text,
                outputText: '',
                startedAt
            });
            return { embedding: { values } };
        } catch (e) {
            meterFailure(options?.op, 'litellm', litellmEmbeddingModel, 'embed', text, startedAt);
            console.error('[Providers] LiteLLM embedContent failed, falling back to Gemini | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        }
    }
    const values = await geminiEmbed(fallback.model, text, taskType, title, options?.op);
    return { embedding: { values } };
}

/**
 * Native document reranking via the LiteLLM /rerank endpoint. Returns indices
 * ordered most→least relevant, or `null` when the primary reranker is
 * unavailable/errors so the caller can fall back to LLM-as-reranker.
 */
export async function rerankDocuments(
    query: string,
    documents: string[],
    options?: MeteredOptions
): Promise<number[] | null> {
    if (!litellmRerankEnabled) return null; // native reranker opt-in; off by default
    if (!litellmConfigured || !litellmRerankModel) return null;
    if (documents.length === 0) return [];
    try {
        // litellmRerank meters itself, including its failure paths.
        return await litellmRerank(query, documents, options?.op);
    } catch (e) {
        console.error('[Providers] LiteLLM rerank failed, falling back to LLM reranker | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        return null;
    }
}
