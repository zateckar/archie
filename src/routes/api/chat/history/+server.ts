import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { conversationTranscript } from '$lib/server/conversations';

export async function GET({ url, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) {
        return json({ error: 'Missing conversationId' }, { status: 400 });
    }

    try {
        // Sources are parsed back out of their stored JSON and given their
        // `repo_id` where it was recorded later — see conversationTranscript.
        return json(conversationTranscript(locals.user.id, conversationId));
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
