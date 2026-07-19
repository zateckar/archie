import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

function safeParseSources(raw: string): any[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export async function GET({ url, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) {
        return json({ error: 'Missing conversationId' }, { status: 400 });
    }

    try {
        const rows = db.prepare(`
            SELECT role, content, sources
            FROM chat_history 
            WHERE user_id = ? AND conversation_id = ? 
            ORDER BY created_at ASC
        `).all(locals.user.id, conversationId) as Array<{ role: string; content: string; sources: string | null }>;

        // Parse the stored sources JSON back into an array for each message.
        const history = rows.map((r) => ({
            role: r.role,
            content: r.content,
            sources: r.sources ? safeParseSources(r.sources) : []
        }));
        return json(history);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
export async function DELETE({ locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        db.prepare('DELETE FROM chat_history WHERE user_id = ?').run(locals.user.id);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
