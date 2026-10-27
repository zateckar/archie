import { searchChunks, buildKnowledgeContext, type QueryKeywords } from './rag';
import {
    chatStream,
    condenseQuery,
    analyzeAndCondenseQuery,
    evaluateContext,
    synthesizeContext,
    buildConversationBriefing,
    type ContextDoubt
} from './llm';
import { MAX_FOLLOW_UP_ROUNDS, planFollowUpQueries, verificationNotes } from './follow-up';
import type { ChatProgress, ChatStage, ProgressSink } from '../chat-progress';
import { db } from './db';
import { checkRateLimit, CHAT_RATE_LIMIT } from './rate-limit';
import { withUsageCategory } from './usage';
import { conversationTitle } from '../conversation-title';
import type { SessionUser } from './auth';

/**
 * The whole "ask a question, get a grounded answer" pipeline, independent of how
 * the question arrived.
 *
 * This used to live inline in `routes/api/chat/+server.ts`. It moved here when
 * the MCP server (`./mcp/`) became a second front door onto the same
 * conversation: retrieval, multi-pass refinement, synthesis, rate limiting,
 * ownership checks and history persistence are the *product*, not HTTP plumbing,
 * and a second copy of them would have drifted from the first within a release.
 * The route is now a transport adapter over `runChat`, and so is the MCP `ask`
 * tool — a question asked through either lands in the same conversation, is
 * charged to the same token budget, and is throttled by the same per-user limit.
 */

/** One retrieved chunk, as `searchChunks` returns it. */
export interface RetrievedChunk {
    content: string;
    filename: string;
    path: string | null;
    repo_id: number | null;
    score: number;
}

/** The trimmed, de-duplicated form of a source that gets persisted and reported. */
export interface SourceRef {
    filename: string;
    path: string | null;
    repo_id: number | null;
}

export interface ChatInput {
    /** The authenticated asker. Conversations and history are scoped to them. */
    user: SessionUser;
    /** Deliberately `unknown`: both callers pass parsed JSON from a client. */
    prompt: unknown;
    conversationId?: unknown;
    history?: unknown;
    /**
     * Set when the user is answering a clarification question we just asked.
     * Skips the analysis pass (which would only ask again) and condenses instead.
     */
    skipAnalysis?: unknown;
}

/**
 * The pipeline refused to run. `status` is an HTTP status because that is what
 * both callers ultimately need to report; the MCP adapter turns it into a tool
 * error instead.
 */
export interface ChatRejected {
    type: 'rejected';
    status: 400 | 401 | 404 | 429;
    message: string;
    /** Present only on 429. */
    retryAfterSeconds?: number;
}

/** The query was too vague to search on; we need the user to narrow it first. */
export interface ChatClarification {
    type: 'clarification';
    questions: string[];
    suggestedQuery: string;
}

export interface ChatAnswer {
    type: 'answer';
    /** The conversation the turn was appended to — created here when absent. */
    conversationId: string;
    /**
     * Retrieved chunks in citation order, followed by documents that contributed
     * only knowledge-graph claims (those have empty `content`).
     */
    sources: RetrievedChunk[];
    /**
     * The answer, in provider-sized deltas.
     *
     * Draining this to completion is what persists the assistant turn (see
     * `drainAnswer`): a caller that abandons the generator gets no saved answer,
     * exactly as an abandoned HTTP response body did before.
     */
    stream: AsyncGenerator<string, void, void>;
}

export type ChatOutcome = ChatRejected | ChatClarification | ChatAnswer;

/** A turn as the LLM helpers expect it. Anything else in `history` is dropped. */
export function sanitizeHistory(raw: unknown): { role: string; content: string }[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((m): m is { role: unknown; content: unknown } => !!m && typeof m === 'object')
        .filter(m => typeof m.role === 'string' && typeof m.content === 'string')
        .map(m => ({ role: m.role as string, content: m.content as string }));
}

/**
 * Trims retrieved chunks down to what identifies their document, de-duplicated.
 *
 * `repo_id` is kept so reopening an old conversation can still link each cited
 * source to its wiki page without re-deriving it from the path.
 */
export function sourceRefs(chunks: RetrievedChunk[]): SourceRef[] {
    const seen = new Set<string>();
    return chunks
        .map(c => ({ filename: c.filename, path: c.path ?? null, repo_id: c.repo_id ?? null }))
        .filter(s => {
            const key = s.path || s.filename;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

/**
 * Runs the retrieval + generation pipeline for one question.
 *
 * Everything the question triggers is charged to the 'chat' token budget: query
 * analysis, retrieval embeddings, context evaluation, synthesis, the
 * conversation briefing, and the streamed answer itself. The answer's own cost
 * is not knowable until the stream's final frame, long after this function has
 * returned, so `drainAnswer` re-enters the same category per iteration rather
 * than relying on whatever context the *consumer* happens to run in. Callers do
 * not have to wrap anything.
 */
export function runChat(input: ChatInput, onProgress?: ProgressSink): Promise<ChatOutcome> {
    return withUsageCategory('chat', async () => {
        const admitted = admitChat(input);
        return admitted.type === 'rejected' ? admitted : answerChat(admitted, onProgress);
    });
}

/** A request that passed `admitChat`: validated, rate-limited, owned. */
export interface AdmittedChat {
    type: 'admitted';
    user: SessionUser;
    prompt: string;
    history: { role: string; content: string }[];
    /** An existing conversation the user owns, or undefined for a new one. */
    conversationId?: string;
    skipAnalysis: boolean;
}

/**
 * The cheap checks, with no provider calls: rate limit, prompt, history and
 * conversation ownership. Split from `answerChat` so the HTTP route can still
 * answer a refusal with a real status code, then start streaming progress for
 * an admitted request before any of the slow work begins.
 */
export function admitChat({ user, prompt, conversationId, history: rawHistory, skipAnalysis }: ChatInput): ChatRejected | AdmittedChat {
    // Rate limit before any provider call. This pipeline fans out to a dozen-plus
    // LLM requests per invocation, so it is by far the most expensive thing a
    // client can trigger. Keyed on the user rather than the transport, so opening
    // an MCP client does not hand anyone a second budget.
    const { allowed, resetAt } = checkRateLimit(`chat:${user.id}`, CHAT_RATE_LIMIT);
    if (!allowed) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        return {
            type: 'rejected',
            status: 429,
            message: `Too many requests. Try again in ${retryAfter} seconds.`,
            retryAfterSeconds: retryAfter
        };
    }

    // `prompt` was previously only checked for truthiness, then `.slice(0, 50)`d
    // when titling a new conversation — a numeric or object prompt reached that
    // line and threw, turning a malformed request into a 500.
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return { type: 'rejected', status: 400, message: 'Missing prompt' };
    }

    // `history` was read straight from the body and then dereferenced as
    // `history.length` further down, so a request that simply omitted it — or
    // sent a non-array — produced a 500 rather than being handled. Normalised to
    // an array of well-formed turns once, here, so nothing downstream has to
    // guess.
    const history = sanitizeHistory(rawHistory);

    // Validate conversation ownership up front — see the write site below for why
    // the check exists. It has to happen HERE, before the retrieval and synthesis
    // passes: those cost a dozen-plus provider calls, and rejecting afterwards
    // would mean an unauthorized request still burned the full pipeline.
    if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
        if (typeof conversationId !== 'string') {
            return { type: 'rejected', status: 400, message: 'conversationId must be a string' };
        }
        const owner = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(conversationId) as
            { user_id: number } | undefined;
        if (!owner || owner.user_id !== user.id) {
            return { type: 'rejected', status: 404, message: 'Conversation not found' };
        }
    }

    return {
        type: 'admitted',
        user,
        prompt,
        history,
        conversationId: typeof conversationId === 'string' && conversationId !== '' ? conversationId : undefined,
        skipAnalysis: !!skipAnalysis
    };
}

/**
 * Everything slow: query analysis, retrieval, checking, synthesis, and the
 * start of the answer stream. Reports each stage to `onProgress`. Callers must
 * run it under the 'chat' usage category (`runChat` does; the HTTP route wraps it).
 */
export async function answerChat(
    { user, prompt, history, conversationId, skipAnalysis }: AdmittedChat,
    onProgress?: ProgressSink
): Promise<ChatClarification | ChatAnswer> {
    const progress = progressReporter(onProgress);

    // Step 1+2: Analyze query quality AND condense it with conversation history
    // in a single LLM call (previously two sequential calls: analyzeQuery then
    // condenseQuery). Skipped entirely when the user already answered a
    // clarification prompt — in that case we only need condensing.
    //
    // The same call also splits the query into high-level (thematic) and
    // low-level (entity) keyword sets, which drive the two retrieval levels in
    // buildKnowledgeContext. On the skipAnalysis path there are no keywords and
    // retrieval falls back to searching on the condensed query alone.
    let searchPrompt: string;
    let queryKeywords: QueryKeywords | undefined;
    progress.start('analyze');
    if (!skipAnalysis) {
        const analysis = await analyzeAndCondenseQuery(prompt, history);

        // If query needs clarification, return questions instead of searching
        if (analysis.needsClarification && analysis.clarificationQuestions && analysis.clarificationQuestions.length > 0) {
            progress.done('analyze', 'The question needs clarifying');
            return {
                type: 'clarification',
                questions: analysis.clarificationQuestions,
                suggestedQuery: analysis.searchableQuery
            };
        }
        searchPrompt = analysis.searchableQuery;
        queryKeywords = {
            highLevel: analysis.highLevelKeywords,
            lowLevel: analysis.lowLevelKeywords
        };
    } else {
        searchPrompt = await condenseQuery(history, prompt);
    }
    progress.done('analyze', `Searching for: ${searchPrompt}`);

    const { answerContext, sources } = await buildAnswerContext(searchPrompt, queryKeywords, history, onProgress);

    // Resolve the conversation to append to.
    //
    // `conversationId` arrives from the caller and was previously trusted
    // verbatim: any authenticated user could pass another user's conversation id
    // and have this pipeline write chat_history rows against it and bump its
    // `updated_at`, reordering and polluting a conversation they do not own.
    // (`/api/conversations/[id]` DELETE already verifies ownership the same way —
    // this path was the one that skipped the check.) Ownership was confirmed
    // near the top; by here the id is either ours or absent.
    let currentConversationId: string;
    if (typeof conversationId === 'string' && conversationId !== '') {
        currentConversationId = conversationId;
    } else {
        currentConversationId = crypto.randomUUID();
        db.prepare(`
            INSERT INTO conversations (id, user_id, title)
            VALUES (?, ?, ?)
        `).run(currentConversationId, user.id, conversationTitle(prompt));
    }

    // Save user prompt to history
    db.prepare('INSERT INTO chat_history (user_id, role, content, conversation_id) VALUES (?, ?, ?, ?)').run(user.id, 'user', prompt, currentConversationId);

    // Started here rather than inside the generator so a provider that refuses
    // outright still surfaces as a thrown error to the caller (an HTTP 500),
    // which is what it did before this pipeline was extracted. Failures *during*
    // the stream remain the generator's business.
    // The 'answer' stage closes when the first words arrive (in drainAnswer):
    // with reasoning on, the model thinks for a while before it writes.
    progress.start('answer');
    const providerStream = await chatStream(prompt, answerContext, history);

    return {
        type: 'answer',
        conversationId: currentConversationId,
        sources,
        stream: drainAnswer(providerStream, user, currentConversationId, sources, () => progress.done('answer'))
    };
}

function countsDetail(topics: number, claims: number, passages: number): string {
    const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    return `Found ${n(topics, 'topic', 'topics')}, ${n(claims, 'fact', 'facts')}, ${n(passages, 'passage', 'passages')}`;
}

function evaluationDetail(e: { sufficient: boolean; missingAspects: string[]; doubts: ContextDoubt[] }): string {
    const parts: string[] = [];
    if (!e.sufficient) parts.push(`Missing: ${e.missingAspects.join(', ') || 'parts of the question'}`);
    if (e.doubts.length) parts.push(`Doubtful: ${e.doubts.map(d => d.concern).join('; ')}`);
    return parts.length ? parts.join(' · ') : 'Looks complete and consistent';
}

/**
 * Times stages and forwards them to the sink. A sink that throws (a closed
 * browser stream) must never break the answer, so every call is guarded.
 */
function progressReporter(sink: ProgressSink | undefined) {
    const started = new Map<ChatStage, number>();
    const emit = (event: ChatProgress) => {
        if (!sink) return;
        try { sink(event); } catch { /* the listener went away; keep answering */ }
    };
    return {
        start(stage: ChatStage, detail?: string) {
            started.set(stage, Date.now());
            emit({ stage, status: 'start', detail });
        },
        done(stage: ChatStage, detail?: string) {
            const t = started.get(stage);
            emit({ stage, status: 'done', detail, ms: t === undefined ? undefined : Date.now() - t });
        }
    };
}

/**
 * How the retrieved context reaches the answering model:
 *   - `auto` (default): through the synthesis pass, except for simple,
 *     single-topic, well-covered queries, which pass through raw.
 *   - `off`: always raw. Removes one paraphrase hop and its drift risk; the
 *     raw context keeps every fact's [source] tag.
 *   - `always`: always synthesized.
 * A knob rather than a decision because which one answers better is an
 * empirical question — compare them with `npm run eval -- --answers`.
 */
function synthesisMode(): 'auto' | 'off' | 'always' {
    const v = (process.env.CHAT_SYNTHESIS ?? '').trim().toLowerCase();
    return v === 'off' || v === 'always' ? v : 'auto';
}

/** Verbatim chunks retrieved on the primary pass (CHAT_VERBATIM_CHUNKS, default 3). */
function verbatimChunkCount(): number {
    const n = Number(process.env.CHAT_VERBATIM_CHUNKS);
    return Number.isInteger(n) && n > 0 && n <= 20 ? n : 3;
}

export interface AnswerContext {
    /** What the answering model is given as its briefing. */
    answerContext: string;
    /** Verbatim chunks first, then documents that only contributed claims. */
    sources: RetrievedChunk[];
}

/**
 * Retrieval, multi-pass refinement and (optional) synthesis for one standalone
 * search query — everything between "we know what to search for" and "the
 * answering model starts writing". Has no side effects beyond provider calls,
 * which is what lets the eval harness score real answers without writing
 * conversations.
 */
export async function buildAnswerContext(
    searchPrompt: string,
    queryKeywords: QueryKeywords | undefined,
    history: { role: string; content: string }[],
    onProgress?: ProgressSink
): Promise<AnswerContext> {
    const progress = progressReporter(onProgress);

    // Pass 1: Primary search — knowledge graph + verbatim chunks in parallel
    progress.start('retrieve');
    const [knowledgeResult, relevantChunks] = await Promise.all([
        buildKnowledgeContext(searchPrompt, 5, 15, queryKeywords),
        searchChunks(searchPrompt, verbatimChunkCount())
    ]);
    const claimDocuments = [...knowledgeResult.sources];
    progress.done('retrieve', countsDetail(knowledgeResult.topicCount, knowledgeResult.claimCount, relevantChunks.length));

    let context = knowledgeResult.text;
    if (relevantChunks.length > 0) {
        const chunkContext = relevantChunks.map(c => `[${c.path || c.filename}]\n${c.content}`).join('\n\n');
        context += `\n\n---\n\nVERBATIM EXCERPTS (for direct quotes if needed):\n\n${chunkContext}`;
    }

    // Pass 2+: Check the context for coverage AND plausibility, and search again
    // for what is missing or doubtful — up to MAX_FOLLOW_UP_ROUNDS times. Each
    // round is re-checked against the grown context, so a doubt the new results
    // settle is dropped, and one they do not settle reaches the answering model
    // as a verification note.
    let refinementHappened = false;
    let openDoubts: ContextDoubt[] = [];
    const searched = new Set<string>([searchPrompt]);

    for (let round = 0; round <= MAX_FOLLOW_UP_ROUNDS; round++) {
        progress.start('evaluate');
        const evaluation = await evaluateContext(searchPrompt, context);
        openDoubts = evaluation.doubts;
        progress.done('evaluate', evaluationDetail(evaluation));
        if (round === MAX_FOLLOW_UP_ROUNDS) break;

        const followUps = planFollowUpQueries(evaluation, searched);
        if (followUps.length === 0) break;
        followUps.forEach(f => searched.add(f.query));
        refinementHappened = true;
        console.log(
            `[MultiPassRAG] Round ${round + 1} for "${searchPrompt.slice(0, 60)}". ` +
            `Missing: ${evaluation.missingAspects.join(', ') || '-'}. ` +
            `Doubts: ${evaluation.doubts.map(d => d.concern).join(' | ') || '-'}. ` +
            `Searching: ${followUps.map(f => `${f.query} (${f.purpose})`).join(', ')}`
        );

        progress.start('follow_up', followUps.map(f => f.purpose === 'verify' ? `verifying: ${f.query}` : f.query).join(' · '));
        const additionalContexts = await Promise.all(
            followUps.map(async ({ query: refinedQuery }) => {
                const [addlKnowledge, addlChunks] = await Promise.all([
                    buildKnowledgeContext(refinedQuery, 3, 10),
                    searchChunks(refinedQuery, 2)
                ]);
                let addlContext = '';
                if (addlKnowledge.text && !addlKnowledge.text.includes('No relevant knowledge found')) {
                    addlContext += addlKnowledge.text;
                    claimDocuments.push(...addlKnowledge.sources);
                }
                // A later round often finds the same passage again; repeating it
                // only crowds the context.
                const fresh = addlChunks.filter(c =>
                    !relevantChunks.some(r => (r.path || r.filename) === (c.path || c.filename) && r.content === c.content)
                );
                if (fresh.length > 0) {
                    addlContext += '\n' + fresh.map(c => `[${c.path || c.filename}]\n${c.content}`).join('\n\n');
                    // Merge additional chunks into relevantChunks for source display
                    relevantChunks.push(...fresh);
                }
                return addlContext;
            })
        );

        const additionalContext = additionalContexts.filter(c => c.trim()).join('\n\n---\n\n');
        progress.done('follow_up');
        if (additionalContext) {
            const reasons = [
                ...evaluation.missingAspects,
                ...evaluation.doubts.map(d => `verifying "${d.fact}"`)
            ].join('; ');
            context += `\n\n---\n\nADDITIONAL CONTEXT (from follow-up searches for: ${reasons}):\n\n${additionalContext}`;
        }
    }

    // Synthesize context into a coherent briefing. Skipped for simple,
    // well-covered, single-topic queries — buildKnowledgeContext already
    // produces well-structured markdown (headers, Facts, Constraints), and
    // sending it through another LLM pass purely to reformat it costs a full
    // extra round trip and risks additional paraphrase drift for zero benefit
    // when there's nothing to synthesize across topics or reconcile from a
    // second search pass. Multi-topic or refined-search results still get the
    // full synthesis pass since that's where it earns its cost.
    // A thematic overview in the context is itself a reason NOT to skip: the
    // whole point of that section is material that spans topics, and it is
    // derived prose that must be folded into the briefing rather than passed
    // through raw next to the facts it summarises.
    const canSkipSynthesis =
        !refinementHappened &&
        !knowledgeResult.hasConflicts &&
        knowledgeResult.communityCount === 0 &&
        knowledgeResult.topicCount <= 1 &&
        relevantChunks.length <= 1 &&
        context.length < 4000;

    const mode = synthesisMode();
    const hasKnowledge = !!context && !context.includes('No relevant knowledge found');
    const synthesize = hasKnowledge && (mode === 'always' || (mode === 'auto' && !canSkipSynthesis));

    let answerContext = context;
    if (synthesize) {
        progress.start('synthesize');
        // Conversation briefing for multi-turn coherence. Only the synthesis
        // pass reads it; on the raw path the answering model gets the history itself.
        const conversationBriefing = history.length >= 2
            ? await buildConversationBriefing(history)
            : '';
        const verbatimSection = relevantChunks.length > 0
            ? relevantChunks.map((c) => `[${c.path || c.filename}]\n${c.content}`).join('\n\n')
            : '';
        answerContext = await synthesizeContext(searchPrompt, context, verbatimSection, conversationBriefing || undefined);
        progress.done('synthesize');
    } else if (hasKnowledge) {
        console.log(`[MultiPassRAG] Passing raw context for "${searchPrompt.slice(0, 60)}" (synthesis=${mode}).`);
    }

    // After synthesis, so the doubts reach the answering model verbatim.
    const notes = verificationNotes(openDoubts);
    if (notes && hasKnowledge) {
        console.log(`[MultiPassRAG] ${openDoubts.length} doubt(s) still open for "${searchPrompt.slice(0, 60)}".`);
        answerContext += `\n\n---\n\n${notes}`;
    }

    // Documents that reached the answer only through claims are listed after
    // the verbatim chunks. They carry no passage of their own (`content` is
    // empty); every consumer of `sources` reads only filename/path/repo_id.
    const chunkKeys = new Set(relevantChunks.map(c => c.path || c.filename));
    const claimOnly = claimDocuments.filter(d => {
        const key = d.path || d.filename;
        if (!key || chunkKeys.has(key)) return false;
        chunkKeys.add(key);
        return true;
    });

    return {
        answerContext,
        sources: [
            ...relevantChunks,
            ...claimOnly.map(d => ({ content: '', filename: d.filename, path: d.path, repo_id: d.repo_id, score: 0 }))
        ]
    };
}

/** The shape `providers.startChatStream` yields: chunks with a `.text()`. */
type ProviderStream = AsyncIterable<{ text(): string }>;

/**
 * Yields the answer's text deltas and persists the finished turn.
 *
 * The `finally` is the contract: whatever the consumer does — read to the end,
 * break out of the loop, or die on a transport error — an answer that produced
 * any text is saved, along with the source documents it was grounded in. That
 * mirrors the `finally` in the HTTP route this replaced, so a client that
 * disconnects mid-answer still finds the partial reply in its history.
 *
 * Each `next()` is re-entered under the 'chat' usage category so the provider's
 * final frame (which carries the answer's token counts) is billed to chat no
 * matter which context the consumer iterates from.
 */
async function* drainAnswer(
    providerStream: ProviderStream,
    user: SessionUser,
    conversationId: string,
    chunks: RetrievedChunk[],
    onFirstText?: () => void
): AsyncGenerator<string, void, void> {
    const iterator = providerStream[Symbol.asyncIterator]();
    let fullResponse = '';
    try {
        while (true) {
            const { value, done } = await withUsageCategory('chat', () => iterator.next());
            if (done) break;
            const text = value.text();
            if (text) {
                if (!fullResponse) onFirstText?.();
                fullResponse += text;
                yield text;
            }
        }
    } finally {
        if (fullResponse) {
            const refs = sourceRefs(chunks);
            const sourcesJson = refs.length > 0 ? JSON.stringify(refs) : null;
            db.prepare('INSERT INTO chat_history (user_id, role, content, conversation_id, sources) VALUES (?, ?, ?, ?, ?)')
                .run(user.id, 'assistant', fullResponse, conversationId, sourcesJson);
            db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
        }
    }
}

/** Drains an answer stream into one string. For callers that cannot stream. */
export async function collectAnswer(answer: ChatAnswer): Promise<string> {
    let text = '';
    for await (const delta of answer.stream) text += delta;
    return text;
}
