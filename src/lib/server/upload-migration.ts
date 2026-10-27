/**
 * One-off move of app-only uploads into a git repository.
 *
 * Before uploads were committed to git, they were stored only in SQLite
 * (`source = 'upload'`, `repo_id IS NULL`): no history, no wiki page, nothing
 * anyone working from the repository could see. This moves them, one document
 * per commit, so a failure part-way leaves every document either fully moved or
 * untouched.
 *
 * What gets committed is `documents.content` — the CLEANED text the app
 * indexed. The raw upload was never kept (rag.ts stores only the cleaned text),
 * so that is the best copy that exists.
 *
 * The document is not re-ingested. Its row is re-pointed at the repository path
 * and its hash set to the committed bytes, so chunks, embeddings, claims and
 * topic links all carry over unchanged and the next sync sees the file as
 * already indexed. Re-ingesting would cost a full clean → chunk → embed →
 * extract cycle per document and churn every claim, to arrive at the same index.
 */

import crypto from 'crypto';
import { db } from './db';
import { getRepo, readWikiFile, saveWikiFile, type WikiAuthor } from './wiki';
import { normalizeFolder, planMoves, type PlannedMove } from './repo-upload';

export interface AppOnlyUpload {
    id: number;
    filename: string;
    created_at: string;
    size: number;
}

export function listAppOnlyUploads(): AppOnlyUpload[] {
    return db.prepare(`
        SELECT id, filename, created_at, length(content) AS size
        FROM documents
        WHERE source = 'upload' AND repo_id IS NULL
        ORDER BY created_at, id
    `).all() as AppOnlyUpload[];
}

function takenIn(repoId: number) {
    return (path: string): string | null => {
        if (readWikiFile(repoId, path) !== null) return 'A file already exists at this path in the repository';
        const row = db.prepare('SELECT 1 FROM documents WHERE repo_id = ? AND lower(path) = lower(?)').get(repoId, path);
        return row ? 'A document is already indexed at this path' : null;
    };
}

export type PlanResult = { ok: true; moves: (PlannedMove & { created_at: string; size: number })[] } | { ok: false; error: string };

/** Where each app-only upload would go under `folder` of `repoId`, without changing anything. */
export function planUploadMigration(repoId: number, folder: unknown): PlanResult {
    if (!getRepo(repoId)) return { ok: false, error: 'Repository not found' };
    const dir = normalizeFolder(folder);
    if (!dir.ok) return { ok: false, error: dir.error };

    const uploads = listAppOnlyUploads();
    const byId = new Map(uploads.map(u => [u.id, u]));
    const moves = planMoves(uploads, dir.value, takenIn(repoId)).map(m => ({
        ...m,
        created_at: byId.get(m.id)!.created_at,
        size: byId.get(m.id)!.size
    }));
    return { ok: true, moves };
}

export type MoveResult =
    | { status: 'moved'; path: string }
    | { status: 'skipped'; reason: string }
    | { status: 'failed'; reason: string };

/**
 * Moves one upload. The plan is recomputed against the current repository and
 * database rather than trusted from the client: the path may have been taken by
 * a sync or another move since the admin looked.
 */
export async function moveUploadToRepo(
    docId: number,
    repoId: number,
    folder: unknown,
    author: WikiAuthor
): Promise<MoveResult> {
    const doc = db.prepare(`SELECT id, filename, content FROM documents WHERE id = ? AND source = 'upload' AND repo_id IS NULL`)
        .get(docId) as { id: number; filename: string; content: string } | undefined;
    if (!doc) return { status: 'skipped', reason: 'Not an app-only upload any more (already moved or deleted)' };

    const plan = planUploadMigration(repoId, folder);
    if (!plan.ok) return { status: 'failed', reason: plan.error };
    // Plan in the context of every pending upload so the batch-duplicate rule
    // matches what the admin was shown.
    const move = plan.moves.find(m => m.id === docId);
    if (!move) return { status: 'skipped', reason: 'Not an app-only upload any more' };
    if (move.status !== 'ready') return { status: 'skipped', reason: move.reason };

    try {
        await saveWikiFile(repoId, move.path, doc.content, author, {
            message: `[Migration] Moved uploaded document "${doc.filename}" to ${move.path}`,
            ingest: false
        });
    } catch (err) {
        return { status: 'failed', reason: `Commit/push failed: ${(err as Error)?.message ?? String(err)}` };
    }

    // The hash is of the committed bytes — exactly what git sync reads back and
    // hashes — so the next sync treats the document as unchanged.
    const contentHash = crypto.createHash('sha256').update(doc.content).digest('hex');
    const filename = move.path.split('/').pop()!;
    db.prepare(`
        UPDATE documents SET repo_id = ?, path = ?, filename = ?, source = 'git', content_hash = ?
        WHERE id = ? AND repo_id IS NULL
    `).run(repoId, move.path, filename, contentHash, docId);

    console.log(`[Migration] Moved upload #${docId} "${doc.filename}" to repo ${repoId}: ${move.path}`);
    return { status: 'moved', path: move.path };
}
