import { json } from '@sveltejs/kit';
import { searchChunks, buildKnowledgeContext, type QueryKeywords } from '$lib/server/rag';
import { chatStream, condenseQuery, analyzeAndCondenseQuery, evaluateContext, synthesizeContext, buildConversationBriefing } from '$lib/server/llm';
import { db } from '$lib/server/db';
import { checkRateLimit, CHAT_RATE_LIMIT } from '$lib/server/rate-limit';
import { withUsageCategory } from '$lib/server/usage';
import type { RequestEvent, RequestHandler } from './$types';

/** A turn as the LLM helpers expect it. Anything else in `history` is dropped. */
function sanitizeHistory(raw: unknown): { role: string; content: string }[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((m): m is { role: unknown; content: unknown } => !!m && typeof m === 'object')
        .filter(m => typeof m.role === 'string' && typeof m.content === 'string')
        .map(m => ({ role: m.role as string, content: m.content as string }));
}

/**
 * Charges everything this endpoint triggers to the 'chat' token budget: query
 * analysis, the retrieval embeddings, context evaluation, synthesis, the
 * conversation briefing, and the streamed answer itself.
 *
 * The wrapper sits around the whole handler rather than around individual LLM
 * calls because the answer's own token cost is not knowable until after the
 * handler has returned — it arrives in the stream's final frame. The
 * `ReadableStream` below is constructed inside this context, so its `start`
 * callback and the provider generator it drains both inherit the category and the
 * streamed answer still lands in the right bucket.
 */
export const POST: RequestHandler = async (event) => withUsageCategory('chat', () => handleChat(event));

async function handleChat({ request, locals }: RequestEvent) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limit before any provider call. This endpoint fans out to a dozen-plus
    // LLM requests per invocation, so it is by far the most expensive thing a
    // client can trigger and was previously the only unthrottled one.
    const { allowed, resetAt } = checkRateLimit(`chat:${user.id}`, CHAT_RATE_LIMIT);
    if (!allowed) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        return json(
            { error: `Too many requests. Try again in ${retryAfter} seconds.` },
            { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
        return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { prompt, conversationId, skipAnalysis } = body as Record<string, unknown>;

    // `prompt` was previously only checked for truthiness, then `.slice(0, 50)`d
    // when titling a new conversation — a numeric or object prompt reached that
    // line and threw, turning a malformed request into a 500.
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return json({ error: 'Missing prompt' }, { status: 400 });
    }

    // `history` was read straight from the body and then dereferenced as
    // `history.length` further down, so a request that simply omitted it — or
    // sent a non-array — produced a 500 rather than being handled. Normalised to
    // an array of well-formed turns once, here, so nothing downstream has to
    // guess.
    const history = sanitizeHistory((body as Record<string, unknown>).history);

    // Validate conversation ownership up front — see the write site below for why
    // the check exists. It has to happen HERE, before the retrieval and synthesis
    // passes: those cost a dozen-plus provider calls, and rejecting afterwards
    // would mean an unauthorized request still burned the full pipeline.
    if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
        if (typeof conversationId !== 'string') {
            return json({ error: 'conversationId must be a string' }, { status: 400 });
        }
        const owner = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(conversationId) as
            { user_id: number } | undefined;
        if (!owner || owner.user_id !== user.id) {
            return json({ error: 'Conversation not found' }, { status: 404 });
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
            return json({
                type: 'clarification',
                questions: analysis.clarificationQuestions,
                suggestedQuery: analysis.searchableQuery
            });
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
                ? relevantChunks.map((c: any) => `[${c.path || c.filename}]\n${c.content}`).join('\n\n')
                : '';
            synthesizedContext = await synthesizeContext(searchPrompt, context, verbatimSection, conversationBriefing || undefined);
        }
    } else {
        synthesizedContext = context;
    }

    // Resolve the conversation to append to.
    //
    // `conversationId` arrives from the request body and was previously trusted
    // verbatim: any authenticated user could pass another user's conversation id
    // and have this endpoint write chat_history rows against it and bump its
    // `updated_at`, reordering and polluting a conversation they do not own.
    // (`/api/conversations/[id]` DELETE already verifies ownership the same way —
    // this endpoint was the one that skipped the check.) Ownership was confirmed
    // near the top of the handler; by here the id is either ours or absent.
    let currentConversationId: string;
    if (typeof conversationId === 'string' && conversationId !== '') {
        currentConversationId = conversationId;
    } else {
        currentConversationId = crypto.randomUUID();
        db.prepare(`
            INSERT INTO conversations (id, user_id, title)
            VALUES (?, ?, ?)
        `).run(currentConversationId, user.id, prompt.slice(0, 50));
    }

    // Save user prompt to history
    db.prepare('INSERT INTO chat_history (user_id, role, content, conversation_id) VALUES (?, ?, ?, ?)').run(user.id, 'user', prompt, currentConversationId);
    const stream = await chatStream(prompt, synthesizedContext, history);
    
    const readable = new ReadableStream({
        async start(controller) {
            let fullResponse = '';
            // Send sources first as a special JSON line
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'sources', data: relevantChunks }) + '\n'));
            
            try {
                for await (const chunk of stream) {
                    const text = chunk.text();
                    if (text) {
                        controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'chunk', data: text }) + '\n'));
                        fullResponse += text;
                    }
                }
            } catch (err) {
                console.error('Stream error:', err);
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'error', data: 'Stream failed' }) + '\n'));
            } finally {
                // Save assistant response to history, together with the source
                // documents used — trimmed to identifiers and de-duplicated — so
                // past conversations can trace answers back to their sources.
                if (fullResponse) {
                    const seen = new Set<string>();
                    const sourceIds = relevantChunks
                        // repo_id is stored too, so reopening an old conversation
                        // can still link each cited source to its wiki page
                        // without re-deriving it from the path.
                        .map((c: any) => ({ filename: c.filename, path: c.path ?? null, repo_id: c.repo_id ?? null }))
                        .filter((s: any) => {
                            const key = s.path || s.filename;
                            if (!key || seen.has(key)) return false;
                            seen.add(key);
                            return true;
                        });
                    const sourcesJson = sourceIds.length > 0 ? JSON.stringify(sourceIds) : null;
                    db.prepare('INSERT INTO chat_history (user_id, role, content, conversation_id, sources) VALUES (?, ?, ?, ?, ?)').run(user.id, 'assistant', fullResponse, currentConversationId, sourcesJson);
                    db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(currentConversationId);
                }
                controller.close();
            }
        }
    });

    return new Response(readable, {
        headers: {
            'X-Conversation-Id': currentConversationId,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}
