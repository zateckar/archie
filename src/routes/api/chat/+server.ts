import { json } from '@sveltejs/kit';
import { runChat } from '$lib/server/chat-pipeline';
import type { RequestHandler } from './$types';

/**
 * The browser's front door onto the chat pipeline.
 *
 * All of the retrieval, refinement, synthesis, throttling and persistence lives
 * in `$lib/server/chat-pipeline` — including the 'chat' token-usage
 * attribution, which the pipeline re-enters for every streamed chunk so it no
 * longer depends on a wrapper here. What is left in this file is the wire
 * format: newline-delimited JSON frames (`sources`, then `chunk`s, then an
 * `error` frame if the provider stream breaks mid-answer) and the
 * `X-Conversation-Id` header the client uses to adopt a freshly created
 * conversation. The MCP server (`$lib/server/mcp`) is the other front door onto
 * the same pipeline; keep behaviour changes in the pipeline so both inherit them.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
        return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { prompt, conversationId, skipAnalysis, history } = body as Record<string, unknown>;

    const outcome = await runChat({ user, prompt, conversationId, history, skipAnalysis });

    if (outcome.type === 'rejected') {
        const headers = outcome.retryAfterSeconds
            ? { 'Retry-After': String(outcome.retryAfterSeconds) }
            : undefined;
        return json({ error: outcome.message }, { status: outcome.status, headers });
    }

    if (outcome.type === 'clarification') {
        return json({
            type: 'clarification',
            questions: outcome.questions,
            suggestedQuery: outcome.suggestedQuery
        });
    }

    const encoder = new TextEncoder();
    const frame = (payload: unknown) => encoder.encode(JSON.stringify(payload) + '\n');

    const readable = new ReadableStream({
        async start(controller) {
            // Sources first, as a special JSON line: the client renders the
            // citation chips before any prose has arrived.
            controller.enqueue(frame({ type: 'sources', data: outcome.sources }));
            try {
                for await (const text of outcome.stream) {
                    controller.enqueue(frame({ type: 'chunk', data: text }));
                }
            } catch (err) {
                console.error('Stream error:', err);
                controller.enqueue(frame({ type: 'error', data: 'Stream failed' }));
            } finally {
                // Whatever arrived before the break is already saved — the
                // pipeline's own `finally` owns that.
                controller.close();
            }
        }
    });

    return new Response(readable, {
        headers: {
            'X-Conversation-Id': outcome.conversationId,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
};
