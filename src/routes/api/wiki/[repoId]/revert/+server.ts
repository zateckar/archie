import { json } from '@sveltejs/kit';
import { revertToCommit } from '$lib/server/wiki';

export async function POST({ params, request }) {
    const repoId = parseInt(params.repoId);
    const { path: filePath, oid } = await request.json();

    if (!filePath || !oid) {
        return json({ error: 'Missing path or oid' }, { status: 400 });
    }

    try {
        await revertToCommit(repoId, filePath, oid);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}