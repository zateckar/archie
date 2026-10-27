import { describe, it, expect } from 'vitest';
import {
    supportedExtensions, normalizeFolder, checkUploadFilename, uploadPath, repoDisplayName, migrationFilename, planMoves
} from './repo-upload';

/**
 * Uploads are committed into a git repository at a user-chosen folder, so every
 * name typed in the upload dialog becomes a path in someone's repo.
 */

describe('supportedExtensions', () => {
    it('defaults to what the git sync ingests', () => {
        expect(supportedExtensions('')).toEqual(['.md', '.mdx']);
        expect(supportedExtensions(undefined)).toEqual(['.md', '.mdx']);
    });

    it('normalises the SUPPORTED_EXTENSIONS list', () => {
        expect(supportedExtensions(' .MD, txt ,,')).toEqual(['.md', '.txt']);
    });
});

describe('normalizeFolder', () => {
    it('treats missing or blank input as the repo root', () => {
        expect(normalizeFolder(undefined)).toEqual({ ok: true, value: '' });
        expect(normalizeFolder('')).toEqual({ ok: true, value: '' });
        expect(normalizeFolder('/')).toEqual({ ok: true, value: '' });
    });

    it('normalises separators and stray slashes', () => {
        expect(normalizeFolder('\\docs\\guides\\')).toEqual({ ok: true, value: 'docs/guides' });
        expect(normalizeFolder('docs//new folder/')).toEqual({ ok: true, value: 'docs/new folder' });
    });

    it('rejects traversal', () => {
        expect(normalizeFolder('docs/../../etc').ok).toBe(false);
        expect(normalizeFolder('..').ok).toBe(false);
    });

    it('rejects folders the app would hide or ignore', () => {
        expect(normalizeFolder('docs/!drafts').ok).toBe(false);
        expect(normalizeFolder('.git').ok).toBe(false);
    });

    it('rejects the legacy cleaned-copies folder the sync skips', () => {
        expect(normalizeFolder('Clean').ok).toBe(false);
        expect(normalizeFolder('/Clean/sub').ok).toBe(false);
        expect(normalizeFolder('Cleanup')).toEqual({ ok: true, value: 'Cleanup' });
        expect(normalizeFolder('docs/Clean')).toEqual({ ok: true, value: 'docs/Clean' });
    });

    it('rejects names Windows cannot check out', () => {
        expect(normalizeFolder('a:b').ok).toBe(false);
        expect(normalizeFolder('docs/con').ok).toBe(false);
        expect(normalizeFolder('trailing.').ok).toBe(false);
    });

    it('rejects non-strings', () => {
        expect(normalizeFolder(42).ok).toBe(false);
    });
});

describe('checkUploadFilename', () => {
    const exts = ['.md', '.mdx'];

    it('accepts a plain supported name', () => {
        expect(checkUploadFilename('Guide.MD', exts)).toEqual({ ok: true, value: 'Guide.MD' });
    });

    it('rejects types the sync would later delete from the corpus', () => {
        const r = checkUploadFilename('notes.txt', exts);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('.md, .mdx');
    });

    it('rejects paths, hidden and ignored names', () => {
        expect(checkUploadFilename('docs/a.md', exts).ok).toBe(false);
        expect(checkUploadFilename('..\\a.md', exts).ok).toBe(false);
        expect(checkUploadFilename('.md', exts).ok).toBe(false);
        expect(checkUploadFilename('!draft.md', exts).ok).toBe(false);
        expect(checkUploadFilename('', exts).ok).toBe(false);
        expect(checkUploadFilename(undefined, exts).ok).toBe(false);
    });
});

describe('migrationFilename', () => {
    const exts = ['.md', '.mdx'];

    it('keeps a supported name', () => {
        expect(migrationFilename('Guide.md', exts)).toEqual({ ok: true, value: { name: 'Guide.md', renamed: false } });
    });

    it('renames .txt and extensionless uploads to .md, which sync ingests', () => {
        expect(migrationFilename('notes.txt', exts)).toEqual({ ok: true, value: { name: 'notes.md', renamed: true } });
        expect(migrationFilename('README', exts)).toEqual({ ok: true, value: { name: 'README.md', renamed: true } });
    });

    it('repairs names a repository path cannot hold instead of stranding the upload', () => {
        expect(migrationFilename('Q3: plan?.md', exts)).toEqual({ ok: true, value: { name: 'Q3- plan-.md', renamed: true } });
        expect(migrationFilename('!draft.md', exts)).toEqual({ ok: true, value: { name: 'draft.md', renamed: true } });
        expect(migrationFilename('con.md', exts)).toEqual({ ok: true, value: { name: '_con.md', renamed: true } });
    });
});

describe('planMoves', () => {
    const exts = ['.md', '.mdx'];
    const free = () => null;

    it('places every upload under the folder', () => {
        const plan = planMoves([{ id: 1, filename: 'a.md' }, { id: 2, filename: 'b.txt' }], 'docs/old', free, exts);
        expect(plan).toEqual([
            { id: 1, filename: 'a.md', status: 'ready', path: 'docs/old/a.md', renamed: false },
            { id: 2, filename: 'b.txt', status: 'ready', path: 'docs/old/b.md', renamed: true }
        ]);
    });

    it('reports paths taken in the repository', () => {
        const plan = planMoves([{ id: 1, filename: 'a.md' }], '', p => (p === 'a.md' ? 'exists' : null), exts);
        expect(plan[0]).toMatchObject({ status: 'conflict', path: 'a.md', reason: 'exists' });
    });

    it('lets only the first of a batch claim a path, case-insensitively', () => {
        const plan = planMoves(
            [{ id: 1, filename: 'Spec.md' }, { id: 2, filename: 'spec.md' }, { id: 3, filename: 'spec.txt' }],
            '', free, exts
        );
        expect(plan.map(m => m.status)).toEqual(['ready', 'conflict', 'conflict']);
    });
});

describe('uploadPath / repoDisplayName', () => {
    it('joins folder and filename', () => {
        expect(uploadPath('', 'a.md')).toBe('a.md');
        expect(uploadPath('docs/x', 'a.md')).toBe('docs/x/a.md');
    });

    it('shortens repository URLs', () => {
        expect(repoDisplayName('https://dev.azure.com/org/proj/_git/Wiki')).toBe('Wiki');
        expect(repoDisplayName('https://github.com/o/docs.git/')).toBe('docs');
    });
});
