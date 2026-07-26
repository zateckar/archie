import { describe, it, expect } from 'vitest';
import {
    bucketKey,
    buildBuckets,
    emptyTotals,
    estimateTokens,
    floorToBucket,
    mergeSeries,
    normalizeTzOffset,
    resolveSpan,
    toCategory,
    type UsageTotals
} from './usage-buckets';

/** Convenience: a totals row with a distinguishable token count. */
function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
    return { ...emptyTotals(), ...overrides };
}

describe('resolveSpan', () => {
    it('maps each span to a resolution that keeps the point count chartable', () => {
        // The invariant that matters: no span produces a single bar or hundreds of
        // near-empty buckets. Everything lands in the 24-30 point range.
        for (const span of ['1d', '7d', '30d'] as const) {
            const config = resolveSpan(span);
            expect(config.span).toBe(span);
            expect(config.points).toBeGreaterThanOrEqual(24);
            expect(config.points).toBeLessThanOrEqual(30);
        }
    });

    it('covers the requested span with points × bucket width', () => {
        expect(resolveSpan('1d').points * resolveSpan('1d').bucketMinutes).toBe(24 * 60);
        expect(resolveSpan('7d').points * resolveSpan('7d').bucketMinutes).toBe(7 * 24 * 60);
        expect(resolveSpan('30d').points * resolveSpan('30d').bucketMinutes).toBe(30 * 24 * 60);
    });

    it('falls back to 7d for missing or unrecognised input', () => {
        // Reached straight from a URL query param, so junk must not throw or
        // produce a zero-point series.
        expect(resolveSpan(null).span).toBe('7d');
        expect(resolveSpan(undefined).span).toBe('7d');
        expect(resolveSpan('').span).toBe('7d');
        expect(resolveSpan('all-time').span).toBe('7d');
        expect(resolveSpan('__proto__').span).toBe('7d');
    });
});

describe('normalizeTzOffset', () => {
    it('accepts the offsets a browser actually sends', () => {
        expect(normalizeTzOffset(120)).toBe(120); // CEST
        expect(normalizeTzOffset('60')).toBe(60); // CET
        expect(normalizeTzOffset('-480')).toBe(-480); // PST
        expect(normalizeTzOffset(0)).toBe(0);
    });

    it('defaults to UTC for anything unparseable', () => {
        expect(normalizeTzOffset(null)).toBe(0);
        expect(normalizeTzOffset(undefined)).toBe(0);
        expect(normalizeTzOffset('not-a-number')).toBe(0);
        expect(normalizeTzOffset(Number.NaN)).toBe(0);
    });

    it('clamps and integerises, because this value reaches SQL as a datetime modifier', () => {
        expect(normalizeTzOffset(99999)).toBe(840);
        expect(normalizeTzOffset(-99999)).toBe(-840);
        expect(normalizeTzOffset(90.7)).toBe(91);
    });
});

describe('floorToBucket', () => {
    // 2026-07-26 13:37:45 UTC, read as local wall-clock fields.
    const t = Date.UTC(2026, 6, 26, 13, 37, 45, 123);

    it('floors to the hour', () => {
        expect(floorToBucket(t, 'hour')).toBe(Date.UTC(2026, 6, 26, 13));
    });

    it('floors to a 6-hour boundary', () => {
        expect(floorToBucket(t, '6hour')).toBe(Date.UTC(2026, 6, 26, 12));
        expect(floorToBucket(Date.UTC(2026, 6, 26, 5, 59), '6hour')).toBe(Date.UTC(2026, 6, 26, 0));
        expect(floorToBucket(Date.UTC(2026, 6, 26, 18, 1), '6hour')).toBe(Date.UTC(2026, 6, 26, 18));
        expect(floorToBucket(Date.UTC(2026, 6, 26, 23, 59), '6hour')).toBe(Date.UTC(2026, 6, 26, 18));
    });

    it('floors to the day', () => {
        expect(floorToBucket(t, 'day')).toBe(Date.UTC(2026, 6, 26));
    });

    it('is idempotent — flooring a boundary leaves it alone', () => {
        for (const resolution of ['hour', '6hour', 'day'] as const) {
            const once = floorToBucket(t, resolution);
            expect(floorToBucket(once, resolution)).toBe(once);
        }
    });
});

describe('bucketKey', () => {
    it("matches SQLite's datetime() output format", () => {
        expect(bucketKey(Date.UTC(2026, 6, 26, 13))).toBe('2026-07-26 13:00:00');
    });

    it('zero-pads single-digit months, days and hours', () => {
        // Unpadded output here would not join against the SQL keys, which silently
        // produces an all-zero chart rather than an error.
        expect(bucketKey(Date.UTC(2026, 0, 5, 4))).toBe('2026-01-05 04:00:00');
    });
});

describe('buildBuckets', () => {
    const tz = 120; // CEST
    // 2026-07-26 13:37 UTC == 15:37 local
    const now = Date.UTC(2026, 6, 26, 13, 37);

    it('returns exactly the configured number of points, oldest first', () => {
        const buckets = buildBuckets(resolveSpan('1d'), now, tz);
        expect(buckets).toHaveLength(24);
        expect(buckets[0]).toBeLessThan(buckets[23]);
    });

    it('ends with the bucket containing "now", floored in LOCAL time', () => {
        const buckets = buildBuckets(resolveSpan('1d'), now, tz);
        // Local time is 15:37, so the current hourly bucket is local 15:00 — not
        // the UTC 13:00 bucket. Getting this wrong shifts the whole chart.
        expect(bucketKey(buckets[buckets.length - 1])).toBe('2026-07-26 15:00:00');
    });

    it('puts daily boundaries on the viewer\'s midnight, not UTC midnight', () => {
        // 23:30 UTC on the 25th is already 01:30 local on the 26th.
        const lateNight = Date.UTC(2026, 6, 25, 23, 30);
        const buckets = buildBuckets(resolveSpan('30d'), lateNight, tz);
        expect(bucketKey(buckets[buckets.length - 1])).toBe('2026-07-26 00:00:00');
    });

    it('spaces buckets evenly by the configured width', () => {
        const config = resolveSpan('7d');
        const buckets = buildBuckets(config, now, tz);
        for (let i = 1; i < buckets.length; i++) {
            expect(buckets[i] - buckets[i - 1]).toBe(config.bucketMinutes * 60_000);
        }
    });

    it('handles negative offsets', () => {
        // 13:37 UTC is 05:37 in PST (-480).
        const buckets = buildBuckets(resolveSpan('1d'), now, -480);
        expect(bucketKey(buckets[buckets.length - 1])).toBe('2026-07-26 05:00:00');
    });
});

describe('mergeSeries', () => {
    const tz = 120;
    const now = Date.UTC(2026, 6, 26, 13, 37);
    const config = resolveSpan('1d');
    const buckets = buildBuckets(config, now, tz);
    const lastKey = bucketKey(buckets[buckets.length - 1]);

    it('emits a point for every bucket, including idle ones', () => {
        // A chart that omits idle hours misrepresents a quiet period as a dense one.
        const series = mergeSeries(buckets, tz, []);
        expect(series).toHaveLength(config.points);
        expect(series.every((p) => p.total.totalTokens === 0 && p.total.calls === 0)).toBe(true);
    });

    it('places a row in the bucket whose key it matches', () => {
        const series = mergeSeries(buckets, tz, [
            { bucket: lastKey, category: 'chat', totals: totals({ totalTokens: 500, calls: 2 }) }
        ]);
        const last = series[series.length - 1];
        expect(last.byCategory.chat.totalTokens).toBe(500);
        expect(last.byCategory.chat.calls).toBe(2);
        expect(last.byCategory.documents.totalTokens).toBe(0);
    });

    it('keeps categories separate and sums them into the bucket total', () => {
        const series = mergeSeries(buckets, tz, [
            { bucket: lastKey, category: 'chat', totals: totals({ totalTokens: 100, calls: 1 }) },
            { bucket: lastKey, category: 'documents', totals: totals({ totalTokens: 40, calls: 3 }) },
            { bucket: lastKey, category: 'knowledge', totals: totals({ totalTokens: 60, calls: 5 }) }
        ]);
        const last = series[series.length - 1];
        expect(last.byCategory.chat.totalTokens).toBe(100);
        expect(last.byCategory.documents.totalTokens).toBe(40);
        expect(last.byCategory.knowledge.totalTokens).toBe(60);
        expect(last.total.totalTokens).toBe(200);
        expect(last.total.calls).toBe(9);
    });

    it('folds an unknown category into "other" rather than dropping the spend', () => {
        // A row written by a different build of the app is still real spend;
        // discarding it would make the chart disagree with the database.
        const series = mergeSeries(buckets, tz, [
            { bucket: lastKey, category: 'legacy-pipeline', totals: totals({ totalTokens: 7, calls: 1 }) }
        ]);
        const last = series[series.length - 1];
        expect(last.byCategory.other.totalTokens).toBe(7);
        expect(last.total.totalTokens).toBe(7);
    });

    it('ignores rows outside the window instead of throwing', () => {
        const series = mergeSeries(buckets, tz, [
            { bucket: '1999-01-01 00:00:00', category: 'chat', totals: totals({ totalTokens: 999 }) }
        ]);
        expect(series.reduce((sum, p) => sum + p.total.totalTokens, 0)).toBe(0);
    });

    it('reports startMs as a real UTC instant, not the shifted local one', () => {
        // The client formats the axis from startMs, so it has to be a true epoch
        // value — otherwise labels are double-shifted by the browser's own tz.
        const series = mergeSeries(buckets, tz, []);
        const last = series[series.length - 1];
        expect(last.startMs).toBe(buckets[buckets.length - 1] - tz * 60_000);
        expect(new Date(last.startMs).toISOString()).toBe('2026-07-26T13:00:00.000Z');
    });
});

describe('toCategory', () => {
    it('passes through known categories', () => {
        expect(toCategory('chat')).toBe('chat');
        expect(toCategory('documents')).toBe('documents');
        expect(toCategory('knowledge')).toBe('knowledge');
        expect(toCategory('other')).toBe('other');
    });

    it('folds anything else into "other"', () => {
        expect(toCategory('nonsense')).toBe('other');
        expect(toCategory(null)).toBe('other');
        expect(toCategory(undefined)).toBe('other');
        expect(toCategory(42)).toBe('other');
    });
});

describe('estimateTokens', () => {
    it('returns 0 for empty input', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens(null)).toBe(0);
        expect(estimateTokens(undefined)).toBe(0);
    });

    it('scales with length and never returns a fraction', () => {
        const short = estimateTokens('a'.repeat(35));
        const long = estimateTokens('a'.repeat(350));
        expect(short).toBe(10);
        expect(long).toBe(100);
        expect(Number.isInteger(estimateTokens('abcde'))).toBe(true);
    });

    it('never estimates zero for non-empty text', () => {
        // A zero here would silently drop a real (if tiny) call from the totals.
        expect(estimateTokens('a')).toBeGreaterThan(0);
    });
});
