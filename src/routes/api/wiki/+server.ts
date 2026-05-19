import { json } from '@sveltejs/kit';
import { listWikiRepos } from '$lib/server/wiki';

export async function GET() {
    const repos = listWikiRepos();
    return json(repos);
}