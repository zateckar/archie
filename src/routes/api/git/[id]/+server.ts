import { json } from '@sveltejs/kit';
import { syncGitRepo } from '$lib/server/git';
import { db } from '$lib/server/db';

export async function DELETE({ params }) {
    const id = parseInt(params.id);
    db.prepare('DELETE FROM git_repos WHERE id = ?').run(id);
    return json({ success: true });
}

export async function PATCH({ params, request }) {
    const id = parseInt(params.id);
    const { sync_interval } = await request.json();
    
    if (sync_interval !== undefined) {
        db.prepare('UPDATE git_repos SET sync_interval = ? WHERE id = ?').run(sync_interval, id);
    }
    
    return json({ success: true });
}


export async function POST({ params }) {
    const id = parseInt(params.id);
    try {
        await syncGitRepo(id);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
