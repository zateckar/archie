import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { db, reattributeSharedClaims } from './db';
import { isIgnoredPath, CLEAN_FOLDER, LEGACY_CLEAN_FOLDER } from './wiki-ignore';
import { addDocument } from './rag';
import {
    rebuildTaxonomy,
    placeTaxonomyForNewTopics,
    isFullTaxonomyRebuildDue,
    sweepOrphanTopics
} from './knowledge';
import { recomputeCommunities } from './communities';
import { encrypt, decrypt } from './crypto-utils';
import { clearWikiTreeCache } from './wiki';

const REPOS_DIR = path.join(process.cwd(), 'data', 'repos');

if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
}

let autoSyncInterval: NodeJS.Timeout;

// Tracks repos currently being synced so the timer never starts a second
// concurrent sync for the same repo (which would also cause the "last_sync_at
// not yet updated" false-positive that triggers every-minute re-syncing).
const syncingRepos = new Set<number>();

export function initAutoSync() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    
    // Check every minute for repos that need syncing
    autoSyncInterval = setInterval(() => {
        const now = Date.now();
        const repos = db.prepare('SELECT id, sync_interval, last_sync_at FROM git_repos').all() as any[];
        
        for (const repo of repos) {
            if (syncingRepos.has(repo.id)) continue; // already in progress

            // CURRENT_TIMESTAMP in SQLite is "YYYY-MM-DD HH:MM:SS" (UTC, space-separated).
            // Parsing it with plain `new Date()` treats it as local time in V8, which
            // causes the elapsed-time check to be off by the host's UTC offset.
            // Appending 'Z' forces correct UTC interpretation.
            const lastSyncStr = repo.last_sync_at
                ? repo.last_sync_at.replace(' ', 'T') + 'Z'
                : null;
            const lastSync = lastSyncStr ? new Date(lastSyncStr).getTime() : 0;

            if (now - lastSync >= repo.sync_interval) {
                syncingRepos.add(repo.id);
                console.log(`Auto-syncing repo ${repo.id}...`);
                syncGitRepo(repo.id)
                    .catch(err => console.error(`Failed to auto-sync repo ${repo.id}:`, err))
                    .finally(() => syncingRepos.delete(repo.id));
            }
        }
    }, 60000); // Check every minute
}


export async function syncGitRepo(repoId: number) {
    // Mark sync as started immediately so the auto-sync timer doesn't
    // re-trigger this repo if the sync takes a long time or fails partway
    // through (leaving last_sync_at NULL, which would cause immediate retry).
    db.prepare('UPDATE git_repos SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?').run(repoId);

    const repo = db.prepare('SELECT * FROM git_repos WHERE id = ?').get(repoId) as { id: number; url: string; pat: string; local_path: string; last_commit: string | null };
    if (!repo) throw new Error('Repo not found');

    const dir = repo.local_path;
    const url = repo.url;
    const pat = repo.pat.startsWith('enc:') ? decrypt(repo.pat.slice(4)) : repo.pat;

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        await git.clone({
            fs,
            http,
            dir,
            url,
            onAuth: () => ({ username: 'token', password: pat }),
            singleBranch: true
        });
    } else {
        try {

        await git.pull({
            fs,
            http,
            dir,
            url,
            onAuth: () => ({ username: 'token', password: pat }),
            author: { name: 'Agent', email: 'agent@local' }
        });

        // If the repo was previously cloned with depth: 1 (shallow clone),
        // convert it to a full clone so that push can find merge bases.
        // A shallow repo is detected by the presence of .git/shallow.
        const gitDir = path.join(dir, '.git');
        const shallowFile = path.join(gitDir, 'shallow');
        if (fs.existsSync(shallowFile)) {
            console.log(`Repo ${repoId} is shallow — fetching full history to enable push...`);
            await git.fetch({
                fs,
                http,
                dir,
                url,
                onAuth: () => ({ username: 'token', password: pat }),
                singleBranch: true
            });
            // Remove the shallow marker so subsequent syncs skip this check.
            fs.rmSync(shallowFile, { force: true });
            console.log(`Repo ${repoId} converted to full clone.`);
        }

        } catch (err) {
            console.warn(`Pull failed for repo ${repoId}, attempting to re-clone:`, err);
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Re-cloning repo ${repoId} from ${url}...`);

            await git.clone({
                fs,
                http,
                dir,
                url,
                onAuth: () => ({ username: 'token', password: pat }),
                singleBranch: true
            });
            console.log(`Successfully re-cloned repo ${repoId}`);

        }
    }

    // The pull/clone above has already rewritten the working tree, so anything the
    // wiki cached about the old file layout is wrong NOW — not at the end of this
    // function. The clear used to happen only in the sync's last lines, behind the
    // taxonomy rebuild and community recompute, i.e. minutes of LLM work: rename a
    // folder to `!Clean` in the remote, sync, and the wiki went on listing the
    // pre-rename tree for the whole of that window, which looks exactly like the
    // ignore rule not working. The clear at the end stays — by then ingestion may
    // have changed things again.
    try {
        clearWikiTreeCache(repoId);
    } catch (_) {}

    let head: string;
    try {
        head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    } catch (err) {
        console.warn('Could not resolve HEAD, repo might be empty:', err);
        return;
    }

    const hasNewRemoteChanges = head !== repo.last_commit;

    // Did this sync actually change the corpus? A new HEAD is NOT the same question:
    // a commit can touch only unsupported extensions, only ignored paths, or only
    // the `!Clean` copies this sync itself pushed, and every doc hash still matches.
    // The post-sync graph work below keys off this rather than off `head`.
    let corpusChanged = false;

    if (hasNewRemoteChanges) {
        console.log('New commits found in repo', url, '- processing documents...');

        // Get all files in the repo (recursive)
        const files = await git.listFiles({ fs, dir });
        
        // Filter for supported files (e.g., .md, .txt)
        const supportedExtensions = process.env.SUPPORTED_EXTENSIONS ? process.env.SUPPORTED_EXTENSIONS.split(',') : ['.md', '.mdx'];
        // `!`-prefixed files and folders are excluded from ingestion (see
        // wiki-ignore), which now covers the cleaned-copies folder itself;
        // LEGACY_CLEAN_FOLDER stays excluded by name for repositories that still
        // hold the unprefixed folder written by earlier versions.
        //
        // Note what this means for a file that WAS ingested and is now ignored
        // (a rename to `!Clean/…`, say): it drops out of `docFiles`, so it stays
        // in `existingPaths` below and the deletion sweep removes it from the
        // corpus — which is the intended reading of "ignore", not just "stop
        // updating".
        const docFiles = files.filter(f =>
            supportedExtensions.includes(path.extname(f).toLowerCase())
            && !f.startsWith(LEGACY_CLEAN_FOLDER)
            && !isIgnoredPath(f)
        );

        // Get existing documents for this repo
        const existingDocs = db.prepare('SELECT id, path, content_hash FROM documents WHERE repo_id = ?').all(repoId) as { id: number, path: string, content_hash: string }[];
        const existingPaths = new Map(existingDocs.map(d => [d.path, d.id]));

        const failedDocs: { path: string; reason: string }[] = [];

        for (const filePath of docFiles) {
            const fullPath = path.join(dir, filePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            const filename = path.basename(filePath);

            // Retire this path from the "present in repo" bookkeeping BEFORE any
            // await. It used to happen after `await addDocumentFromGit(...)`, so an
            // ingestion failure skipped it, the path stayed in `existingPaths`, and
            // the deletion sweep below then removed a document that is still very
            // much in the repository — losing the previously-indexed copy because
            // re-indexing it failed. Presence in the repo is a fact about the file
            // list; it does not depend on whether ingestion succeeded.
            const existingDocId = existingPaths.get(filePath);
            existingPaths.delete(filePath);

            if (existingDocId !== undefined) {
                // Check if content is different using hash
                const contentHash = crypto.createHash('sha256').update(content).digest('hex');
                const currentDoc = existingDocs.find(d => d.id === existingDocId);
                if (currentDoc?.content_hash === contentHash) {
                    console.log('Document unchanged:', filePath);
                    continue;
                }
                console.log('Updating document:', filePath);
                // addDocument replaces the row and cleans up old chunks via CASCADE
            } else {
                console.log('Adding new document:', filePath);
            }

            // Contain the failure to this document. The loop previously let any
            // error propagate out of syncGitRepo, so one unreadable document — or
            // one transient provider failure inside the ingestion pipeline — aborted
            // the whole sync: every later file went unprocessed, removed files went
            // uncollected, and the taxonomy rebuild and community recompute at the
            // end of this function never ran. A per-document skip leaves the corpus
            // consistent and the failure is retried on the next sync, because the
            // stored content_hash still doesn't match the file.
            try {
                await addDocumentFromGit(repoId, filePath, filename, content, dir);
                corpusChanged = true;
            } catch (err) {
                const reason = (err as Error)?.message ?? String(err);
                failedDocs.push({ path: filePath, reason });
                console.error(`[Git Sync] Failed to ingest ${filePath}, skipping it and continuing:`, reason);
            }
        }

        // Delete documents that are no longer in the repo
        let removedDocs = 0;
        for (const [filePath, docId] of existingPaths) {
            console.log('Deleting removed document:', filePath);
            // Facts still asserted by files that remain in the repo are handed
            // over before the cascade takes them (see reattributeSharedClaims).
            reattributeSharedClaims(docId);
            db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
            removedDocs++;
        }
        // Cascade cleans the removed documents' chunks, claims and topic links,
        // but not the topics or graph edges they were the only support for.
        if (removedDocs > 0) {
            sweepOrphanTopics();
            corpusChanged = true;
        }

        if (failedDocs.length > 0) {
            console.warn(
                `[Git Sync] ${failedDocs.length} of ${docFiles.length} document(s) failed to ingest and were left ` +
                `at their previous state: ${failedDocs.map(f => `${f.path} (${f.reason})`).join('; ')}`
            );
        }
    } else {
        console.log('No new remote changes in repo', url, `- checking for previously staged ${CLEAN_FOLDER} files...`);
    }

    // Commit and push all cleaned documents in one batch
    try {
        // Get the current branch name to push to the correct remote ref
        let currentBranch = 'main';
        try {
            currentBranch = await git.currentBranch({ fs, dir }) || 'main';
        } catch (e) {
            // Fallback to 'main' if branch detection fails
        }

        // Use statusMatrix to check for any staged or modified files including the
        // cleaned-copies directory
        const statusMatrix = await git.statusMatrix({ fs, dir });

        // Check whether the cleaned-copies directory has files that need
        // committing. Both names are watched: new copies land in CLEAN_FOLDER,
        // while a repo upgraded mid-flight can still have copies staged under the
        // legacy folder that would otherwise never get committed.
        const cleanFilesStaged = statusMatrix.some(([filepath, , workdirStatus, stageStatus]) => {
            // stageStatus === 2 means the file is staged (added by git.add)
            return (filepath.startsWith(CLEAN_FOLDER) || filepath.startsWith(LEGACY_CLEAN_FOLDER))
                && (stageStatus === 2 || stageStatus === 3);
        });

        // Also check for any other staged changes
        const anyStaged = statusMatrix.some(([, , workdirStatus, stageStatus]) => {
            return stageStatus === 2 || stageStatus === 3;
        });

        if (cleanFilesStaged || anyStaged) {
            console.log(`[SaveCleaned] Found ${statusMatrix.filter(([fp,,,st]) => st === 2 || st === 3).length} staged files. Committing...`);
            
            await git.commit({
                fs,
                dir,
                message: `[Auto] Cleaned versions of synced documents`,
                author: { name: 'Archie Bot', email: 'archie@local' }
            });
            
            // Push explicitly with url and ref for reliable behavior (avoids needing .git/config remote entry)
            const pushResult = await git.push({
                fs,
                http,
                dir,
                url,
                ref: currentBranch,
                onAuth: () => ({ username: 'token', password: pat }),
                onProgress: (progress) => {
                    if (progress.phase === 'receiving') {
                        console.log(`[SaveCleaned] Push progress: ${progress.loaded}/${progress.total}`);
                    }
                }
            });
            
            if (pushResult && pushResult.ok) {
                console.log(`[SaveCleaned] Successfully pushed cleaned documents to repo ${repoId} on branch ${currentBranch}`);
            } else {
                console.warn(`[SaveCleaned] Push returned unexpected result:`, pushResult);
            }
        } else {
            console.log('[SaveCleaned] No changes to commit — no new or updated cleaned documents found.');
        }
    } catch (err) {
        console.error(`[SaveCleaned] Failed to commit/push cleaned documents:`, err);
    }

    // Update last commit and last sync time
    db.prepare('UPDATE git_repos SET last_commit = ?, last_sync_at = CURRENT_TIMESTAMP WHERE id = ?').run(head, repoId);

    // Taxonomy: only when this sync changed something, and incrementally.
    //
    // Both halves of that were previously wrong, and together they were the single
    // largest source of token spend in the app. The rebuild sat outside the
    // `hasNewRemoteChanges` branch, so an idle repo on the default one-hour
    // sync_interval paid for 24 full rebuilds a day to reproduce the hierarchy it
    // already had. And the full rebuild is the expensive shape by construction: it
    // re-sends EVERY topic to the model in batches of 40 (see deriveTaxonomyFull,
    // whose per-batch prior-roots context grows as it goes), then clears and
    // rewrites every parent_topic_id — while new topics have already been placed
    // per-document during ingestion (see processDocumentKnowledge), leaving the
    // holistic pass almost nothing to decide.
    //
    // What genuinely remains for the sync tail is the case per-document placement
    // cannot cover: sweepOrphanTopics() deletes topics and `parent_topic_id` is
    // ON DELETE SET NULL, so removing a parent orphans its children after the last
    // document was ingested. Incremental placement targets exactly those rows and
    // makes no model call at all when there are none.
    //
    // The full rebuild is not dead. It still runs on three paths: a corpus with no
    // hierarchy to place into (first import), which placeTaxonomyForNewTopics now
    // reports back instead of silently returning 0; the periodic schedule below,
    // which bounds the drift incremental placement accumulates; and on demand via
    // POST /api/knowledge {action:'rebuild-taxonomy'}.
    //
    // Note the schedule is consulted BEFORE placement, not after: a sync that is
    // about to re-derive every parent gains nothing from first paying the model to
    // place orphans it is going to overwrite seconds later.
    //
    // Both the schedule and the placement pass hang off `corpusChanged`, so an
    // idle repo stays at zero model calls no matter how overdue the rebuild is.
    // That is the intended reading of the schedule: it exists to correct drift
    // caused by incremental placements, and a corpus that has not changed since
    // the last rebuild has not drifted.
    if (!corpusChanged) {
        console.log(`[Git Sync] Repo ${repoId}: no document changes — skipping taxonomy pass.`);
    } else {
        try {
            const scheduled = isFullTaxonomyRebuildDue();
            const placement = scheduled ? null : await placeTaxonomyForNewTopics();

            if (scheduled || placement?.status === 'needs-full-rebuild') {
                console.log(
                    `[Git Sync] Running full taxonomy rebuild for repo ${repoId} ` +
                    `(${scheduled ? 'periodic schedule due' : 'no existing hierarchy to place into'})...`
                );
                const result = await rebuildTaxonomy();
                console.log(`[Git Sync] Taxonomy rebuilt: ${result.updated}/${result.total} topics assigned parents.`);
            } else {
                console.log(
                    `[Git Sync] Taxonomy: placed ${placement!.placed}/${placement!.orphans} ` +
                    `orphan topic(s) after sync of repo ${repoId}.`
                );
            }
        } catch (err) {
            console.error('[Git Sync] Taxonomy pass failed:', err);
        }
    }

    // ...then the community partition and its reports, once, over the final
    // state. Per-file ingestion passed `batch: true` and so left reports
    // untouched; without this call the corpus would carry reports describing a
    // partition from before the sync.
    console.log(`[Git Sync] Recomputing communities and reports after sync of repo ${repoId}...`);
    try {
        const result = await recomputeCommunities();
        console.log(
            `[Git Sync] Communities: ${result.communityCount}, ` +
            `reports ${result.reports.generated} generated / ${result.reports.reused} reused` +
            (result.reports.deferred > 0 ? ` (${result.reports.deferred} deferred)` : '')
        );
    } catch (err) {
        console.error('[Git Sync] Community recompute failed:', err);
    }

    // Invalidate the wiki tree cache after sync
    try {
        clearWikiTreeCache(repoId);
    } catch (_) {}
}

async function addDocumentFromGit(repoId: number, filePath: string, filename: string, content: string, repoDir: string) {
    // batch: one file of a sync — suppresses per-file community report generation.
    // The sync tail runs a single unsuppressed recomputeCommunities() instead.
    const { cleanedContent } = await addDocument(filename, content, { repoId, path: filePath, batch: true });

    // Save the cleaned & restructured version to the cleaned-copies folder in the
    // local repo clone (see CLEAN_FOLDER — "!" prefixed, so it is invisible to the
    // wiki and never re-ingested).
    try {
        const cleanRelPath = CLEAN_FOLDER + filePath;
        const cleanFullPath = path.join(repoDir, cleanRelPath);
        const cleanDir = path.dirname(cleanFullPath);
        if (!fs.existsSync(cleanDir)) {
            fs.mkdirSync(cleanDir, { recursive: true });
        }
        fs.writeFileSync(cleanFullPath, cleanedContent, 'utf8');
        await git.add({ fs, dir: repoDir, filepath: cleanRelPath });
        console.log(`[SaveCleaned] Staged cleaned version: ${cleanRelPath}`);
    } catch (err) {
        console.error(`[SaveCleaned] Failed to save cleaned document ${filePath}:`, err);
    }
}

export async function registerRepo(url: string, pat: string, syncInterval: number = 3600000) {
    const repoName = url.split('/').pop() || 'repo';
    const localPath = path.join(REPOS_DIR, `${repoName}_${Date.now()}`);
    const encryptedPat = pat ? `enc:${encrypt(pat)}` : '';
    
    const result = db.prepare('INSERT INTO git_repos (url, pat, local_path, sync_interval) VALUES (?, ?, ?, ?)').run(url, encryptedPat, localPath, syncInterval);
    return result.lastInsertRowid;
}
