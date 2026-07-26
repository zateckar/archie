import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveRepoPath } from './wiki';

/**
 * `resolveRepoPath` confines an API-supplied file path to a repository directory.
 *
 * It replaced `resolved.startsWith(repoDir)`, a *character* prefix test that
 * accepted a sibling directory sharing a name prefix — and `revertToCommit` had no
 * check at all, so `POST /api/wiki/[repoId]/revert` wrote wherever it was told.
 */

const repo = path.resolve('/srv/repos/wiki');

describe('resolveRepoPath', () => {
    it('resolves a normal relative path inside the repo', () => {
        expect(resolveRepoPath(repo, 'docs/guide.md')).toBe(path.join(repo, 'docs', 'guide.md'));
    });

    it('accepts the repo root itself', () => {
        expect(resolveRepoPath(repo, '.')).toBe(repo);
    });

    it('rejects traversal out of the repo', () => {
        expect(resolveRepoPath(repo, '../secrets.md')).toBeNull();
        expect(resolveRepoPath(repo, 'docs/../../secrets.md')).toBeNull();
        expect(resolveRepoPath(repo, '../../../../etc/passwd')).toBeNull();
    });

    it('rejects a sibling directory sharing a name prefix', () => {
        // The bug in the previous check: '/srv/repos/wiki-secret/x.md' genuinely
        // starts with '/srv/repos/wiki', so startsWith() let it through.
        expect(resolveRepoPath(repo, '../wiki-secret/x.md')).toBeNull();
    });

    it('normalises backslashes so a Windows separator cannot sidestep the check', () => {
        expect(resolveRepoPath(repo, '..\\secrets.md')).toBeNull();
        expect(resolveRepoPath(repo, 'docs\\guide.md')).toBe(path.join(repo, 'docs', 'guide.md'));
    });

    it('rejects an absolute path rather than reinterpreting it as repo-relative', () => {
        // POSIX-absolute. On Windows this resolves onto the current drive root,
        // which is still outside the repo — either way it must not be served.
        expect(resolveRepoPath(repo, '/etc/passwd')).toBeNull();
    });

    it('rejects a drive-qualified absolute path', () => {
        expect(resolveRepoPath(repo, 'C:/Windows/System32/drivers/etc/hosts')).toBeNull();
    });

    it('rejects empty, non-string, and NUL-bearing paths', () => {
        expect(resolveRepoPath(repo, '')).toBeNull();
        expect(resolveRepoPath(repo, undefined as unknown as string)).toBeNull();
        expect(resolveRepoPath(repo, 'docs/guide.md\0.png')).toBeNull();
    });

    it('keeps a path whose own name merely starts with a traversal-looking segment', () => {
        // '..foo' is a legitimate file name, not a traversal.
        expect(resolveRepoPath(repo, '..foo/bar.md')).toBe(path.join(repo, '..foo', 'bar.md'));
    });
});
