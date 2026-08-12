import { searchChunks, buildKnowledgeContext, type QueryKeywords } from './rag';
import {
    chatStream,
    condenseQuery,
    analyzeAndCondenseQuery,
    evaluateContext,
    synthesizeContext,
    buildConversationBriefing
} from './llm';
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
    /** Full retrieved chunks, in citation order. */
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
export function runChat(input: ChatInput): Promise<ChatOutcome> {
    return withUsageCategory('chat', () => prepareChat(input));
}

async function prepareChat({ user, prompt, conversationId, history: rawHistory, skipAnalysis }: ChatInput): Promise<ChatOutcome> {
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
    if (!skipAnalysis) {
        const analysis = await analyzeAndCondenseQuery(prompt, history);

        // If query needs clarification, return questions instead of searching
        if (analysis.needsClarification && analysis.clarificationQuestions && analysis.clarificationQuestions.length > 0) {
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

    // Step 3: Multi-pass context gathering
    // Pass 1: Primary search — knowledge graph + verbatim chunks in parallel
    const [knowledgeResult, relevantChunks] = await Promise.all([
        buildKnowledgeContext(searchPrompt, 5, 15, queryKeywords),
        searchChunks(searchPrompt, 3)
    ]);

    let context = knowledgeResult.text;
    if (relevantChunks.length > 0) {
        const chunkContext = relevantChunks.map(c => `[${c.path || c.filename}]\n${c.content}`).join('\n\n');
        context += `\n\n---\n\nVERBATIM EXCERPTS (for direct quotes if needed):\n\n${chunkContext}`;
    }

    // Pass 2: Evaluate context quality — if insufficient, refine and search again
    const evaluation = await evaluateContext(searchPrompt, context);
    let refinementHappened = false;

    if (!evaluation.sufficient && evaluation.refinedQueries.length > 0) {
        refinementHappened = true;
        console.log(`[MultiPassRAG] Context insufficient for "${searchPrompt.slice(0, 60)}". Missing: ${evaluation.missingAspects.join(', ')}. Refining with: ${evaluation.refinedQueries.join(', ')}`);

        const additionalContexts = await Promise.all(
            evaluation.refinedQueries.slice(0, 2).map(async (refinedQuery) => {
                const [addlKnowledge, addlChunks] = await Promise.all([
                    buildKnowledgeContext(refinedQuery, 3, 10),
                    searchChunks(refinedQuery, 2)
                ]);
                let addlContext = '';
                if (addlKnowledge.text && !addlKnowledge.text.includes('No relevant knowledge found')) {
                    addlContext += addlKnowledge.text;
                }
                if (addlChunks.length > 0) {
                    addlContext += '\n' + addlChunks.map(c => `[${c.path || c.filename}]\n${c.content}`).join('\n\n');
                    // Merge additional chunks into relevantChunks for source display
                    relevantChunks.push(...addlChunks);
                }
                return addlContext;
            })
        );

        const additionalContext = additionalContexts.filter(c => c.trim()).join('\n\n---\n\n');
        if (additionalContext) {
            context += `\n\n---\n\nADDITIONAL CONTEXT (from refined searches for: ${evaluation.missingAspects.join(', ')}):\n\n${additionalContext}`;
        }
    }

    // Build conversation briefing for multi-turn coherence
    const conversationBriefing = history.length >= 2
        ? await buildConversationBriefing(history)
        : '';

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

    let synthesizedContext: string;
    if (context && !context.includes('No relevant knowledge found')) {
        if (canSkipSynthesis) {
            synthesizedContext = context;
            console.log(`[MultiPassRAG] Skipping synthesis pass for "${searchPrompt.slice(0, 60)}" — single-topic, well-covered query.`);
        } else {
            const verbatimSection = relevantChunks.length > 0
                ? relevantChunks.map((c) => `[${c.path || c.filename}]\n${c.content}`).join('\n\n')
                : '';
            synthesizedContext = await synthesizeContext(searchPrompt, context, verbatimSection, conversationBriefing || undefined);
        }
    } else {
        synthesizedContext = context;
    }

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
    const providerStream = await chatStream(prompt, synthesizedContext, history);

    return {
        type: 'answer',
        conversationId: currentConversationId,
        sources: relevantChunks,
        stream: drainAnswer(providerStream, user, currentConversationId, relevantChunks)
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
    chunks: RetrievedChunk[]
): AsyncGenerator<string, void, void> {
    const iterator = providerStream[Symbol.asyncIterator]();
    let fullResponse = '';
    try {
        while (true) {
            const { value, done } = await withUsageCategory('chat', () => iterator.next());
            if (done) break;
            const text = value.text();
            if (text) {
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
