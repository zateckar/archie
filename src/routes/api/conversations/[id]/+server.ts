import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export async function DELETE({ params, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = params;
        // Verify ownership
        const conv = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(id) as any;
        if (!conv || conv.user_id !== locals.user.id) {
            return json({ error: 'Not found or unauthorized' }, { status: 404 });
        }

        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
