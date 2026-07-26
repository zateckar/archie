import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeRanking } from './llm';

/**
 * `rerank()` returns indices that callers use as a reordering and then slice:
 * `rankedIndices.map(i => pooled[i]).filter(Boolean).slice(0, limit)`.
 *
 * That absorbs out-of-range indices but not truncation or duplication, which are
 * the two shapes that actually change retrieval results — a reranker returning 3
 * of 15 indices silently turned a `maxTopics = 5` request into 3 topics.
 * normalizeRanking guarantees a complete permutation so a slice is a real top-k.
 */

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('normalizeRanking', () => {
    it('passes a complete valid permutation through unchanged', () => {
        expect(normalizeRanking([2, 0, 1], 3, 'test')).toEqual([2, 0, 1]);
    });

    it('appends never-ranked indices in original order after the ranked ones', () => {
        // The truncation case: a 15-candidate pool, only 3 indices returned.
        const result = normalizeRanking([7, 2, 11], 15, 'test');
        expect(result.slice(0, 3)).toEqual([7, 2, 11]);
        expect(result).toHaveLength(15);
        // Everything else follows, in ascending original order.
        expect(result.slice(3)).toEqual([0, 1, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14]);
    });

    it('is always a complete permutation, so slicing yields a real top-k', () => {
        const result = normalizeRanking([4], 5, 'test');
        expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    it('de-duplicates repeated indices instead of emitting a document twice', () => {
        const result = normalizeRanking([0, 0, 1], 3, 'test');
        expect(result).toEqual([0, 1, 2]);
        expect(new Set(result).size).toBe(result.length);
    });

    it('drops out-of-range and negative indices', () => {
        const result = normalizeRanking([99, -1, 1], 3, 'test');
        expect(result.slice(0, 1)).toEqual([1]);
        expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    });

    it('drops non-integer values rather than indexing with them', () => {
        const result = normalizeRanking([NaN, Infinity, 1.5, 0], 3, 'test');
        // 1.5 truncates to 1 and is kept; NaN/Infinity are not usable indices.
        expect(result.slice(0, 2)).toEqual([1, 0]);
        expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    });

    it('returns identity order when the reranker returned nothing usable', () => {
        expect(normalizeRanking([], 4, 'test')).toEqual([0, 1, 2, 3]);
    });

    it('handles an empty candidate set', () => {
        expect(normalizeRanking([], 0, 'test')).toEqual([]);
    });

    it('warns when candidates were dropped or left unranked, so degradation is visible', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        normalizeRanking([0], 5, 'LLM rerank');
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toMatch(/never ranked/);
    });

    it('stays silent when the ranking was already complete and valid', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        normalizeRanking([1, 0], 2, 'LLM rerank');
        expect(warn).not.toHaveBeenCalled();
    });
});
