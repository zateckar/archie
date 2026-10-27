import { describe, it, expect } from 'vitest';
import { planFollowUpQueries, verificationNotes } from './follow-up';
import { normalizeContextEvaluation } from './llm';

describe('planFollowUpQueries', () => {
    it('searches coverage gaps only when the context is insufficient', () => {
        const ev = { sufficient: true, refinedQueries: ['kafka sla'], doubts: [] };
        expect(planFollowUpQueries(ev, [])).toEqual([]);
        expect(planFollowUpQueries({ ...ev, sufficient: false }, []))
            .toEqual([{ query: 'kafka sla', purpose: 'coverage' }]);
    });

    it('verifies doubts even when coverage is sufficient', () => {
        const ev = { sufficient: true, refinedQueries: [], doubts: [{ verifyQuery: 'AWS gateway deprecation' }] };
        expect(planFollowUpQueries(ev, [])).toEqual([{ query: 'AWS gateway deprecation', purpose: 'verify' }]);
    });

    it('skips queries already searched and duplicates, and caps the round', () => {
        const ev = {
            sufficient: false,
            refinedQueries: ['Kafka  SLA', 'kafka support'],
            doubts: [{ verifyQuery: 'kafka sla' }, { verifyQuery: 'a' }, { verifyQuery: 'b' }]
        };
        expect(planFollowUpQueries(ev, ['kafka support']).map((q) => q.query)).toEqual(['Kafka  SLA', 'a', 'b']);
    });
});

describe('verificationNotes', () => {
    it('is empty without doubts and lists each doubt otherwise', () => {
        expect(verificationNotes([])).toBe('');
        const notes = verificationNotes([{ fact: 'SLA 99.5%', concern: 'another source says 99.95%' }]);
        expect(notes).toContain('"SLA 99.5%": another source says 99.95%');
        expect(notes).toMatch(/uncertain/);
    });
});

describe('normalizeContextEvaluation', () => {
    it('defaults to sufficient with no doubts on malformed input', () => {
        expect(normalizeContextEvaluation(null)).toEqual({ sufficient: true, missingAspects: [], refinedQueries: [], doubts: [] });
        expect(normalizeContextEvaluation({ sufficient: 'no', doubts: 'x' }).sufficient).toBe(true);
    });

    it('keeps well-formed doubts, drops incomplete ones, caps at 3', () => {
        const r = normalizeContextEvaluation({
            sufficient: false,
            refinedQueries: ['q', 3, ' '],
            doubts: [
                { fact: 'a', concern: 'c', verifyQuery: 'v' },
                { fact: 'no concern' },
                { fact: 'b', concern: 'c' },
                { fact: 'd', concern: 'c' },
                { fact: 'e', concern: 'c' }
            ]
        });
        expect(r.sufficient).toBe(false);
        expect(r.refinedQueries).toEqual(['q']);
        expect(r.doubts.map((d) => d.fact)).toEqual(['a', 'b', 'd']);
        expect(r.doubts[1].verifyQuery).toBe('');
    });
});
