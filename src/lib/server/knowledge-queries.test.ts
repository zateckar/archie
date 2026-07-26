import { describe, it, expect } from 'vitest';
import {
    normalizePaging,
    pageCount,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
} from './knowledge-queries';

/**
 * Paging arithmetic only — the SQL itself is exercised by the route tests and the
 * pages that call it.
 *
 * These parameters arrive straight off a URL that a person can edit, so the
 * interesting cases are the malformed ones: the failure mode being guarded
 * against is a `?pageSize=100000` reinstating the unbounded whole-corpus response
 * that the pagination work removed, and a negative or NaN page producing a
 * negative OFFSET (which SQLite accepts, silently returning the wrong window).
 */
describe('normalizePaging', () => {
    it('defaults to the first page at the default size', () => {
        expect(normalizePaging(null, null)).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 });
    });

    it('shows 20 per page by default', () => {
        expect(DEFAULT_PAGE_SIZE).toBe(20);
    });

    it('accepts numeric strings from the query string', () => {
        expect(normalizePaging('3', '50')).toEqual({ page: 3, pageSize: 50, offset: 100 });
    });

    it('caps the page size so a hand-edited URL cannot request the whole corpus', () => {
        expect(normalizePaging('1', '100000').pageSize).toBe(MAX_PAGE_SIZE);
    });

    it('rejects zero and negative page sizes rather than producing an empty page', () => {
        expect(normalizePaging('1', '0').pageSize).toBe(DEFAULT_PAGE_SIZE);
        expect(normalizePaging('1', '-10').pageSize).toBe(DEFAULT_PAGE_SIZE);
    });

    it('never produces a negative offset', () => {
        expect(normalizePaging('0', '20').offset).toBe(0);
        expect(normalizePaging('-5', '20').offset).toBe(0);
        expect(normalizePaging('nonsense', '20')).toEqual({ page: 1, pageSize: 20, offset: 0 });
    });

    it('truncates fractional input instead of passing a float to LIMIT/OFFSET', () => {
        expect(normalizePaging('2.7', '20.9')).toEqual({ page: 2, pageSize: 20, offset: 20 });
    });
});

describe('pageCount', () => {
    it('counts partial pages', () => {
        expect(pageCount(21, 20)).toBe(2);
        expect(pageCount(40, 20)).toBe(2);
        expect(pageCount(41, 20)).toBe(3);
    });

    it('reports one page for an empty result, so the UI never says "page 1 of 0"', () => {
        expect(pageCount(0, 20)).toBe(1);
    });

    it('survives a zero page size instead of dividing by zero', () => {
        expect(Number.isFinite(pageCount(100, 0))).toBe(true);
    });
});
