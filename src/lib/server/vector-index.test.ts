import { describe, it, expect } from 'vitest';
import { decideScan } from './vector-index';

/**
 * Covers the rule that decides between TurboQuant's approximate scan and the
 * exact one.
 *
 * Every case here is about *refusing* the fast path, because that is the side
 * with a silent failure mode: `vector_quantize_scan` against a structure built
 * before the newest rows were embedded returns a confident, wrong answer — the
 * new rows are simply absent, with no error and nothing in the logs. Measured on
 * the real extension: ten rows identical to the query vector were missing from
 * the quantized top-5 while the exact scan ranked them 1st–4th.
 *
 * So "quantized" must be reachable only from a fully-known-fresh state, and a
 * regression that loosens any of these conditions has to fail a test rather than
 * quietly shrink the searchable corpus.
 */

const fresh = {
    enabled: true,
    unusable: false,
    dirty: false,
    rows: 2000,
    quantizedRows: 2000,
    minRows: 512
};

describe('decideScan', () => {
    it('uses the quantized scan when the structure covers exactly the current rows', () => {
        expect(decideScan(fresh)).toBe('vector_quantize_scan');
    });

    it('falls back to exact when embeddings changed since the last quantize', () => {
        expect(decideScan({ ...fresh, dirty: true })).toBe('vector_full_scan');
    });

    it('falls back to exact when rows were added after the last quantize', () => {
        // The count check is what catches an insert that skipped markVectorIndexDirty.
        expect(decideScan({ ...fresh, rows: 2001 })).toBe('vector_full_scan');
    });

    it('falls back to exact when rows were deleted after the last quantize', () => {
        expect(decideScan({ ...fresh, rows: 1999 })).toBe('vector_full_scan');
    });

    it('never trusts a structure this process did not build', () => {
        // quantizedRows === null is the boot state: a persisted vector0_* shadow
        // table may exist from an earlier process, but its freshness cannot be
        // interrogated, so it must not be searched.
        expect(decideScan({ ...fresh, quantizedRows: null })).toBe('vector_full_scan');
    });

    it('stays exact below the row threshold, where approximation buys nothing', () => {
        expect(decideScan({ ...fresh, rows: 400, quantizedRows: 400 })).toBe('vector_full_scan');
    });

    it('honours the threshold boundary exactly', () => {
        expect(decideScan({ ...fresh, rows: 512, quantizedRows: 512 })).toBe('vector_quantize_scan');
        expect(decideScan({ ...fresh, rows: 511, quantizedRows: 511 })).toBe('vector_full_scan');
    });

    it('stays exact once a table is marked unusable (short or failed quantization)', () => {
        expect(decideScan({ ...fresh, unusable: true })).toBe('vector_full_scan');
    });

    it('stays exact when quantization is disabled by configuration', () => {
        expect(decideScan({ ...fresh, enabled: false })).toBe('vector_full_scan');
    });
});
