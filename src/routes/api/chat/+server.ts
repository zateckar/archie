import { json } from '@sveltejs/kit';
import { admitChat, answerChat } from '$lib/server/chat-pipeline';
import { withUsageCategory } from '$lib/server/usage';
import type { RequestHandler } from './$types';

/**
 * The browser's front door onto the chat pipeline.
 *
 * All of the retrieval, refinement, synthesis, throttling and persistence lives
 * in `$lib/server/chat-pipeline`. What is left in this file is the wire format:
 * newline-delimited JSON frames — `progress` frames while the answer is being
 * prepared, then either a `clarification`, or `conversation` (the id the
 * client adopts for a new conversation), `sources` and `chunk`s; an `error`
 * frame if anything breaks after the stream has opened. The MCP server (`$lib/server/mcp`) is the other front door onto
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

    // Cheap checks first, so a refusal is still a real HTTP status.
    const admitted = admitChat({ user, prompt, conversationId, history, skipAnalysis });
    if (admitted.type === 'rejected') {
        const headers = admitted.retryAfterSeconds
            ? { 'Retry-After': String(admitted.retryAfterSeconds) }
            : undefined;
        return json({ error: admitted.message }, { status: admitted.status, headers });
    }

    const encoder = new TextEncoder();
    const frame = (payload: unknown) => encoder.encode(JSON.stringify(payload) + '\n');

    // The stream opens immediately and the slow pipeline runs inside it, so
    // the browser sees each stage as it happens instead of a silent minute.
    let open = true;
    const readable = new ReadableStream({
        async start(controller) {
            const send = (payload: unknown) => {
                if (open) controller.enqueue(frame(payload));
            };
            try {
                const outcome = await withUsageCategory('chat', () =>
                    answerChat(admitted, (event) => send({ type: 'progress', data: event }))
                );
                if (outcome.type === 'clarification') {
                    send({ type: 'clarification', questions: outcome.questions, suggestedQuery: outcome.suggestedQuery });
                    return;
                }
                // The conversation id is only known once the pipeline has
                // created it, after the headers have gone — so it is a frame.
                send({ type: 'conversation', id: outcome.conversationId });
                // Sources before any prose: the client renders the citation
                // chips while the answer is still being written.
                send({ type: 'sources', data: outcome.sources });
                for await (const text of outcome.stream) {
                    // Browser gone: stop generating. Leaving the loop runs the
                    // pipeline's `finally`, which saves the partial answer.
                    if (!open) break;
                    send({ type: 'chunk', data: text });
                }
            } catch (err) {
                console.error('Chat stream error:', err);
                send({ type: 'error', data: 'Something went wrong while preparing the answer.' });
            } finally {
                if (open) {
                    open = false;
                    controller.close();
                }
            }
        },
        cancel() {
            // The browser went away. Retrieval already under way finishes its
            // current step; nothing more is sent and the answer loop stops.
            open = false;
        }
    });

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
};
