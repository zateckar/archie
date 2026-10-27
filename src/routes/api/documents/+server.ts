import { json } from '@sveltejs/kit';
import { getDocuments } from '$lib/server/db';
import { getRepo, readWikiFile, saveWikiFile, commitAuthorFor, IngestionError } from '$lib/server/wiki';
import { normalizeFolder, checkUploadFilename, uploadPath } from '$lib/server/repo-upload';

export async function GET() {
    return json(getDocuments());
}

/**
 * Uploads a document INTO a git repository: the file is committed and pushed
 * to `repoId` at `folder/filename`, then ingested as a git document. Uploads
 * used to be stored only in SQLite, outside version control and invisible to
 * anyone working from the repository.
 *
 * Body: { filename, content, repoId, folder?, overwrite? }. `folder` may name a
 * folder that does not exist yet — it is created by the commit.
 */
export async function POST({ request, locals }) {
    const { filename, content, repoId, folder, overwrite } = await request.json();

    if (typeof content !== 'string' || content.length === 0) {
        return json({ error: 'Missing or empty content' }, { status: 400 });
    }
    const id = Number(repoId);
    if (!Number.isInteger(id) || id <= 0) {
        return json({ error: 'Choose the repository to upload into' }, { status: 400 });
    }
    if (!getRepo(id)) {
        return json({ error: 'Repository not found' }, { status: 404 });
    }

    const name = checkUploadFilename(filename);
    if (!name.ok) return json({ error: name.error }, { status: 400 });
    const dir = normalizeFolder(folder);
    if (!dir.ok) return json({ error: dir.error }, { status: 400 });

    const filePath = uploadPath(dir.value, name.value);
    const exists = readWikiFile(id, filePath) !== null;
    if (exists && overwrite !== true) {
        // Replacing a file in someone's repository is a decision, not a side
        // effect of picking the same name — the client asks and resends.
        return json({ error: `A file already exists at ${filePath}`, exists: true, path: filePath }, { status: 409 });
    }

    try {
        await saveWikiFile(id, filePath, content, commitAuthorFor(locals.user), {
            message: `[Upload] ${exists ? 'Replaced' : 'Added'} ${filePath}`,
            awaitIngestion: true
        });
        return json({ path: filePath });
    } catch (err) {
        const reason = (err as Error)?.message ?? String(err);
        if (err instanceof IngestionError) {
            // The commit stands; only indexing failed (most usefully the
            // embedding-dimension guard). Saying "upload failed" would invite a
            // re-upload that just commits the same file again.
            console.error(`[Documents] Saved "${filePath}" to git but failed to ingest it:`, err);
            return json({
                path: filePath,
                warning: `Saved to Git, but indexing failed: ${reason}. Save the file again from the wiki to retry, or run \`npm run reembed\`.`
            });
        }
        console.error(`[Documents] Failed to upload "${filePath}" to repo ${id}:`, err);
        return json({ error: `Failed to save to Git: ${reason}` }, { status: 500 });
    }
}
