import { describe, it, expect } from 'vitest';
import { normalizeQueryAnalysis } from './llm';

/**
 * The dual-level keyword lists arrive from an LLM and drive which retrieval
 * paths run. They are advisory: anything unusable must be dropped so retrieval
 * degrades to the single-probe behaviour rather than searching on garbage.
 */
describe('normalizeQueryAnalysis', () => {
    const base = { needsClarification: false, searchableQuery: 'q', confidence: 'high' as const };

    it('passes through well-formed keyword lists', () => {
        const r = normalizeQueryAnalysis(
            { ...base, highLevelKeywords: ['governance'], lowLevelKeywords: ['IT-PEP'] },
            'original'
        );
        expect(r.highLevelKeywords).toEqual(['governance']);
        expect(r.lowLevelKeywords).toEqual(['IT-PEP']);
    });

    it('returns undefined rather than an empty array when a list is empty', () => {
        // Callers check for presence; an empty array would build an empty probe.
        const r = normalizeQueryAnalysis({ ...base, highLevelKeywords: [], lowLevelKeywords: [] }, 'original');
        expect(r.highLevelKeywords).toBeUndefined();
        expect(r.lowLevelKeywords).toBeUndefined();
    });

    it('omits the lists entirely when the model did not return them', () => {
        const r = normalizeQueryAnalysis({ ...base }, 'original');
        expect(r.highLevelKeywords).toBeUndefined();
        expect(r.lowLevelKeywords).toBeUndefined();
    });

    it('wraps a bare string into a list — models collapse single-item arrays', () => {
        const r = normalizeQueryAnalysis({ ...base, lowLevelKeywords: 'IT-PEP' as any }, 'original');
        expect(r.lowLevelKeywords).toEqual(['IT-PEP']);
    });

    it('drops non-strings and one-character noise', () => {
        const r = normalizeQueryAnalysis(
            { ...base, lowLevelKeywords: ['ok', 'x', '', null, 7, '  '] as any },
            'original'
        );
        expect(r.lowLevelKeywords).toEqual(['ok']);
    });

    it('trims surrounding whitespace', () => {
        const r = normalizeQueryAnalysis({ ...base, highLevelKeywords: ['  audit trail  '] }, 'original');
        expect(r.highLevelKeywords).toEqual(['audit trail']);
    });

    it('caps a runaway list at 8 entries', () => {
        const many = Array.from({ length: 30 }, (_, i) => `keyword-${i}`);
        const r = normalizeQueryAnalysis({ ...base, lowLevelKeywords: many }, 'original');
        expect(r.lowLevelKeywords).toHaveLength(8);
    });

    it('falls back to the original prompt when searchableQuery came back empty', () => {
        expect(normalizeQueryAnalysis({ ...base, searchableQuery: '   ' }, 'original').searchableQuery)
            .toBe('original');
        expect(normalizeQueryAnalysis({ ...base, searchableQuery: undefined as any }, 'original').searchableQuery)
            .toBe('original');
    });

    it('preserves the clarification fields untouched', () => {
        const r = normalizeQueryAnalysis(
            { ...base, needsClarification: true, clarificationQuestions: ['which system?'] },
            'original'
        );
        expect(r.needsClarification).toBe(true);
        expect(r.clarificationQuestions).toEqual(['which system?']);
    });
});
