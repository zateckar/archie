import { json } from '@sveltejs/kit';
import { readWikiFile, readWikiFileAtCommit, getDiff } from '$lib/server/wiki';

export async function GET({ params, url }) {
    const repoId = parseInt(params.repoId);
    const filePath = url.searchParams.get('path');
    const fromOid = url.searchParams.get('from');
    const toOid = url.searchParams.get('to');

    if (!filePath || !fromOid || !toOid) {
        return json({ error: 'Missing path, from, or to parameters' }, { status: 400 });
    }

    const fromContent = await readWikiFileAtCommit(repoId, filePath, fromOid);
    const toContent = await readWikiFileAtCommit(repoId, filePath, toOid);

    if (fromContent === null || toContent === null) {
        return json({ error: 'Could not read file at specified commits' }, { status: 404 });
    }

    const diff = getDiff(fromContent, toContent);
    return json({ diff });
}