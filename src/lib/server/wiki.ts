import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { db } from './db';
import { decrypt } from './crypto-utils';
import { diffLines } from 'diff';
import { addDocument } from './rag';

export interface FileTreeItem {
    name: string;
    path: string;
    type: 'file' | 'dir';
    children?: FileTreeItem[];
}

export interface FileHistoryItem {
    oid: string;
    message: string;
    author: string;
    date: string;
}

/**
 * Resolves `filePath` inside `repoRoot` and returns the absolute path, or null if
 * it escapes the repository.
 *
 * The containment checks this replaces were written as
 * `resolvedPath.startsWith(repoDir)`, which is a *character* prefix test: a repo
 * at `…/repos/wiki` also accepts `…/repos/wiki-secret/x.md`, because the latter
 * genuinely starts with the former. Comparing against `repoDir + path.sep` (or an
 * exact match) is what actually confines the path to the directory.
 *
 * Backslashes are normalised first so a Windows-style separator in an
 * API-supplied path can't sidestep the POSIX-style handling elsewhere in this
 * module.
 */
export function resolveRepoPath(repoRoot: string, filePath: string): string | null {
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    // NUL bytes truncate paths in some syscalls; reject rather than normalise.
    if (filePath.includes('\0')) return null;

    const normalized = filePath.replace(/\\/g, '/');
    const repoDir = path.resolve(repoRoot);
    // `path.resolve(repoDir, normalized)` rather than resolving a `path.join`:
    // resolve honours an absolute second argument, so an absolute input escapes to
    // itself and is then rejected by the containment check below. `join` would
    // instead glue it onto the repo root ("/etc/passwd" landing at
    // "<repo>/etc/passwd"), quietly serving a different file than was asked for,
    // and on Windows a drive-qualified input concatenates into a malformed path.
    // Rejecting is the honest outcome; every caller supplies a repo-relative path.
    const resolved = path.resolve(repoDir, normalized);

    if (resolved !== repoDir && !resolved.startsWith(repoDir + path.sep)) return null;
    return resolved;
}

export function listWikiRepos() {
    return db.prepare('SELECT id, url, local_path, last_commit FROM git_repos').all() as { id: number; url: string; local_path: string; last_commit: string | null }[];
}

export function getRepo(repoId: number) {
    return db.prepare('SELECT * FROM git_repos WHERE id = ?').get(repoId) as { id: number; url: string; pat: string; local_path: string; last_commit: string | null } | undefined;
}

const treeCache = new Map<number, FileTreeItem[]>();

export function clearWikiTreeCache(repoId?: number) {
    if (repoId !== undefined) {
        treeCache.delete(repoId);
    } else {
        treeCache.clear();
    }
}

export function getFileTree(repoId: number): FileTreeItem[] {
    const cached = treeCache.get(repoId);
    if (cached) {
        return cached;
    }
    const repo = getRepo(repoId);
    if (!repo) return [];

    const dir = repo.local_path;
    if (!fs.existsSync(dir)) return [];

    const items: FileTreeItem[] = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

            if (entry.isDirectory()) {
                const children = getDirTree(path.join(dir, entry.name), entry.name);
                // Only include directories that contain at least one .md file (directly or recursively)
                if (children.length > 0) {
                    items.push({
                        name: entry.name,
                        path: entry.name,
                        type: 'dir',
                        children
                    });
                }
            } else if (entry.name.endsWith('.md')) {
                items.push({
                    name: entry.name,
                    path: entry.name,
                    type: 'file'
                });
            }
        }
    } catch (err) {
        console.error(`Failed to read file tree for repo ${repoId}:`, err);
    }

    items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    treeCache.set(repoId, items);
    return items;
}

function getDirTree(dirPath: string, relativePath: string): FileTreeItem[] {
    const items: FileTreeItem[] = [];

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;

            const fullPath = path.join(dirPath, entry.name);
            const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                const children = getDirTree(fullPath, relPath);
                // Only include directories that have at least one .md file (directly or recursively)
                if (children.length > 0) {
                    items.push({
                        name: entry.name,
                        path: relPath,
                        type: 'dir',
                        children
                    });
                }
            } else if (entry.name.endsWith('.md')) {
                items.push({
                    name: entry.name,
                    path: relPath,
                    type: 'file'
                });
            }
        }
    } catch (err) {
        // Permission denied or other error - skip this directory
    }

    items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return items;
}

export function readWikiFile(repoId: number, filePath: string): string | null {
    const repo = getRepo(repoId);
    if (!repo) return null;

    const resolvedPath = resolveRepoPath(repo.local_path, filePath);
    if (!resolvedPath) return null;

    if (!fs.existsSync(resolvedPath)) return null;

    return fs.readFileSync(resolvedPath, 'utf8');
}

export async function readWikiFileAtCommit(repoId: number, filePath: string, oid: string): Promise<string | null> {
    const repo = getRepo(repoId);
    if (!repo) return null;

    try {
        const readResult = await git.readBlob({
            fs,
            dir: repo.local_path,
            oid,
            filepath: filePath
        });
        return new TextDecoder().decode(readResult.blob);
    } catch (err) {
        console.error(`Failed to read file at commit ${oid}:`, err);
        return null;
    }
}

/**
 * Copies a directory tree from src to dest, skipping files that already exist at dest.
 */
function copyDirSync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(s, d);
        } else if (!fs.existsSync(d)) {
            fs.copyFileSync(s, d);
        }
    }
}

/**
 * Repairs a broken .git directory by restoring HEAD, config, refs and pack objects
 * from the sibling .git_disabled folder (left over when a fresh git was initialised
 * without a proper clone).  Also removes misplaced top-level branch-ref files
 * (e.g. .git/main) so that isomorphic-git finds refs under refs/heads/ only.
 */
function repairGitIfNeeded(dir: string): void {
    const gitDir = path.join(dir, '.git');
    const disabledGitDir = path.join(dir, '.git_disabled');

    const headFile = path.join(gitDir, 'HEAD');
    const configFile = path.join(gitDir, 'config');
    const needsRepair = !fs.existsSync(headFile) || !fs.existsSync(configFile);
    if (!needsRepair) return;

    if (fs.existsSync(disabledGitDir)) {
        console.log('[Wiki] Repairing broken .git from .git_disabled...');

        // Restore HEAD
        const headSrc = path.join(disabledGitDir, 'HEAD');
        if (!fs.existsSync(headFile) && fs.existsSync(headSrc)) {
            fs.copyFileSync(headSrc, headFile);
        }

        // Restore config
        const configSrc = path.join(disabledGitDir, 'config');
        if (!fs.existsSync(configFile) && fs.existsSync(configSrc)) {
            fs.copyFileSync(configSrc, configFile);
        }

        // Restore refs (heads, remotes, tags)
        const refsSrc = path.join(disabledGitDir, 'refs');
        if (fs.existsSync(refsSrc)) {
            copyDirSync(refsSrc, path.join(gitDir, 'refs'));
        }

        // Restore pack files (full object history from the original clone)
        const packSrc = path.join(disabledGitDir, 'objects', 'pack');
        if (fs.existsSync(packSrc)) {
            const packDest = path.join(gitDir, 'objects', 'pack');
            if (!fs.existsSync(packDest)) fs.mkdirSync(packDest, { recursive: true });
            for (const file of fs.readdirSync(packSrc)) {
                const destFile = path.join(packDest, file);
                if (!fs.existsSync(destFile)) fs.copyFileSync(path.join(packSrc, file), destFile);
            }
        }

        console.log('[Wiki] .git repaired from .git_disabled');
    } else {
        // No .git_disabled available — create a minimal valid structure
        if (!fs.existsSync(headFile)) {
            fs.writeFileSync(headFile, 'ref: refs/heads/main\n', 'utf8');
        }
        const refsHeadsDir = path.join(gitDir, 'refs', 'heads');
        if (!fs.existsSync(refsHeadsDir)) fs.mkdirSync(refsHeadsDir, { recursive: true });
    }

    // Remove any misplaced top-level branch-ref files (e.g. .git/main, .git/master).
    // They are orphan commits that are not connected to the remote history;
    // refs/heads/* (restored above) are the authoritative refs going forward.
    for (const branchName of ['main', 'master', 'develop', 'HEAD']) {
        if (branchName === 'HEAD') continue; // keep HEAD
        const wrongRef = path.join(gitDir, branchName);
        if (fs.existsSync(wrongRef)) {
            try { fs.rmSync(wrongRef); } catch (_) {}
        }
    }
}

/**
 * Recursively build a new git tree that changes exactly one file.
 * The base tree is preserved for all other entries.
 */
async function buildModifiedTree(
    dir: string,
    treeOid: string | null,
    parts: string[],
    blobOid: string
): Promise<string> {
    const entries: Array<{ mode: string; path: string; oid: string; type: 'blob' | 'tree' | 'commit' }> = treeOid
        ? (await git.readTree({ fs, dir, oid: treeOid })).tree.map(e => ({ ...e, type: e.type as 'blob' | 'tree' | 'commit' }))
        : [];

    const name = parts[0];

    if (parts.length === 1) {
        // Leaf — insert or replace the file entry
        const idx = entries.findIndex(e => e.path === name);
        const entry = { mode: '100644', path: name, oid: blobOid, type: 'blob' as const };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
    } else {
        // Non-leaf — descend into a subdirectory
        const existing = entries.find(e => e.path === name && e.type === 'tree');
        const subTreeOid = await buildModifiedTree(dir, existing?.oid ?? null, parts.slice(1), blobOid);
        const idx = entries.findIndex(e => e.path === name);
        const entry = { mode: '040000', path: name, oid: subTreeOid, type: 'tree' as const };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
    }

    return git.writeTree({ fs, dir, tree: entries });
}

/**
 * Recursively count non-hidden `.md` files in the working tree on disk.
 * Skips dot-directories and node_modules to mirror the tree view.
 */
function countDiskMdFiles(dir: string): number {
    let count = 0;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
            count += countDiskMdFiles(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.md')) {
            count++;
        }
    }
    return count;
}

/**
 * Recursively count `.md` blobs in a git tree object.
 */
async function countTreeMdFiles(dir: string, treeOid: string): Promise<number> {
    let count = 0;
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });
    for (const entry of tree) {
        if (entry.type === 'tree') {
            count += await countTreeMdFiles(dir, entry.oid);
        } else if (entry.type === 'blob' && entry.path.endsWith('.md')) {
            count++;
        }
    }
    return count;
}

/**
 * Core wiki push operation.
 *
 * 1. Fetches the current remote state.
 * 2. Determines the best "base tree":
 *    - If the parent tree looks intact (has roughly as many .md files as disk,
 *      counted recursively in comparable units), use it.
 *    - If the parent tree looks corrupt/incomplete, fall back to the last known
 *      good tree stored in .git_disabled (the original clone snapshot).
 * 3. Applies the change to ONLY the target file within that tree (no index used).
 * 4. Writes a new commit + updates the local ref + pushes.
 *
 * This never touches other files regardless of local index state.
 */
async function fetchModifyCommitPush(
    dir: string,
    repoUrl: string,
    pat: string,
    currentBranch: string,
    filePath: string,
    content: string,
    message: string
): Promise<void> {
    const onAuth = () => ({ username: 'token', password: pat });
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const fullRef = `refs/heads/${currentBranch}`;

    // 1. Fetch to update the remote-tracking ref
    try {
        await git.fetch({ fs, http, dir, url: repoUrl, onAuth, tags: false, singleBranch: true });
    } catch (fetchErr) {
        console.warn('[Wiki] Fetch failed, will try push anyway:', fetchErr);
    }

    // 2. Resolve the current tip to build on.
    //
    // IMPORTANT: isomorphic-git's `git.push` does NOT advance the local
    // remote-tracking ref (refs/remotes/origin/<branch>) after a successful
    // push. If we always trusted the tracking ref we would keep building every
    // new commit on top of the ORIGINAL clone commit, producing a
    // non-fast-forward push (rejected) and committing stale content. To stay
    // correct we take the most-advanced of the remote-tracking ref and the
    // local branch ref (the latter reflects our own previous pushes).
    const remoteTrackingRef = `refs/remotes/origin/${currentBranch}`;
    let trackingOid: string | null = null;
    let localOid: string | null = null;
    try { trackingOid = await git.resolveRef({ fs, dir, ref: remoteTrackingRef }); } catch { /* no tracking ref yet */ }
    try { localOid = await git.resolveRef({ fs, dir, ref: fullRef }); } catch { /* no local ref yet */ }

    // Pick whichever ref is more advanced:
    //  - If local is a descendant of tracking, local is ahead (our own pushes) -> use local.
    //  - If tracking is a descendant of local, the remote moved ahead (a fresh
    //    fetch pulled in someone else's commits) -> use tracking.
    //  - If they diverge or share no history, prefer local (contains our edits).
    let parentOid: string;
    if (trackingOid && localOid && trackingOid !== localOid) {
        let localIsAhead = false;
        let trackingIsAhead = false;
        try { localIsAhead = await git.isDescendent({ fs, dir, oid: localOid, ancestor: trackingOid }); } catch { /* unrelated */ }
        try { trackingIsAhead = await git.isDescendent({ fs, dir, oid: trackingOid, ancestor: localOid }); } catch { /* unrelated */ }
        parentOid = trackingIsAhead && !localIsAhead ? trackingOid : localOid;
    } else {
        parentOid = (localOid ?? trackingOid) as string;
    }
    if (!parentOid) {
        throw new Error('[Wiki] Could not resolve a branch tip to commit onto');
    }

    // 3. Determine the best base tree (from the parent commit chosen above)
    let baseTreeOid: string;
    try {
        const { commit: parentCommit } = await git.readCommit({ fs, dir, oid: parentOid });
        // Sanity-check the parent tree against disk using comparable units:
        // count .md files RECURSIVELY on disk and RECURSIVELY in the tree.
        const diskMdCount = countDiskMdFiles(dir);
        const treeMdCount = await countTreeMdFiles(dir, parentCommit.tree);
        const remoteTreeLooksGood = treeMdCount >= Math.max(1, diskMdCount / 2);

        if (remoteTreeLooksGood) {
            baseTreeOid = parentCommit.tree;
        } else {
            // Remote tree appears incomplete (e.g. after a bad push).
            // Fall back to the original clone's tree stored in .git_disabled.
            console.warn(`[Wiki] Parent tree has ${treeMdCount} .md files vs ${diskMdCount} on disk — restoring from .git_disabled snapshot`);
            const disabledRef = path.join(dir, '.git_disabled', 'refs', 'heads', currentBranch);
            if (fs.existsSync(disabledRef)) {
                const origOid = fs.readFileSync(disabledRef, 'utf8').trim();
                const { commit: origCommit } = await git.readCommit({ fs, dir, oid: origOid });
                baseTreeOid = origCommit.tree;
            } else {
                baseTreeOid = parentCommit.tree; // best we can do
            }
        }
    } catch (err) {
        throw new Error(`[Wiki] Could not read parent commit tree: ${err}`);
    }

    // 4. Write blob for new content
    const blobOid = await git.writeBlob({ fs, dir, blob: Buffer.from(content, 'utf8') });

    // 5. Build modified tree (ONLY the target file changes)
    const newTreeOid = await buildModifiedTree(dir, baseTreeOid, normalizedFilePath.split('/'), blobOid);

    // 6. Write commit object (index is NOT used — we build the tree directly)
    const now = Math.floor(Date.now() / 1000);
    const tz = new Date().getTimezoneOffset();
    const author = { name: 'Wiki Editor', email: 'wiki@local', timestamp: now, timezoneOffset: tz };
    const newCommitOid = await git.writeCommit({
        fs,
        dir,
        commit: {
            tree: newTreeOid,
            parent: [parentOid],
            author,
            committer: author,
            message: message.endsWith('\n') ? message : message + '\n',
        },
    });

    // 7. Update local branch ref
    await git.writeRef({ fs, dir, ref: fullRef, value: newCommitOid, force: true });

    // 8. Push
    try {
        const pushResult = await git.push({ fs, http, dir, url: repoUrl, ref: fullRef, onAuth, onProgress: () => {} });
        if (pushResult && pushResult.ok) {
            console.log(`[Wiki] Pushed ${normalizedFilePath} successfully`);
            // isomorphic-git does NOT advance the remote-tracking ref after a
            // push. Do it manually so the NEXT save builds on this commit
            // instead of the stale original clone tip (which caused
            // non-fast-forward pushes and reverted edits).
            try {
                await git.writeRef({ fs, dir, ref: remoteTrackingRef, value: newCommitOid, force: true });
            } catch (trackErr) {
                console.warn('[Wiki] Failed to update remote-tracking ref after push:', trackErr);
            }
        } else {
            const errMsg = pushResult?.error || 'Unknown push error';
            console.warn(`[Wiki] Push returned error: ${errMsg}`);
            // Roll back the local branch ref back to its pre-commit tip (parentOid)
            await git.writeRef({ fs, dir, ref: fullRef, value: parentOid, force: true });
            throw new Error(`[Wiki] Push failed: ${errMsg}`);
        }
    } catch (pushErr) {
        console.warn(`[Wiki] Push threw error: ${pushErr}`);
        // Roll back the local branch ref back to its pre-commit tip (parentOid)
        try {
            await git.writeRef({ fs, dir, ref: fullRef, value: parentOid, force: true });
        } catch (rollbackErr) {
            console.error('[Wiki] Failed to roll back local ref:', rollbackErr);
        }
        throw pushErr;
    }
}

export async function saveWikiFile(repoId: number, filePath: string, content: string): Promise<void> {
    const repo = getRepo(repoId);
    if (!repo) throw new Error('Repo not found');

    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const resolvedPath = resolveRepoPath(repo.local_path, normalizedFilePath);
    if (!resolvedPath) throw new Error('Invalid path');

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Cache the previous content of the file (or null if new) to roll back on failure
    let previousContent: string | null = null;
    try {
        if (fs.existsSync(resolvedPath)) {
            previousContent = fs.readFileSync(resolvedPath, 'utf8');
        }
    } catch (_) {}

    // Write the file to disk first
    fs.writeFileSync(resolvedPath, content, 'utf8');

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const pat = repo.pat.startsWith('enc:') ? decrypt(repo.pat.slice(4)) : repo.pat;

    try {
        // Ensure the .git structure is valid before any git operation
        repairGitIfNeeded(repo.local_path);

        // Stage the file in the index so HEAD and index remain in sync
        try {
            await git.add({ fs, dir: repo.local_path, filepath: normalizedFilePath });
        } catch (addErr) {
            console.warn('[Wiki] Failed to stage file in index:', addErr);
        }

        // Detect current branch (HEAD must exist after repair)
        let currentBranch = 'main';
        try {
            const branch = await git.currentBranch({ fs, dir: repo.local_path });
            if (branch) currentBranch = branch;
        } catch (_) {}

        // Push only the changed file — never touches other files
        await fetchModifyCommitPush(
            repo.local_path, repo.url, pat, currentBranch,
            normalizedFilePath, content,
            `[Wiki] Updated ${normalizedFilePath}`
        );
    } catch (err) {
        console.warn('[Wiki] Push failed (remote may not be reachable):', err);
        // Roll back the disk file and index to its previous content or delete it if it was a new file
        try {
            if (previousContent !== null) {
                fs.writeFileSync(resolvedPath, previousContent, 'utf8');
                await git.add({ fs, dir: repo.local_path, filepath: normalizedFilePath });
            } else {
                if (fs.existsSync(resolvedPath)) {
                    fs.unlinkSync(resolvedPath);
                }
                await git.remove({ fs, dir: repo.local_path, filepath: normalizedFilePath });
            }
        } catch (rollbackErr) {
            console.error('[Wiki] Failed to roll back file content and index:', rollbackErr);
        }
        throw err;
    }

    // Update last commit reference in DB
    try {
        const head = await git.resolveRef({ fs, dir: repo.local_path, ref: 'HEAD' });
        db.prepare('UPDATE git_repos SET last_commit = ? WHERE id = ?').run(head, repoId);
    } catch (_) {}

    // Upsert into wiki_documents table
    db.prepare(`
        INSERT INTO wiki_documents (repo_id, path, filename, content, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(repo_id, path) DO UPDATE SET
            content = excluded.content,
            content_hash = excluded.content_hash,
            updated_at = CURRENT_TIMESTAMP
    `).run(repoId, normalizedFilePath, path.basename(normalizedFilePath), content, contentHash);

    // Invalidate memory tree cache
    clearWikiTreeCache(repoId);

    // Asynchronously call addDocument to ingest the new/updated file content into the RAG database.
    // Also stage the cleaned file version generated by addDocument in the 'Clean/' folder.
    addDocument(path.basename(normalizedFilePath), content, { repoId, path: normalizedFilePath })
        .then(({ cleanedContent }) => {
            try {
                const cleanRelPath = 'Clean/' + normalizedFilePath;
                const cleanFullPath = path.join(repo.local_path, cleanRelPath);
                const cleanDir = path.dirname(cleanFullPath);
                if (!fs.existsSync(cleanDir)) {
                    fs.mkdirSync(cleanDir, { recursive: true });
                }
                fs.writeFileSync(cleanFullPath, cleanedContent, 'utf8');
                git.add({ fs, dir: repo.local_path, filepath: cleanRelPath })
                    .catch(e => console.warn('[Wiki] Failed to stage cleaned file:', e));
            } catch (err) {
                console.warn('[Wiki] Failed to save cleaned file locally:', err);
            }
        })
        .catch(err => {
            console.warn('[Wiki] RAG ingestion failed for saved file:', err);
        });
}

export async function createWikiFile(repoId: number, filePath: string, content: string): Promise<void> {
    // saveWikiFile handles path validation, parent-directory creation, the disk
    // write, staging, commit/push, DB upsert and RAG ingestion — so creating a
    // file is just a save of new content. (Avoids a redundant, unvalidated
    // pre-write and a duplicate commit.)
    await saveWikiFile(repoId, filePath, content);
}

export async function getFileHistory(repoId: number, filePath: string, maxCount: number = 50): Promise<FileHistoryItem[]> {
    const repo = getRepo(repoId);
    if (!repo) return [];

    // Check if HEAD exists before trying to get history
    try {
        await git.resolveRef({ fs, dir: repo.local_path, ref: 'HEAD' });
    } catch (e) {
        // No HEAD — no commits yet
        return [];
    }

    try {
        const commits = await git.log({
            fs,
            dir: repo.local_path,
            filepath: filePath,
            ref: 'HEAD',
            depth: maxCount
        });

        return commits.map(c => ({
            oid: c.oid,
            message: c.commit.message,
            author: c.commit.author.name,
            date: new Date((c.commit.author.timestamp || 0) * 1000).toISOString()
        }));
    } catch (err) {
        console.error(`Failed to get history for ${filePath}:`, err);
        return [];
    }
}

export async function revertToCommit(repoId: number, filePath: string, oid: string): Promise<void> {
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const oldContent = await readWikiFileAtCommit(repoId, normalizedFilePath, oid);
    if (oldContent === null) throw new Error('Could not read file at specified commit');

    const repo = getRepo(repoId);
    if (!repo) throw new Error('Repo not found');

    // Containment check. readWikiFile and saveWikiFile both had one; this function
    // did not, so `POST /api/wiki/[repoId]/revert` took a caller-supplied path
    // straight to `fs.writeFileSync` and any contributor could write outside the
    // repository. The path is confined the same way as every other write here.
    const fullPath = resolveRepoPath(repo.local_path, normalizedFilePath);
    if (!fullPath) throw new Error('Invalid path');

    // Cache the previous content of the file (or null if new) to roll back on failure
    let previousContent: string | null = null;
    try {
        if (fs.existsSync(fullPath)) {
            previousContent = fs.readFileSync(fullPath, 'utf8');
        }
    } catch (_) {}

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, oldContent, 'utf8');

    const pat = repo.pat.startsWith('enc:') ? decrypt(repo.pat.slice(4)) : repo.pat;

    try {
        repairGitIfNeeded(repo.local_path);

        // Stage the file in the index so HEAD and index remain in sync
        try {
            await git.add({ fs, dir: repo.local_path, filepath: normalizedFilePath });
        } catch (addErr) {
            console.warn('[Wiki] Failed to stage file in index on revert:', addErr);
        }

        let currentBranch = 'main';
        try {
            const branch = await git.currentBranch({ fs, dir: repo.local_path });
            if (branch) currentBranch = branch;
        } catch (_) {}

        await fetchModifyCommitPush(
            repo.local_path, repo.url, pat, currentBranch,
            normalizedFilePath, oldContent,
            `[Wiki] Reverted ${normalizedFilePath} to ${oid.slice(0, 7)}`
        );
    } catch (err) {
        console.warn('[Wiki] Revert push failed:', err);
        // Roll back the disk file and index to its pre-revert content or delete if it didn't exist
        try {
            if (previousContent !== null) {
                fs.writeFileSync(fullPath, previousContent, 'utf8');
                await git.add({ fs, dir: repo.local_path, filepath: normalizedFilePath });
            } else {
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                }
                await git.remove({ fs, dir: repo.local_path, filepath: normalizedFilePath });
            }
        } catch (rollbackErr) {
            console.error('[Wiki] Failed to roll back file and index content on revert:', rollbackErr);
        }
        throw err;
    }

    // Update last commit reference in DB
    try {
        const head = await git.resolveRef({ fs, dir: repo.local_path, ref: 'HEAD' });
        db.prepare('UPDATE git_repos SET last_commit = ? WHERE id = ?').run(head, repoId);
    } catch (_) {}

    const contentHash = crypto.createHash('sha256').update(oldContent).digest('hex');
    // Upsert into wiki_documents table
    db.prepare(`
        INSERT INTO wiki_documents (repo_id, path, filename, content, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(repo_id, path) DO UPDATE SET
            content = excluded.content,
            content_hash = excluded.content_hash,
            updated_at = CURRENT_TIMESTAMP
    `).run(repoId, normalizedFilePath, path.basename(normalizedFilePath), oldContent, contentHash);

    // Invalidate memory tree cache
    clearWikiTreeCache(repoId);

    // Asynchronously call addDocument to ingest the reverted content into the RAG database,
    // and stage the cleaned file version in the 'Clean/' folder.
    addDocument(path.basename(normalizedFilePath), oldContent, { repoId, path: normalizedFilePath })
        .then(({ cleanedContent }) => {
            try {
                const cleanRelPath = 'Clean/' + normalizedFilePath;
                const cleanFullPath = path.join(repo.local_path, cleanRelPath);
                const cleanDir = path.dirname(cleanFullPath);
                if (!fs.existsSync(cleanDir)) {
                    fs.mkdirSync(cleanDir, { recursive: true });
                }
                fs.writeFileSync(cleanFullPath, cleanedContent, 'utf8');
                git.add({ fs, dir: repo.local_path, filepath: cleanRelPath })
                    .catch(e => console.warn('[Wiki] Failed to stage cleaned file:', e));
            } catch (err) {
                console.warn('[Wiki] Failed to save cleaned file locally:', err);
            }
        })
        .catch(err => {
            console.warn('[Wiki] RAG ingestion failed for reverted file:', err);
        });
}

export function getDiff(oldContent: string, newContent: string): string {
    const changes = diffLines(oldContent || '', newContent || '');
    let result = '';
    for (const change of changes) {
        const prefix = change.added ? '+' : change.removed ? '-' : ' ';
        for (const line of change.value.split('\n')) {
            if (line === '') continue;
            result += `${prefix} ${line}\n`;
        }
    }
    return result;
}

export function getDefaultFile(repoId: number): string | null {
    const readme = readWikiFile(repoId, 'README.md');
    if (readme !== null) return 'README.md';

    const index = readWikiFile(repoId, 'index.md');
    if (index !== null) return 'index.md';

    const home = readWikiFile(repoId, 'Home.md');
    if (home !== null) return 'Home.md';

    return null;
}