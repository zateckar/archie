import { describe, it, expect } from 'vitest';
import { buildFtsMatchQuery, tokenizeForFts } from './fts-query';

/**
 * The corpus is Czech. The regression these pin: the previous inline sanitizers
 * used the ASCII-only `\w` class, so every accented letter was treated as
 * punctuation and replaced with a space — shredding words into fragments that
 * were measured to match 0 rows against the real index.
 */
describe('tokenizeForFts', () => {
    it('keeps Czech words whole (the core regression)', () => {
        // Old behaviour: ['zen'] and ['bezpe', 'nostn'].
        expect(tokenizeForFts('řízení')).toEqual(['řízení']);
        expect(tokenizeForFts('bezpečnostní')).toEqual(['bezpečnostní']);
        expect(tokenizeForFts('schválení')).toEqual(['schválení']);
        expect(tokenizeForFts('řízení projektů')).toEqual(['řízení', 'projektů']);
    });

    it('keeps other non-ASCII Latin the corpus carries (German, Polish)', () => {
        expect(tokenizeForFts('Straße Łódź')).toEqual(['Straße', 'Łódź']);
    });

    it('strips punctuation and symbols but not letters', () => {
        expect(tokenizeForFts('řízení, projektů: (kvalita)!')).toEqual(['řízení', 'projektů', 'kvalita']);
    });

    it('keeps digits and alphanumeric identifiers', () => {
        expect(tokenizeForFts('ISO 9001 utf8')).toEqual(['ISO', '9001', 'utf8']);
    });

    it('measures length in code points, not UTF-16 units', () => {
        // 'úřad' is 4 code points and must survive the >=3 filter.
        expect(tokenizeForFts('úřad')).toEqual(['úřad']);
        // 'má' is 2 — legitimately dropped.
        expect(tokenizeForFts('má')).toEqual([]);
    });

    it('returns an empty list for empty or symbol-only input', () => {
        expect(tokenizeForFts('')).toEqual([]);
        expect(tokenizeForFts('--- !!! ???')).toEqual([]);
    });
});

describe('buildFtsMatchQuery', () => {
    it('quotes every token and ORs them', () => {
        expect(buildFtsMatchQuery('řízení projektů')).toBe('"řízení" OR "projektů"');
    });

    it('appends the prefix wildcard outside the quotes when asked', () => {
        // Inflected Czech needs prefix matching: 'řízení' vs 'řízeními'.
        expect(buildFtsMatchQuery('řízení', { prefix: true })).toBe('"řízení"*');
    });

    it('returns null instead of a degenerate match-all', () => {
        // The old code emitted '"*"' here, which was measured returning 0 rows
        // while looking like it had run — the caller must skip FTS entirely.
        expect(buildFtsMatchQuery('má')).toBeNull();
        expect(buildFtsMatchQuery('')).toBeNull();
        expect(buildFtsMatchQuery('!!!')).toBeNull();
    });

    it('neutralises FTS5 operators by quoting', () => {
        // Unquoted, `rizeni AND` is a syntax error and `NOT` becomes an operator.
        expect(buildFtsMatchQuery('rizeni AND NOT')).toBe('"rizeni" OR "AND" OR "NOT"');
        // A hyphen would otherwise be read as a column filter ("no such column").
        expect(buildFtsMatchQuery('rizeni-projektu')).toBe('"rizeni" OR "projektu"');
    });

    it('cannot emit a token containing a double quote', () => {
        // Tokenisation strips `"` as a symbol, so it splits rather than needing
        // escaping — the quote-doubling in buildFtsMatchQuery is unreachable
        // belt-and-braces. What matters is the guarantee asserted here: no token
        // in the output can carry a quote that would break out of the literal.
        const built = buildFtsMatchQuery('foo"bar');
        expect(built).toBe('"foo" OR "bar"');
        expect(tokenizeForFts('foo"bar')).toEqual(['foo', 'bar']);
    });
});
