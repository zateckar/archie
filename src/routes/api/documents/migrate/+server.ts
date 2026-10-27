import { json } from '@sveltejs/kit';
import { commitAuthorFor } from '$lib/server/wiki';
import { listAppOnlyUploads, planUploadMigration, moveUploadToRepo } from '$lib/server/upload-migration';

/**
 * Plan for moving app-only uploads into a repository. Without `repoId`, just the
 * uploads; with it, each upload's target path under `folder` and whether it can
 * move there. Changes nothing.
 */
export async function GET({ url }) {
    const repoId = Number(url.searchParams.get('repoId'));
    if (!url.searchParams.has('repoId')) {
        return json({ uploads: listAppOnlyUploads() });
    }
    if (!Number.isInteger(repoId) || repoId <= 0) {
        return json({ error: 'Invalid repository' }, { status: 400 });
    }
    const plan = planUploadMigration(repoId, url.searchParams.get('folder') ?? '');
    if (!plan.ok) return json({ error: plan.error }, { status: 400 });
    return json({ moves: plan.moves });
}

/**
 * Moves ONE upload (one commit + push). The admin page calls this per document
 * so it can show progress and so a failure is contained to one file.
 */
export async function POST({ request, locals }) {
    const { docId, repoId, folder } = await request.json();
    const doc = Number(docId);
    const repo = Number(repoId);
    if (!Number.isInteger(doc) || !Number.isInteger(repo) || repo <= 0) {
        return json({ error: 'Missing docId or repoId' }, { status: 400 });
    }
    const result = await moveUploadToRepo(doc, repo, folder ?? '', commitAuthorFor(locals.user));
    return json(result, { status: result.status === 'failed' ? 500 : 200 });
}
