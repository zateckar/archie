import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export const load = async ({ locals }) => {
    if (!locals.user) {
        throw redirect(302, '/login');
    }

    const conversations = db.prepare(`
        SELECT * FROM conversations 
        WHERE user_id = ? 
        ORDER BY updated_at DESC
    `).all(locals.user.id);

    return {
        conversations
    };
};
