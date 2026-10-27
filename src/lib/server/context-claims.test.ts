import { describe, it, expect } from 'vitest';
import { selectContextClaims, topicsToAdopt, type ContextClaim } from './context-claims';

let nextId = 1;
const claim = (topic_id: number, score: number, extra: Partial<ContextClaim> = {}): ContextClaim => ({
    id: nextId++,
    claim_text: `claim ${nextId}`,
    topic_id,
    topic_name: `topic ${topic_id}`,
    claim_type: 'assertion',
    score,
    status: 'active',
    ...extra
});

describe('selectContextClaims', () => {
    it('keeps semantic hits ahead of filler and stops at maxClaims', () => {
        const semantic = [claim(1, 0.9), claim(2, 0.8)];
        const filler = [claim(3, 0.5), claim(3, 0.4)];
        const out = selectContextClaims({ conflicting: [], semantic, filler, maxClaims: 3 });
        expect(out.map(c => c.id)).toEqual([semantic[0].id, semantic[1].id, filler[0].id]);
    });

    it('guarantees conflicts a slot without spending the budget', () => {
        const conflict = claim(1, 0.2, { status: 'conflicting' });
        const semantic = [claim(1, 0.9), claim(2, 0.8)];
        const out = selectContextClaims({ conflicting: [conflict], semantic, filler: [], maxClaims: 2 });
        expect(out).toHaveLength(3);
        expect(out[0]).toMatchObject({ id: conflict.id, status: 'conflicting' });
    });

    it('does not count a duplicate twice', () => {
        const shared = claim(1, 0.9);
        const out = selectContextClaims({ conflicting: [], semantic: [shared], filler: [{ ...shared }, claim(1, 0.3)], maxClaims: 5 });
        expect(out).toHaveLength(2);
    });

    it('marks a claim found as conflicting as conflicting even if search also returned it', () => {
        const c = claim(1, 0.9);
        const out = selectContextClaims({ conflicting: [{ ...c, status: 'conflicting' }], semantic: [c], filler: [], maxClaims: 5 });
        expect(out).toHaveLength(1);
        expect(out[0].status).toBe('conflicting');
    });
});

describe('topicsToAdopt', () => {
    it('returns topics of selected claims that are missing from the context, with their best score', () => {
        // The regression: claims of topic 7 were selected but topic 7 was not
        // in the topic set, so they were never rendered.
        const claims = [claim(1, 0.9), claim(7, 0.6), claim(7, 0.8)];
        const adopt = topicsToAdopt(claims, new Set([1]));
        expect([...adopt.entries()]).toEqual([[7, 0.8]]);
    });

    it('adopts nothing when every claim already has its topic', () => {
        expect(topicsToAdopt([claim(1, 0.9)], new Set([1])).size).toBe(0);
    });
});
