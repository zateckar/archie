import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

/** Returns the caller's own conversation row, or null when it is not theirs. */
function ownedConversation(id: string, userId: number) {
    const conv = db
        .prepare('SELECT id, user_id, pinned FROM conversations WHERE id = ?')
        .get(id) as { id: string; user_id: number; pinned: number } | undefined;
    return conv && conv.user_id === userId ? conv : null;
}

export async function PATCH({ params, request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = params;
        const conv = ownedConversation(id, locals.user.id);
        if (!conv) {
            return json({ error: 'Not found or unauthorized' }, { status: 404 });
        }

        const body = await request.json();
        if (typeof body?.pinned !== 'boolean') {
            return json({ error: 'Expected { pinned: boolean }' }, { status: 400 });
        }

        // Pinning is not an edit to the conversation's content, so updated_at is
        // deliberately left alone — pinning must not reshuffle the recents list.
        db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(body.pinned ? 1 : 0, id);

        const updated = db
            .prepare('SELECT id, title, pinned, created_at, updated_at FROM conversations WHERE id = ?')
            .get(id);
        return json(updated);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE({ params, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = params;
        const conv = ownedConversation(id, locals.user.id);
        if (!conv) {
            return json({ error: 'Not found or unauthorized' }, { status: 404 });
        }

        // A pin is the user's own "don't lose this" marker; deleting through it
        // would make the marker meaningless. Unpin first.
        if (conv.pinned) {
            return json({ error: 'Unpin this conversation before deleting it.' }, { status: 409 });
        }

        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
