import { describe, it, expect } from 'vitest';
import { buildKeywordProbe, mergeByIdKeepingBestScore } from './retrieval-probe';

/**
 * The probe builder decides whether a second embedding call is made per query,
 * on every chat turn. Getting the "adds nothing" case wrong either doubles
 * retrieval cost for no gain (too permissive) or silently disables the
 * entity-level path (too strict).
 */
describe('buildKeywordProbe', () => {
    it('returns null when there are no keywords', () => {
        expect(buildKeywordProbe('what is IT-PEP?', undefined)).toBeNull();
        expect(buildKeywordProbe('what is IT-PEP?', [])).toBeNull();
    });

    it('returns null when every keyword already appears in the query', () => {
        expect(buildKeywordProbe('does IT-PEP require a security review?', ['IT-PEP', 'security review']))
            .toBeNull();
    });

    it('is case-insensitive when deciding a keyword is already present', () => {
        expect(buildKeywordProbe('Does IT-PEP apply?', ['it-pep'])).toBeNull();
    });

    it('builds a probe when at least one keyword is novel', () => {
        expect(buildKeywordProbe('does IT-PEP apply?', ['IT-PEP', 'release governance']))
            .toBe('IT-PEP, release governance');
    });

    it('keeps already-present keywords in the probe once any keyword is novel', () => {
        // The probe is a standalone embedding target, so dropping the terms that
        // happen to overlap the query would strip exactly the anchoring terms
        // that make the probe land in the right neighbourhood.
        const probe = buildKeywordProbe('what about IT-PEP?', ['IT-PEP', 'change approval']);
        expect(probe).toBe('IT-PEP, change approval');
    });

    it('ignores blank and whitespace-only keywords', () => {
        expect(buildKeywordProbe('anything', ['   ', ''])).toBeNull();
        expect(buildKeywordProbe('anything', ['  governance  ', ''])).toBe('governance');
    });

    it('survives non-string entries from a malformed model response', () => {
        expect(buildKeywordProbe('anything', [null as any, 42 as any, 'audit'])).toBe('audit');
    });
});

describe('mergeByIdKeepingBestScore', () => {
    it('keeps the higher score when an item appears in both lists', () => {
        const merged = mergeByIdKeepingBestScore(
            [{ id: 1, score: 0.5 }],
            [{ id: 1, score: 0.9 }]
        );
        expect(merged).toEqual([{ id: 1, score: 0.9 }]);
    });

    it('does not downgrade a score when the second list ranks it lower', () => {
        const merged = mergeByIdKeepingBestScore(
            [{ id: 1, score: 0.9 }],
            [{ id: 1, score: 0.2 }]
        );
        expect(merged[0].score).toBe(0.9);
    });

    it('unions distinct ids and sorts by score descending', () => {
        const merged = mergeByIdKeepingBestScore(
            [{ id: 1, score: 0.4 }, { id: 2, score: 0.8 }],
            [{ id: 3, score: 0.6 }]
        );
        expect(merged.map(m => m.id)).toEqual([2, 3, 1]);
    });

    it('preserves the full object of the winning entry, not just its score', () => {
        const merged = mergeByIdKeepingBestScore(
            [{ id: 1, score: 0.3, name: 'from-query' }],
            [{ id: 1, score: 0.7, name: 'from-keywords' }]
        );
        expect(merged[0].name).toBe('from-keywords');
    });

    it('handles empty inputs', () => {
        expect(mergeByIdKeepingBestScore<{ id: number; score: number }>([], [])).toEqual([]);
    });
});
