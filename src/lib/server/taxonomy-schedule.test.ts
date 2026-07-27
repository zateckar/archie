import { describe, it, expect } from 'vitest';
import {
    DEFAULT_FULL_REBUILD_INTERVAL_MS,
    MIN_FULL_REBUILD_INTERVAL_MS,
    isFullRebuildDue,
    nextFullRebuildDueAt,
    parseFullRebuildInterval,
    resolveFullRebuildInterval,
    validateFullRebuildInterval
} from './taxonomy-schedule';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000; // fixed so nothing here depends on the wall clock

describe('parseFullRebuildInterval', () => {
    it('falls back to the default when the operator expressed no opinion', () => {
        expect(parseFullRebuildInterval(undefined)).toBe(DEFAULT_FULL_REBUILD_INTERVAL_MS);
        expect(parseFullRebuildInterval(null)).toBe(DEFAULT_FULL_REBUILD_INTERVAL_MS);
        expect(parseFullRebuildInterval('')).toBe(DEFAULT_FULL_REBUILD_INTERVAL_MS);
        expect(parseFullRebuildInterval('   ')).toBe(DEFAULT_FULL_REBUILD_INTERVAL_MS);
        expect(parseFullRebuildInterval('weekly')).toBe(DEFAULT_FULL_REBUILD_INTERVAL_MS);
    });

    it('accepts an explicit interval', () => {
        expect(parseFullRebuildInterval(String(3 * DAY))).toBe(3 * DAY);
        expect(parseFullRebuildInterval('60000')).toBe(60000);
    });

    it('treats 0 and negatives as OFF, not as absent', () => {
        // The `Number(env) || DEFAULT` idiom used elsewhere in the codebase would
        // silently re-enable weekly rebuilds here. That is the bug this covers.
        expect(parseFullRebuildInterval('0')).toBe(0);
        expect(parseFullRebuildInterval('-1')).toBe(0);
    });
});

describe('isFullRebuildDue', () => {
    it('never fires when the schedule is disabled', () => {
        expect(isFullRebuildDue(null, NOW, 0)).toBe(false);
        expect(isFullRebuildDue(NOW - 365 * DAY, NOW, 0)).toBe(false);
        expect(isFullRebuildDue(NOW - 365 * DAY, NOW, -1)).toBe(false);
        expect(isFullRebuildDue(NOW - 365 * DAY, NOW, Number.NaN)).toBe(false);
    });

    it('fires when no rebuild was ever recorded', () => {
        // An existing deployment starts here, over a hierarchy built purely by
        // incremental placement — the corpus most in need of a corrective pass.
        expect(isFullRebuildDue(null, NOW, 7 * DAY)).toBe(true);
    });

    it('waits out the interval, then fires', () => {
        expect(isFullRebuildDue(NOW - 6 * DAY, NOW, 7 * DAY)).toBe(false);
        expect(isFullRebuildDue(NOW - 7 * DAY + 1, NOW, 7 * DAY)).toBe(false);
        expect(isFullRebuildDue(NOW - 7 * DAY, NOW, 7 * DAY)).toBe(true);
        expect(isFullRebuildDue(NOW - 30 * DAY, NOW, 7 * DAY)).toBe(true);
    });

    it('does not park the schedule on a future stamp', () => {
        // A backwards clock step or a hand-edited row should cost one extra
        // rebuild, not suspend rebuilds until real time catches up.
        expect(isFullRebuildDue(NOW + HOUR, NOW, 7 * DAY)).toBe(true);
        expect(isFullRebuildDue(NOW + 365 * DAY, NOW, 7 * DAY)).toBe(true);
    });

    it('does not fire twice for one due window', () => {
        // The realistic sequence: due, rebuild stamps `now`, next sync an hour later.
        expect(isFullRebuildDue(NOW - 8 * DAY, NOW, 7 * DAY)).toBe(true);
        expect(isFullRebuildDue(NOW, NOW + HOUR, 7 * DAY)).toBe(false);
    });
});

describe('resolveFullRebuildInterval', () => {
    it('lets an admin override beat the environment', () => {
        expect(resolveFullRebuildInterval(3 * DAY, String(7 * DAY))).toEqual({
            intervalMs: 3 * DAY,
            source: 'ui'
        });
    });

    it('reads a stored 0 — and a stored negative — as OFF', () => {
        expect(resolveFullRebuildInterval(0, String(7 * DAY))).toEqual({ intervalMs: 0, source: 'ui' });
        expect(resolveFullRebuildInterval(-5, null)).toEqual({ intervalMs: 0, source: 'ui' });
    });

    it('falls through to the environment when there is no override', () => {
        expect(resolveFullRebuildInterval(null, String(2 * DAY))).toEqual({
            intervalMs: 2 * DAY,
            source: 'env'
        });
        expect(resolveFullRebuildInterval(null, '0')).toEqual({ intervalMs: 0, source: 'env' });
    });

    it('reports "default", not "env", when the env value decided nothing', () => {
        // Attributing the default to a variable that did not produce it is how an
        // operator ends up debugging a working env var.
        for (const raw of [undefined, null, '', '   ', 'weekly']) {
            expect(resolveFullRebuildInterval(null, raw)).toEqual({
                intervalMs: DEFAULT_FULL_REBUILD_INTERVAL_MS,
                source: 'default'
            });
        }
    });
});

describe('validateFullRebuildInterval', () => {
    it('accepts 0 as an explicit off switch', () => {
        expect(validateFullRebuildInterval(0)).toEqual({ ok: true, intervalMs: 0 });
    });

    it('accepts the floor and anything above it, rounding fractions', () => {
        expect(validateFullRebuildInterval(MIN_FULL_REBUILD_INTERVAL_MS)).toEqual({
            ok: true,
            intervalMs: MIN_FULL_REBUILD_INTERVAL_MS
        });
        expect(validateFullRebuildInterval(7 * DAY + 0.4)).toEqual({ ok: true, intervalMs: 7 * DAY });
    });

    it('rejects an interval short enough to rebuild on every sync', () => {
        // The whole point of the floor: repos sync hourly, so a sub-hour interval
        // means "rebuild every time anything changes" — the runaway this replaced.
        const tooShort = validateFullRebuildInterval(MIN_FULL_REBUILD_INTERVAL_MS - 1);
        expect(tooShort.ok).toBe(false);
        expect(tooShort.ok === false && tooShort.error).toMatch(/at least/);
    });

    it('rejects negatives and non-numbers with a reason', () => {
        for (const bad of [-1, '604800000', null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
            const result = validateFullRebuildInterval(bad);
            expect(result.ok).toBe(false);
            expect(result.ok === false && result.error.length).toBeGreaterThan(0);
        }
    });
});

describe('nextFullRebuildDueAt', () => {
    it('is last + interval once something has been rebuilt', () => {
        expect(nextFullRebuildDueAt(NOW, 7 * DAY)).toBe(NOW + 7 * DAY);
    });

    it('has no answer when disabled or never run', () => {
        expect(nextFullRebuildDueAt(NOW, 0)).toBeNull();
        expect(nextFullRebuildDueAt(null, 7 * DAY)).toBeNull();
    });
});
