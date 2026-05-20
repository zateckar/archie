import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { db } from './db';
import { decrypt } from './crypto-utils';
import { diffLines } from 'diff';

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

export function listWikiRepos() {
    return db.prepare('SELECT id, url, local_path, last_commit FROM git_repos').all() as { id: number; url: string; local_path: string; last_commit: string | null }[];
}

export function getRepo(repoId: number) {
    return db.prepare('SELECT * FROM git_repos WHERE id = ?').get(repoId) as { id: number; url: string; pat: string; local_path: string; last_commit: string | null } | undefined;
}

const treeCache = new Map<any[], any[]>();

export function clearWikiTreeCache(repoId?: number) {
    if (repoId !== undefined) {
        treeCache.delete(repoId as any);
    } else {
        treeCache.clear();
    }
}

export function getFileTree(repoId: number): FileTreeItem[] {
    if (treeCache.has(repoId as any)) {
        return treeCache.get(repoId as any) as FileTreeItem[];
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

    treeCache.set(repoId as any, items as any);
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

    const fullPath = path.join(repo.local_path, filePath);
    const resolvedPath = path.resolve(fullPath);
    const repoDir = path.resolve(repo.local_path);
    if (!resolvedPath.startsWith(repoDir)) return null;

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
 * Core wiki push operation.
 *
 * 1. Fetches the current remote state.
 * 2. Determines the best "base tree":
 *    - If the remote tree looks intact (has roughly as many files as disk), use it.
 *    - If the remote tree looks corrupt/incomplete, fall back to the last known good
 *      tree stored in .git_disabled (the original clone snapshot).
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
    const fullRef = `refs/heads/${currentBranch}`;

    // 1. Fetch to update the remote-tracking ref
    try {
        await git.fetch({ fs, http, dir, url: repoUrl, onAuth, tags: false, singleBranch: true });
    } catch (fetchErr) {
        console.warn('[Wiki] Fetch failed, will try push anyway:', fetchErr);
    }

    // 2. Resolve the current remote tip (prefer tracking ref, fall back to local ref)
    let parentOid: string;
    try {
        parentOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${currentBranch}` });
    } catch {
        parentOid = await git.resolveRef({ fs, dir, ref: fullRef });
    }

    // 3. Determine the best base tree
    let baseTreeOid: string;
    try {
        const { commit: remoteCommit } = await git.readCommit({ fs, dir, oid: parentOid });
        const remoteTree = await git.readTree({ fs, dir, oid: remoteCommit.tree });
        // Count non-hidden .md files on disk to sanity-check the remote tree
        const diskMdCount = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')).length;
        const remoteFileCount = remoteTree.tree.filter(e => e.type === 'blob' || e.type === 'tree').length;
        const remoteTreeLooksGood = remoteFileCount >= Math.max(1, diskMdCount / 2);

        if (remoteTreeLooksGood) {
            baseTreeOid = remoteCommit.tree;
        } else {
            // Remote tree appears incomplete (e.g. after a bad push).
            // Fall back to the original clone's tree stored in .git_disabled.
            console.warn(`[Wiki] Remote tree has ${remoteFileCount} entries vs ${diskMdCount} on disk — restoring from .git_disabled snapshot`);
            const disabledRef = path.join(dir, '.git_disabled', 'refs', 'heads', currentBranch);
            if (fs.existsSync(disabledRef)) {
                const origOid = fs.readFileSync(disabledRef, 'utf8').trim();
                const { commit: origCommit } = await git.readCommit({ fs, dir, oid: origOid });
                baseTreeOid = origCommit.tree;
            } else {
                baseTreeOid = remoteCommit.tree; // best we can do
            }
        }
    } catch (err) {
        throw new Error(`[Wiki] Could not read remote commit tree: ${err}`);
    }

    // 4. Write blob for new content
    const blobOid = await git.writeBlob({ fs, dir, blob: Buffer.from(content, 'utf8') });

    // 5. Build modified tree (ONLY the target file changes)
    const newTreeOid = await buildModifiedTree(dir, baseTreeOid, filePath.split('/'), blobOid);

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
    const pushResult = await git.push({ fs, http, dir, url: repoUrl, ref: fullRef, onAuth, onProgress: () => {} });
    if (pushResult?.ok) {
        console.log(`[Wiki] Pushed ${filePath} successfully`);
    } else if (pushResult?.error) {
        console.warn(`[Wiki] Push returned error: ${pushResult.error}`);
    }
}

export async function saveWikiFile(repoId: number, filePath: string, content: string): Promise<void> {
    const repo = getRepo(repoId);
    if (!repo) throw new Error('Repo not found');

    const fullPath = path.join(repo.local_path, filePath);
    const resolvedPath = path.resolve(fullPath);
    const repoDir = path.resolve(repo.local_path);
    if (!resolvedPath.startsWith(repoDir)) throw new Error('Invalid path');

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Write the file to disk first
    fs.writeFileSync(resolvedPath, content, 'utf8');

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const pat = repo.pat.startsWith('enc:') ? decrypt(repo.pat.slice(4)) : repo.pat;

    try {
        // Ensure the .git structure is valid before any git operation
        repairGitIfNeeded(repo.local_path);

        // Detect current branch (HEAD must exist after repair)
        let currentBranch = 'main';
        try {
            const branch = await git.currentBranch({ fs, dir: repo.local_path });
            if (branch) currentBranch = branch;
        } catch (_) {}

        // Push only the changed file — never touches other files
        await fetchModifyCommitPush(
            repo.local_path, repo.url, pat, currentBranch,
            filePath, content,
            `[Wiki] Updated ${filePath}`
        );
    } catch (err) {
        console.warn('[Wiki] Push failed (remote may not be reachable):', err);
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
    `).run(repoId, filePath, path.basename(filePath), content, contentHash);

    // Invalidate memory tree cache
    clearWikiTreeCache(repoId);
}

export async function createWikiFile(repoId: number, filePath: string, content: string): Promise<void> {
    const repo = getRepo(repoId);
    if (!repo) throw new Error('Repo not found');

    const fullPath = path.join(repo.local_path, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');
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
    const oldContent = await readWikiFileAtCommit(repoId, filePath, oid);
    if (oldContent === null) throw new Error('Could not read file at specified commit');

    const repo = getRepo(repoId);
    if (!repo) throw new Error('Repo not found');

    const fullPath = path.join(repo.local_path, filePath);
    fs.writeFileSync(fullPath, oldContent, 'utf8');

    const pat = repo.pat.startsWith('enc:') ? decrypt(repo.pat.slice(4)) : repo.pat;

    repairGitIfNeeded(repo.local_path);

    let currentBranch = 'main';
    try {
        const branch = await git.currentBranch({ fs, dir: repo.local_path });
        if (branch) currentBranch = branch;
    } catch (_) {}

    try {
        await fetchModifyCommitPush(
            repo.local_path, repo.url, pat, currentBranch,
            filePath, oldContent,
            `[Wiki] Reverted ${filePath} to ${oid.slice(0, 7)}`
        );
    } catch (err) {
        console.warn('[Wiki] Revert push failed:', err);
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
    `).run(repoId, filePath, path.basename(filePath), oldContent, contentHash);

    // Invalidate memory tree cache
    clearWikiTreeCache(repoId);
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