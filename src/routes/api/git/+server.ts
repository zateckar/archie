import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { registerRepo } from '$lib/server/git';

export async function GET() {
    const repos = db.prepare('SELECT id, url, last_commit, sync_interval, last_sync_at FROM git_repos').all();
    return json(repos);
}

export async function POST({ request }) {
    const { url, pat, sync_interval } = await request.json();
    if (!url) return json({ error: 'Missing url' }, { status: 400 });
    const id = await registerRepo(url, pat, sync_interval);
    return json({ id });
}
