/**
 * End-to-end check of the `!` convention through the wiki's file layer: a real
 * directory tree on disk, a real `git_repos` row, and the real `getFileTree` /
 * `readWikiFile` / `saveWikiFile` functions.
 *
 * Worth testing at this level rather than just on the predicate: hiding an entry
 * from the tree is only half the job — the read path has to refuse it too, or the
 * content stays one hand-typed URL away.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDb = path.join(os.tmpdir(), `wiki-ignore-${process.pid}-${Date.now()}.db`);
const tmpRepo = path.join(os.tmpdir(), `wiki-ignore-repo-${process.pid}-${Date.now()}`);

let db: import('better-sqlite3').Database;
let getFileTree: (repoId: number) => { name: string; path: string; type: 'file' | 'dir'; children?: unknown[] }[];
let readWikiFile: (repoId: number, filePath: string) => string | null;
let saveWikiFile: (repoId: number, filePath: string, content: string) => Promise<void>;
let repoId: number;

const write = (relPath: string, body: string) => {
    const full = path.join(tmpRepo, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
};

beforeAll(async () => {
    process.env.DATABASE_PATH = tmpDb;

    write('README.md', '# readme');
    write('docs/guide.md', '# guide');
    write('docs/!drafts/scratch.md', '# scratch');
    write('!Clean/README.md', '# generated copy');
    write('!-Clean/docs/guide.md', '# generated copy');
    write('!README.md', '# ignored readme');
    write('!_README.md', '# ignored readme too');

    const dbMod = await import('./db');
    db = dbMod.db as unknown as import('better-sqlite3').Database;
    const wiki = await import('./wiki');
    getFileTree = wiki.getFileTree as typeof getFileTree;
    readWikiFile = wiki.readWikiFile;
    saveWikiFile = wiki.saveWikiFile;

    repoId = (db.prepare(
        "INSERT INTO git_repos (url, pat, local_path) VALUES ('https://example.invalid/r.git', '', ?) RETURNING id"
    ).get(tmpRepo) as { id: number }).id;
});

afterAll(() => {
    try { db?.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpDb + suffix); } catch { /* never created */ }
    }
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* already gone */ }
});

describe('wiki tree excludes "!" entries', () => {
    it('lists only the visible files and folders', () => {
        const tree = getFileTree(repoId);
        const names = tree.map(i => i.name).sort();
        expect(names).toEqual(['README.md', 'docs']);
    });

    it('does not descend into an ignored subfolder', () => {
        const docs = getFileTree(repoId).find(i => i.name === 'docs');
        expect(docs?.children?.map((c: any) => c.name)).toEqual(['guide.md']);
    });
});

describe('wiki file access refuses "!" paths', () => {
    it('serves visible files', () => {
        expect(readWikiFile(repoId, 'README.md')).toContain('# readme');
        expect(readWikiFile(repoId, 'docs/guide.md')).toContain('# guide');
    });

    it('reports ignored files as absent even though they exist on disk', () => {
        expect(fs.existsSync(path.join(tmpRepo, '!README.md'))).toBe(true);
        expect(readWikiFile(repoId, '!README.md')).toBeNull();
        expect(readWikiFile(repoId, '!_README.md')).toBeNull();
        expect(readWikiFile(repoId, '!Clean/README.md')).toBeNull();
        expect(readWikiFile(repoId, '!-Clean/docs/guide.md')).toBeNull();
        expect(readWikiFile(repoId, 'docs/!drafts/scratch.md')).toBeNull();
    });

    it('refuses to write to an ignored path', async () => {
        await expect(saveWikiFile(repoId, '!Clean/new.md', 'x')).rejects.toThrow(/ignored/i);
        await expect(saveWikiFile(repoId, 'docs/!drafts/new.md', 'x')).rejects.toThrow(/ignored/i);
        expect(fs.existsSync(path.join(tmpRepo, '!Clean/new.md'))).toBe(false);
    });
});
