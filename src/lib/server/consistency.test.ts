import { describe, it, expect } from 'vitest';
import { normalizeConsistencyResult } from './llm';

/**
 * `supersedesIndex` is the only value in the extraction pipeline that causes
 * existing data to be retired, and it arrives from an LLM. These cover the
 * shapes a model actually emits when it goes off-script.
 */
describe('normalizeConsistencyResult', () => {
    it('keeps a valid update target', () => {
        expect(normalizeConsistencyResult({ status: 'update', claimIndex: 0, supersedesIndex: 3 }))
            .toEqual({ status: 'update', claimIndex: 0, supersedesIndex: 3 });
    });

    it('accepts index 0 — the first existing claim is a legitimate target', () => {
        const r = normalizeConsistencyResult({ status: 'update', claimIndex: 1, supersedesIndex: 0 });
        expect(r.supersedesIndex).toBe(0);
    });

    it('coerces a numeric string, which JSON-mode models emit routinely', () => {
        const r = normalizeConsistencyResult({
            status: 'update',
            claimIndex: 0,
            supersedesIndex: '2' as unknown as number
        });
        expect(r.supersedesIndex).toBe(2);
    });

    it('drops a target on an update that did not name one', () => {
        const r = normalizeConsistencyResult({ status: 'update', claimIndex: 0 });
        expect(r.supersedesIndex).toBeUndefined();
    });

    it('drops non-integer, negative and unparseable targets', () => {
        for (const bad of [1.5, -1, NaN, 'E2', null, {}]) {
            const r = normalizeConsistencyResult({
                status: 'update',
                claimIndex: 0,
                supersedesIndex: bad as unknown as number
            });
            expect(r.supersedesIndex, `input ${JSON.stringify(bad)}`).toBeUndefined();
        }
    });

    it('strips a target from any non-update verdict', () => {
        // A model that returns "conflict" plus an index must not retire
        // anything — conflicts are surfaced for review, not resolved silently.
        for (const status of ['unique', 'duplicate', 'conflict'] as const) {
            const r = normalizeConsistencyResult({ status, claimIndex: 0, supersedesIndex: 1 });
            expect(r.supersedesIndex, status).toBeUndefined();
            expect(r.status).toBe(status);
        }
    });

    it('preserves claimIndex and reason', () => {
        const r = normalizeConsistencyResult({
            status: 'update',
            claimIndex: 7,
            supersedesIndex: 1,
            reason: 'newer policy version'
        });
        expect(r.claimIndex).toBe(7);
        expect(r.reason).toBe('newer policy version');
    });
});
