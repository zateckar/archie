import { json } from '@sveltejs/kit';
import { syncGitRepo } from '$lib/server/git';

export async function POST({ params }) {
    const id = parseInt(params.id);
    try {
        await syncGitRepo(id);
        return json({ success: true });
    } catch (err: any) {
        console.error(err);
        return json({ error: err.message }, { status: 500 });
    }
}
