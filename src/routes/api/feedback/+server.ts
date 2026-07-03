import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export async function POST({ request, locals }: RequestEvent) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { conversationId, messageIndex, rating } = await request.json();

    if (!conversationId || messageIndex === undefined || ![-1, 1].includes(rating)) {
        return json({ error: 'Invalid feedback data' }, { status: 400 });
    }

    try {
        // Get the query and response from chat history
        const messages = db.prepare(
            'SELECT role, content FROM chat_history WHERE conversation_id = ? ORDER BY created_at ASC'
        ).all(conversationId) as { role: string; content: string }[];

        const queryText = messages[messageIndex - 1]?.content || null;
        const responseText = messages[messageIndex]?.content || null;

        db.prepare(`
            INSERT INTO response_feedback (conversation_id, message_index, rating, query_text, response_text)
            VALUES (?, ?, ?, ?, ?)
        `).run(conversationId, messageIndex, rating, queryText, responseText);

        return json({ success: true });
    } catch (e) {
        console.error('[Feedback] Failed to store:', e);
        return json({ error: 'Failed to store feedback' }, { status: 500 });
    }
}
