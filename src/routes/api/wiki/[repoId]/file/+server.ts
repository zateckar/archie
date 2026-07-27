import { json } from '@sveltejs/kit';
import { readWikiFile, readWikiFileAtCommit, saveWikiFile, createWikiFile, commitAuthorFor } from '$lib/server/wiki';

export async function GET({ params, url }) {
    const repoId = parseInt(params.repoId);
    const filePath = url.searchParams.get('path');
    const oid = url.searchParams.get('oid');

    if (!filePath) {
        return json({ error: 'Missing path parameter' }, { status: 400 });
    }

    let content: string | null;
    if (oid) {
        content = await readWikiFileAtCommit(repoId, filePath, oid);
    } else {
        content = readWikiFile(repoId, filePath);
    }

    if (content === null) {
        return json({ error: 'File not found' }, { status: 404 });
    }

    return json({ content, path: filePath });
}

export async function PUT({ params, request, locals }) {
    const repoId = parseInt(params.repoId);
    const { path: filePath, content } = await request.json();

    if (!filePath || content === undefined) {
        return json({ error: 'Missing path or content' }, { status: 400 });
    }

    try {
        // The commit is attributed to the signed-in account, not a generic
        // "Wiki Editor". hooks.server.ts guarantees a user on any non-GET
        // /api/wiki request, so this is never the fallback identity in practice.
        await saveWikiFile(repoId, filePath, content, commitAuthorFor(locals.user));
        return json({ success: true, path: filePath });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}

export async function POST({ params, request, locals }) {
    const repoId = parseInt(params.repoId);
    const { path: filePath, content } = await request.json();

    if (!filePath || content === undefined) {
        return json({ error: 'Missing path or content' }, { status: 400 });
    }

    try {
        await createWikiFile(repoId, filePath, content, commitAuthorFor(locals.user));
        return json({ success: true, path: filePath });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}