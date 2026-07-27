import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

/** Escapes the LIKE wildcards so a query of "100%" matches literally. */
function likePattern(query: string): string {
    return '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

export async function GET({ url, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const query = (url.searchParams.get('q') ?? '').trim();

        if (!query) {
            const conversations = db.prepare(`
                SELECT id, title, pinned, created_at, updated_at
                FROM conversations
                WHERE user_id = ?
                ORDER BY pinned DESC, updated_at DESC
            `).all(locals.user.id);
            return json(conversations);
        }

        // Match the title or anything said inside the conversation — searching
        // only titles would miss almost everything, since a title is just the
        // opening prompt truncated.
        const pattern = likePattern(query);
        const conversations = db.prepare(`
            SELECT c.id, c.title, c.pinned, c.created_at, c.updated_at
            FROM conversations c
            WHERE c.user_id = ?
              AND (
                c.title LIKE ? ESCAPE '\\'
                OR EXISTS (
                    SELECT 1 FROM chat_history h
                    WHERE h.conversation_id = c.id
                      AND h.content LIKE ? ESCAPE '\\'
                )
              )
            ORDER BY c.pinned DESC, c.updated_at DESC
        `).all(locals.user.id, pattern, pattern);
        return json(conversations);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}

export async function POST({ request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { title } = await request.json();
        const id = crypto.randomUUID();
        db.prepare(`
            INSERT INTO conversations (id, user_id, title)
            VALUES (?, ?, ?)
        `).run(id, locals.user.id, title || 'New Conversation');

        const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
        return json(conversation);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
