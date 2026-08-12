import { json } from '@sveltejs/kit';
import { deleteConversation, setConversationPinned } from '$lib/server/conversations';

/**
 * Pin/unpin and delete. Ownership, the "unpin before deleting" rule and the
 * deliberate decision not to touch `updated_at` when pinning all live in
 * `$lib/server/conversations`, so the MCP tools enforce exactly the same rules.
 */
export async function PATCH({ params, request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await request.json();
        if (typeof body?.pinned !== 'boolean') {
            return json({ error: 'Expected { pinned: boolean }' }, { status: 400 });
        }

        const result = setConversationPinned(locals.user.id, params.id, body.pinned);
        if (!result.ok) {
            return json({ error: result.error }, { status: result.status });
        }
        return json(result.value);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE({ params, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = deleteConversation(locals.user.id, params.id);
        if (!result.ok) {
            return json({ error: result.error }, { status: result.status });
        }
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
