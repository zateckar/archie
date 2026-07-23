import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';

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

function litellmBody(
    messages: { role: string; content: string }[],
    config: GenerationConfig | undefined,
    stream: boolean
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: litellmTextModel,
        messages,
        stream
    };
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
): Promise<string> {
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
    return typeof content === 'string' ? content : '';
}

/**
 * Streams an OpenAI-style SSE chat/completions response, yielding StreamChunk
 * objects whose .text() returns each delta — matching what the Gemini SDK's
 * stream produces so consumers stay unchanged.
 */
async function* litellmChatStream(
    messages: { role: string; content: string }[],
    config?: GenerationConfig
): AsyncGenerator<StreamChunk> {
    const url = `${litellmBaseUrl}/chat/completions`;
    const res = await litellmFetch(url, {
        method: 'POST',
        headers: litellmHeaders(),
        body: JSON.stringify(litellmBody(messages, config, true))
    });
    if (!res.ok || !res.body) {
        throw await litellmError('streaming', url, res);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0) {
                    const text = delta;
                    yield { text: () => text };
                }
            } catch {
                // Ignore keep-alives / partial frames.
            }
        }
    }
}

async function litellmEmbed(text: string): Promise<number[]> {
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
    return values;
}

/**
 * Calls the LiteLLM native /rerank endpoint. Returns document indices ordered
 * most→least relevant. Throws if unconfigured or on error so the caller can
 * fall back to the LLM-as-reranker path.
 */
async function litellmRerank(query: string, documents: string[]): Promise<number[]> {
    if (!litellmRerankModel) throw new Error('LLM_RERANK_MODEL not configured');
    const url = `${litellmBaseUrl}/rerank`;
    const res = await litellmFetch(url, {
        method: 'POST',
        headers: litellmHeaders(),
        body: JSON.stringify({
            model: litellmRerankModel,
            query,
            documents,
            top_n: documents.length
        })
    });
    if (!res.ok) {
        throw await litellmError('rerank', url, res);
    }
    const data = await res.json();
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
    config?: GenerationConfig
): Promise<string> {
    const result = await genAI.models.generateContent({
        model,
        contents: prompt,
        config
    });
    return result.text ?? '';
}

async function* geminiChatStream(
    model: string,
    prompt: string,
    systemInstruction: string | undefined,
    history: ChatMessage[],
    config?: GenerationConfig
): AsyncGenerator<StreamChunk> {
    const chat = genAI.chats.create({
        model,
        config: { ...config, systemInstruction },
        history: history.map((msg): Content => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }))
    });
    const stream = await chat.sendMessageStream({ message: prompt });
    for await (const chunk of stream) {
        const text = chunk.text ?? '';
        yield { text: () => text };
    }
}

async function geminiEmbed(
    model: string,
    text: string,
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
    title?: string
): Promise<number[]> {
    const config: Record<string, unknown> = { taskType };
    if (title && taskType === 'RETRIEVAL_DOCUMENT') config.title = title;
    const result = await genAI.models.embedContent({
        model,
        contents: text,
        config
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
export interface GenerateOptions {
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
        try {
            const messages = buildChatMessages(prompt, undefined, []);
            const text = await litellmChatComplete(messages, config);
            return { response: { text: () => text } };
        } catch (e) {
            console.error('[Providers] LiteLLM generateContent failed, falling back to Gemini | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        }
    }
    const text = await geminiGenerate(fallback.model, prompt, config);
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
    config?: GenerationConfig
): Promise<AsyncIterable<StreamChunk>> {
    if (litellmConfigured) {
        try {
            const messages = buildChatMessages(prompt, systemInstruction, history);
            const iterator = litellmChatStream(messages, config);
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
    return geminiChatStream(fallback.model, prompt, systemInstruction, history, config);
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
    title?: string
): Promise<EmbedResult> {
    if (litellmConfigured && litellmEmbeddingModel) {
        try {
            const values = await litellmEmbed(text);
            return { embedding: { values } };
        } catch (e) {
            console.error('[Providers] LiteLLM embedContent failed, falling back to Gemini | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        }
    }
    const values = await geminiEmbed(fallback.model, text, taskType, title);
    return { embedding: { values } };
}

/**
 * Native document reranking via the LiteLLM /rerank endpoint. Returns indices
 * ordered most→least relevant, or `null` when the primary reranker is
 * unavailable/errors so the caller can fall back to LLM-as-reranker.
 */
export async function rerankDocuments(query: string, documents: string[]): Promise<number[] | null> {
    if (!litellmRerankEnabled) return null; // native reranker opt-in; off by default
    if (!litellmConfigured || !litellmRerankModel) return null;
    if (documents.length === 0) return [];
    try {
        return await litellmRerank(query, documents);
    } catch (e) {
        console.error('[Providers] LiteLLM rerank failed, falling back to LLM reranker | status=%s endpoint=%s | %s', (e as any).status ?? 'n/a', (e as any).endpoint ?? 'n/a', (e as Error).message);
        return null;
    }
}
