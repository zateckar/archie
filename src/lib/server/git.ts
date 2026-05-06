import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { db } from './db';
import { addDocument } from './rag';
import { rebuildTaxonomy } from './knowledge';
import { encrypt, decrypt } from './crypto-utils';

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
            singleBranch: true,
            depth: 1
        });
    } else {
        try {

        await git.pull({
            fs,
            http,
            dir,
            url,
            onAuth: () => ({ username: 'token', password: pat }),
            singleBranch: true,
            author: { name: 'Agent', email: 'agent@local' }
        });
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
                singleBranch: true,
                depth: 1
            });
            console.log(`Successfully re-cloned repo ${repoId}`);

        }
    }

    let head: string;
    try {
        head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    } catch (err) {
        console.warn('Could not resolve HEAD, repo might be empty:', err);
        return;
    }
    
    if (head === repo.last_commit) {
        console.log('No changes in repo', url);
        db.prepare('UPDATE git_repos SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?').run(repoId);
        return;
    }

    // Get all files in the repo (recursive)
    const files = await git.listFiles({ fs, dir });
    
    // Filter for supported files (e.g., .md, .txt)
    const supportedExtensions = process.env.SUPPORTED_EXTENSIONS ? process.env.SUPPORTED_EXTENSIONS.split(',') : ['.md', '.mdx'];
    const docFiles = files.filter(f => supportedExtensions.includes(path.extname(f).toLowerCase()));

    // Get existing documents for this repo
    const existingDocs = db.prepare('SELECT id, path, content_hash FROM documents WHERE repo_id = ?').all(repoId) as { id: number, path: string, content_hash: string }[];
    const existingPaths = new Map(existingDocs.map(d => [d.path, d.id]));

    for (const filePath of docFiles) {
        const fullPath = path.join(dir, filePath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const filename = path.basename(filePath);

        if (existingPaths.has(filePath)) {
            // Update if changed (simple check: content hash or just always update for now)
            // To be efficient, we could check if content changed, but addDocument currently doesn't handle updates well.
            // Let's delete and re-add for simplicity, or modify addDocument.
            const docId = existingPaths.get(filePath)!;
            
            // Check if content is different using hash
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            const currentDoc = existingDocs.find(d => d.id === docId);
            if (currentDoc?.content_hash !== contentHash) {
                console.log('Updating document:', filePath);
                // addDocument now uses INSERT OR REPLACE, so it will handle the update and cleanup old chunks via CASCADE

                // Add new one
                await addDocumentFromGit(repoId, filePath, filename, content);
            } else {
                console.log('Document unchanged:', filePath);
            }
            existingPaths.delete(filePath);
        } else {
            console.log('Adding new document:', filePath);
            await addDocumentFromGit(repoId, filePath, filename, content);
        }
    }

    // Delete documents that are no longer in the repo
    for (const [filePath, docId] of existingPaths) {
        console.log('Deleting removed document:', filePath);
        db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    }

    // Update last commit and last sync time
    db.prepare('UPDATE git_repos SET last_commit = ?, last_sync_at = CURRENT_TIMESTAMP WHERE id = ?').run(head, repoId);

    // After a full sync, rebuild taxonomy holistically
    console.log(`[Git Sync] Triggering full taxonomy rebuild after sync of repo ${repoId}...`);
    try {
        await rebuildTaxonomy();
    } catch (err) {
        console.error('[Git Sync] Taxonomy rebuild failed:', err);
    }
}

async function addDocumentFromGit(repoId: number, filePath: string, filename: string, content: string) {
    // We need a modified version of addDocument that takes repoId and path
    // For now, let's just use a modified addDocument or a new one.
    // I'll update rag.ts to support these extra fields.
    await addDocument(filename, content, { repoId, path: filePath });
}

export async function registerRepo(url: string, pat: string, syncInterval: number = 3600000) {
    const repoName = url.split('/').pop() || 'repo';
    const localPath = path.join(REPOS_DIR, `${repoName}_${Date.now()}`);
    const encryptedPat = pat ? `enc:${encrypt(pat)}` : '';
    
    const result = db.prepare('INSERT INTO git_repos (url, pat, local_path, sync_interval) VALUES (?, ?, ?, ?)').run(url, encryptedPat, localPath, syncInterval);
    return result.lastInsertRowid;
}
