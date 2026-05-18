import { json } from '@sveltejs/kit';
import { searchChunks, buildKnowledgeContext } from '$lib/server/rag';
import { chatStream, condenseQuery, analyzeQuery, evaluateContext } from '$lib/server/gemini';
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

    // Step 1: Analyze query quality (can be skipped if user already provided clarification)
    if (!skipAnalysis) {
        const analysis = await analyzeQuery(prompt, history);

        // If query needs clarification, return questions instead of searching
        if (analysis.needsClarification && analysis.clarificationQuestions && analysis.clarificationQuestions.length > 0) {
            return json({
                type: 'clarification',
                questions: analysis.clarificationQuestions,
                suggestedQuery: analysis.searchableQuery
            });
        }
    }

    // Step 2: Condense query with conversation history
    const searchPrompt = await condenseQuery(history, prompt);

    // Step 3: Multi-pass context gathering
    // Pass 1: Primary search — knowledge graph + verbatim chunks in parallel
    const [knowledgeContext, relevantChunks] = await Promise.all([
        buildKnowledgeContext(searchPrompt, 5, 15),
        searchChunks(searchPrompt, 3)
    ]);

    let context = knowledgeContext;
    if (relevantChunks.length > 0) {
        const chunkContext = relevantChunks.map(c => `[${c.path || c.filename}]\n${c.content}`).join('\n\n');
        context += `\n\n---\n\nVERBATIM EXCERPTS (for direct quotes if needed):\n\n${chunkContext}`;
    }

    // Pass 2: Evaluate context quality — if insufficient, refine and search again
    const evaluation = await evaluateContext(searchPrompt, context);

    if (!evaluation.sufficient && evaluation.refinedQueries.length > 0) {
        console.log(`[MultiPassRAG] Context insufficient for "${searchPrompt.slice(0, 60)}". Missing: ${evaluation.missingAspects.join(', ')}. Refining with: ${evaluation.refinedQueries.join(', ')}`);

        const additionalContexts = await Promise.all(
            evaluation.refinedQueries.slice(0, 2).map(async (refinedQuery) => {
                const [addlKnowledge, addlChunks] = await Promise.all([
                    buildKnowledgeContext(refinedQuery, 3, 10),
                    searchChunks(refinedQuery, 2)
                ]);
                let addlContext = '';
                if (addlKnowledge && !addlKnowledge.includes('No relevant knowledge found')) {
                    addlContext += addlKnowledge;
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
    const stream = await chatStream(prompt, context, history);
    
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
                // Save assistant response to history
                if (fullResponse) {
                    db.prepare('INSERT INTO chat_history (user_id, role, content, conversation_id) VALUES (?, ?, ?, ?)').run(user.id, 'assistant', fullResponse, currentConversationId);
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
