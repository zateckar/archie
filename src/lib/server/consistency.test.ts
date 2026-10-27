import { describe, it, expect } from 'vitest';
import { normalizeConsistencyResult, coerceConsistencyResults } from './llm';

describe('coerceConsistencyResults', () => {
    it('accepts a bare array, a wrapped array and a single verdict object', () => {
        const v = { status: 'unique', claimIndex: 0 };
        expect(coerceConsistencyResults([v])).toEqual([v]);
        expect(coerceConsistencyResults({ results: [v] })).toEqual([v]);
        expect(coerceConsistencyResults({ status: 'conflict', conflictsWithIndex: 1 }))
            .toEqual([{ status: 'conflict', conflictsWithIndex: 1, claimIndex: 0 }]);
    });

    it('returns null when there is nothing verdict-shaped', () => {
        expect(coerceConsistencyResults(undefined)).toBeNull();
        expect(coerceConsistencyResults('unique')).toBeNull();
        expect(coerceConsistencyResults({ note: 'x' })).toBeNull();
    });
});

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

    it('strips a supersession target from any non-update verdict', () => {
        // A model that returns "conflict" plus an index must not retire
        // anything — conflicts are surfaced for review, not resolved silently.
        for (const status of ['unique', 'duplicate'] as const) {
            const r = normalizeConsistencyResult({ status, claimIndex: 0, supersedesIndex: 1 });
            expect(r.supersedesIndex, status).toBeUndefined();
            expect(r.status).toBe(status);
        }
        const conflict = normalizeConsistencyResult({ status: 'conflict', claimIndex: 0, supersedesIndex: 1, conflictsWithIndex: 2 });
        expect(conflict.supersedesIndex).toBeUndefined();
        expect(conflict).toMatchObject({ status: 'conflict', conflictsWithIndex: 2 });
    });

    it('downgrades a conflict that does not name its counterpart', () => {
        // Most stored conflicts were scope differences the model could not pin
        // to a specific claim; each one put a ⚠ in front of users.
        for (const bad of [undefined, -1, 1.5, 'E0', null]) {
            const r = normalizeConsistencyResult({
                status: 'conflict',
                claimIndex: 0,
                conflictsWithIndex: bad as unknown as number,
                reason: 'different issuer'
            });
            expect(r.status, `input ${JSON.stringify(bad)}`).toBe('unique');
            expect(r.conflictsWithIndex).toBeUndefined();
            expect(r.reason).toContain('different issuer');
        }
    });

    it('keeps a conflict with a numeric-string counterpart', () => {
        const r = normalizeConsistencyResult({ status: 'conflict', claimIndex: 0, conflictsWithIndex: '0' as unknown as number });
        expect(r).toMatchObject({ status: 'conflict', conflictsWithIndex: 0 });
    });

    it('drops a conflict counterpart from non-conflict verdicts', () => {
        const r = normalizeConsistencyResult({ status: 'update', claimIndex: 0, supersedesIndex: 1, conflictsWithIndex: 2 });
        expect(r.conflictsWithIndex).toBeUndefined();
        expect(r.supersedesIndex).toBe(1);
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
