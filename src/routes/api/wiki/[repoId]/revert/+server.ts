import { json } from '@sveltejs/kit';
import { revertToCommit, commitAuthorFor } from '$lib/server/wiki';

export async function POST({ params, request, locals }) {
    const repoId = parseInt(params.repoId);
    const { path: filePath, oid } = await request.json();

    if (!filePath || !oid) {
        return json({ error: 'Missing path or oid' }, { status: 400 });
    }

    try {
        // Attributed to whoever pressed revert — a revert is an edit like any
        // other, and the history panel reads these author names.
        await revertToCommit(repoId, filePath, oid, commitAuthorFor(locals.user));
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}