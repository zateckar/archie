import { json } from '@sveltejs/kit';
import { searchChunks, buildKnowledgeContext } from '$lib/server/rag';
import { chatStream, condenseQuery, analyzeAndCondenseQuery, evaluateContext, synthesizeContext, buildConversationBriefing } from '$lib/server/gemini';
import { db } from '$lib/server/db';

export async function POST({ request, locals }) {
    const { prompt, history, conversationId, skipAnalysis } = await request.json();
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!prompt) {
        return json({ error: 'Missing prompt' }, { status: 400 });
    }

    // Step 1+2: Analyze query quality AND condense it with conversation history
    // in a single LLM call (previously two sequential calls: analyzeQuery then
    // condenseQuery). Skipped entirely when the user already answered a
    // clarification prompt — in that case we only need condensing.
    let searchPrompt: string;
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
    } else {
        searchPrompt = await condenseQuery(history, prompt);
    }

    // Step 3: Multi-pass context gathering
    // Pass 1: Primary search — knowledge graph + verbatim chunks in parallel
    const [knowledgeResult, relevantChunks] = await Promise.all([
        buildKnowledgeContext(searchPrompt, 5, 15),
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
    const canSkipSynthesis =
        !refinementHappened &&
        !knowledgeResult.hasConflicts &&
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

    // Save user prompt to history
    let currentConversationId = conversationId;
    if (!currentConversationId) {
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
                        .map((c: any) => ({ filename: c.filename, path: c.path ?? null }))
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
