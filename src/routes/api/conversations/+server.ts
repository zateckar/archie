import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export async function GET({ locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const conversations = db.prepare(`
            SELECT * FROM conversations 
            WHERE user_id = ? 
            ORDER BY updated_at DESC
        `).all(locals.user.id);
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
