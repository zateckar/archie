import { describe, it, expect } from 'vitest';
import { isIgnoredPath, isIgnoredName, CLEAN_FOLDER, LEGACY_CLEAN_FOLDER } from './wiki-ignore';

/**
 * The `!` prefix is the only exclusion mechanism the wiki and the ingestion
 * pipeline share, so the predicate has to agree on every shape of path they hand
 * it: repo-relative POSIX paths from `git.listFiles`, OS paths from `fs` walks,
 * and API-supplied strings.
 */
describe('isIgnoredPath', () => {
    it('ignores files whose name starts with "!"', () => {
        expect(isIgnoredPath('!README.md')).toBe(true);
        expect(isIgnoredPath('!_README.md')).toBe(true);
        expect(isIgnoredPath('!-draft.md')).toBe(true);
    });

    it('ignores anything inside an ignored folder, at any depth', () => {
        expect(isIgnoredPath('!Clean/README.md')).toBe(true);
        expect(isIgnoredPath('!-Clean/docs/deep/file.md')).toBe(true);
        expect(isIgnoredPath('docs/!drafts/notes.md')).toBe(true);
        expect(isIgnoredPath('a/b/c/!archive/d/e.md')).toBe(true);
    });

    it('ignores the folder path itself', () => {
        expect(isIgnoredPath('!Clean')).toBe(true);
        expect(isIgnoredPath('!Clean/')).toBe(true);
    });

    it('does not ignore ordinary paths', () => {
        expect(isIgnoredPath('README.md')).toBe(false);
        expect(isIgnoredPath('Clean/README.md')).toBe(false);
        expect(isIgnoredPath('docs/guide.md')).toBe(false);
        expect(isIgnoredPath('MP_1_808_cz_01112024.md')).toBe(false);
    });

    it('only treats "!" as significant at the START of a segment', () => {
        // A bang elsewhere in the name is an ordinary character.
        expect(isIgnoredPath('important!.md')).toBe(false);
        expect(isIgnoredPath('docs/wow!/file.md')).toBe(false);
    });

    it('handles Windows separators and "./" prefixes identically', () => {
        expect(isIgnoredPath('!Clean\\README.md')).toBe(true);
        expect(isIgnoredPath('docs\\!drafts\\notes.md')).toBe(true);
        expect(isIgnoredPath('./!Clean/a.md')).toBe(true);
        expect(isIgnoredPath('.\\docs\\guide.md')).toBe(false);
    });

    it('is safe on empty and non-string input', () => {
        expect(isIgnoredPath('')).toBe(false);
        expect(isIgnoredPath(undefined as unknown as string)).toBe(false);
        expect(isIgnoredPath(null as unknown as string)).toBe(false);
    });
});

describe('cleaned-copies folder', () => {
    it('is hidden by the general rule, not by a name-specific exception', () => {
        // The whole reason for prefixing it: no code needs to know its name to
        // keep it out of the wiki and out of ingestion.
        expect(isIgnoredPath(CLEAN_FOLDER)).toBe(true);
        expect(isIgnoredPath(CLEAN_FOLDER + 'docs/guide.md')).toBe(true);
    });

    it('pins the folder names — changing either one moves files in user repositories', () => {
        expect(CLEAN_FOLDER).toBe('!Clean/');
        expect(LEGACY_CLEAN_FOLDER).toBe('Clean/');
    });

    it('leaves the legacy folder visible, since existing repos still hold one', () => {
        expect(isIgnoredPath(LEGACY_CLEAN_FOLDER + 'docs/guide.md')).toBe(false);
    });
});

describe('isIgnoredName', () => {
    it('matches a bare directory entry name', () => {
        expect(isIgnoredName('!Clean')).toBe(true);
        expect(isIgnoredName('!README.md')).toBe(true);
        expect(isIgnoredName('Clean')).toBe(false);
        expect(isIgnoredName('README.md')).toBe(false);
    });

    it('is not path-aware — that is isIgnoredPath\'s job', () => {
        // A name containing a separator is not a name; it must not be split here,
        // or callers walking a tree would get inconsistent answers per level.
        expect(isIgnoredName('docs/!drafts')).toBe(false);
    });
});
