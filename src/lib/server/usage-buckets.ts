/**
 * Pure helpers for the token-usage report: categories, span/resolution choice,
 * local-time bucketing, and series assembly.
 *
 * Split out of ./usage — which owns the database writes and reads — so this
 * logic can be unit tested without opening a SQLite connection and loading the
 * vector extension as a side effect of the import. Same reason ./fts-query and
 * ./retrieval-probe exist as separate modules.
 *
 * The bucketing here is the part most worth testing directly: it has to agree
 * exactly with the keys the SQL GROUP BY produces, and a disagreement does not
 * throw — it silently yields an all-zero chart.
 */

export type UsageCategory = 'chat' | 'documents' | 'knowledge' | 'market' | 'other';

/** Stable order used by the API response and the dashboard's stacked chart. */
export const USAGE_CATEGORIES: readonly UsageCategory[] = [
    'chat',
    'documents',
    'knowledge',
    'market',
    'other'
] as const;

/** Human-readable labels, kept server-side so the API is self-describing. */
export const USAGE_CATEGORY_LABELS: Record<UsageCategory, string> = {
    chat: 'Chat',
    documents: 'Document processing',
    knowledge: 'Knowledge base',
    market: 'Market research',
    other: 'Other'
};

/** What kind of provider primitive produced a usage row. */
export type UsageKind = 'generate' | 'stream' | 'embed' | 'rerank';

// ── Token estimation ────────────────────────────────────────────────────────
// Used only where the provider reports nothing (see the `estimated` column).
// 3.5 chars/token is a deliberate compromise: English averages closer to 4, but
// this corpus is largely Czech, which tokenizes at roughly 2.5–3.5 chars/token
// under the BPE vocabularies these models use. Estimated rows are flagged so the
// dashboard can report how much of a total is approximate rather than presenting
// a guess as a measurement.
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string | null | undefined): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── Adaptive-resolution spans ───────────────────────────────────────────────
//
// Each span gets the bucket size that keeps the point count in the range a chart
// can render legibly (~24–30 points). Charting 30 days hourly would be 720
// mostly-empty buckets; charting one day daily would be a single bar.

export type UsageSpan = '1d' | '7d' | '30d';
export type UsageResolution = 'hour' | '6hour' | 'day';

export interface SpanConfig {
    span: UsageSpan;
    resolution: UsageResolution;
    /** Width of one bucket in minutes. */
    bucketMinutes: number;
    /** Number of buckets in the series, including the in-progress current one. */
    points: number;
}

const SPAN_CONFIGS: Record<UsageSpan, SpanConfig> = {
    '1d': { span: '1d', resolution: 'hour', bucketMinutes: 60, points: 24 },
    '7d': { span: '7d', resolution: '6hour', bucketMinutes: 360, points: 28 },
    '30d': { span: '30d', resolution: 'day', bucketMinutes: 1440, points: 30 }
};

export const USAGE_SPANS: readonly UsageSpan[] = ['1d', '7d', '30d'] as const;

/**
 * Resolves a caller-supplied span string, defaulting to 7d for anything else.
 *
 * Membership is checked against the allowlist rather than by indexing
 * SPAN_CONFIGS and testing the result: `span` arrives straight from a URL query
 * parameter, and an inherited key like `__proto__` or `constructor` indexes to a
 * truthy value that no `??` fallback would catch. That produced a config with
 * `resolution`/`bucketMinutes` undefined, which does not throw — it yields NaN
 * bucket boundaries and an empty chart.
 */
export function resolveSpan(span: string | null | undefined): SpanConfig {
    return USAGE_SPANS.includes(span as UsageSpan) ? SPAN_CONFIGS[span as UsageSpan] : SPAN_CONFIGS['7d'];
}

/**
 * Clamps a client-supplied timezone offset to the real-world range.
 *
 * `tzOffsetMinutes` is minutes to ADD to UTC to get the viewer's local time
 * (i.e. `-new Date().getTimezoneOffset()`), which is the opposite sign to the JS
 * API and is chosen so it reads naturally as "+120 for CEST". It reaches SQL as
 * a datetime modifier, so it is validated to an integer inside ±14h.
 */
export function normalizeTzOffset(raw: string | number | null | undefined): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-840, Math.min(840, Math.round(n)));
}

export const MINUTE_MS = 60_000;

/**
 * Floors a *local wall-clock* timestamp to the start of its bucket.
 *
 * `localMs` is a UTC-shifted instant — an epoch value whose UTC calendar fields
 * spell out the viewer's local date and time. That trick is what lets bucket
 * boundaries land on local midnights (so a "day" is the viewer's day, not a UTC
 * day) using only UTC field accessors, with no timezone database.
 */
export function floorToBucket(localMs: number, resolution: UsageResolution): number {
    const d = new Date(localMs);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    if (resolution === 'day') return Date.UTC(y, m, day);
    const hour = d.getUTCHours();
    if (resolution === '6hour') return Date.UTC(y, m, day, Math.floor(hour / 6) * 6);
    return Date.UTC(y, m, day, hour);
}

/**
 * Formats a local wall-clock instant as a bucket key.
 *
 * The format matches SQLite's `datetime()` output exactly ('YYYY-MM-DD HH:MM:SS'),
 * because these keys are joined against the ones the SQL GROUP BY produces.
 */
export function bucketKey(localMs: number): string {
    const d = new Date(localMs);
    const p = (n: number) => String(n).padStart(2, '0');
    return (
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
        `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    );
}

/**
 * Builds the complete, gap-free list of local bucket start instants for a span,
 * oldest first and ending with the bucket that `nowMs` falls in.
 *
 * Generated here rather than left to the query so that buckets with no activity
 * still appear: a chart that omits idle hours misrepresents a quiet period as a
 * dense one.
 */
export function buildBuckets(config: SpanConfig, nowMs: number, tzOffsetMinutes: number): number[] {
    const localNow = nowMs + tzOffsetMinutes * MINUTE_MS;
    const last = floorToBucket(localNow, config.resolution);
    const width = config.bucketMinutes * MINUTE_MS;
    const buckets: number[] = [];
    for (let i = config.points - 1; i >= 0; i--) {
        buckets.push(last - i * width);
    }
    return buckets;
}

// ── Totals ──────────────────────────────────────────────────────────────────

export interface UsageTotals {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    calls: number;
    /** Tokens in this total that were estimated rather than provider-reported. */
    estimatedTokens: number;
}

export function emptyTotals(): UsageTotals {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, estimatedTokens: 0 };
}

export function addTotals(target: UsageTotals, row: UsageTotals): void {
    target.promptTokens += row.promptTokens;
    target.completionTokens += row.completionTokens;
    target.totalTokens += row.totalTokens;
    target.calls += row.calls;
    target.estimatedTokens += row.estimatedTokens;
}

export function emptyByCategory(): Record<UsageCategory, UsageTotals> {
    return {
        chat: emptyTotals(),
        documents: emptyTotals(),
        knowledge: emptyTotals(),
        market: emptyTotals(),
        other: emptyTotals()
    };
}

/**
 * Coerces a stored category string to a known category.
 *
 * Anything unrecognised folds into 'other' rather than being dropped: a row
 * written by an older or newer build of the app is still real spend, and losing
 * it would make the charted totals disagree with the database.
 */
export function toCategory(raw: unknown): UsageCategory {
    return (USAGE_CATEGORIES as readonly string[]).includes(String(raw))
        ? (raw as UsageCategory)
        : 'other';
}

export interface UsageSeriesPoint {
    /** Bucket start as a local wall-clock key, 'YYYY-MM-DD HH:MM:SS'. */
    bucket: string;
    /** Bucket start as a real UTC epoch ms, for axis formatting on the client. */
    startMs: number;
    byCategory: Record<UsageCategory, UsageTotals>;
    total: UsageTotals;
}

/**
 * Merges aggregated rows into the pre-built gap-free bucket list.
 *
 * Kept separate from the query because this is where the two halves of the
 * bucketing have to agree — the JS-generated keys and the SQL-generated ones.
 */
export function mergeSeries(
    buckets: number[],
    tzOffsetMinutes: number,
    rows: { bucket: string; category: string; totals: UsageTotals }[]
): UsageSeriesPoint[] {
    const byKey = new Map<string, UsageSeriesPoint>();
    const series: UsageSeriesPoint[] = buckets.map((localMs) => {
        const point: UsageSeriesPoint = {
            bucket: bucketKey(localMs),
            startMs: localMs - tzOffsetMinutes * MINUTE_MS,
            byCategory: emptyByCategory(),
            total: emptyTotals()
        };
        byKey.set(point.bucket, point);
        return point;
    });

    for (const row of rows) {
        const point = byKey.get(row.bucket);
        // A row outside the window can only mean the query range and the bucket
        // list disagreed; dropping it is correct — the bucket list IS the x-axis.
        if (!point) continue;
        const category = toCategory(row.category);
        addTotals(point.byCategory[category], row.totals);
        addTotals(point.total, row.totals);
    }

    return series;
}
