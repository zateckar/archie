import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db';
import {
    MINUTE_MS,
    USAGE_CATEGORIES,
    USAGE_CATEGORY_LABELS,
    addTotals,
    buildBuckets,
    emptyByCategory,
    emptyTotals,
    mergeSeries,
    normalizeTzOffset,
    resolveSpan,
    toCategory,
    type UsageCategory,
    type UsageKind,
    type UsageResolution,
    type UsageSeriesPoint,
    type UsageSpan,
    type UsageTotals
} from './usage-buckets';

/**
 * LLM token accounting.
 *
 * Every model call in this app goes through ./providers, which is the single
 * chokepoint where token counts can be captured. This module is the other half
 * of that: it says WHICH part of the system a call belongs to, writes the row,
 * and answers the dashboard's questions about the accumulated data. The pure
 * bucketing/aggregation helpers live in ./usage-buckets so they stay unit
 * testable without a database.
 *
 * ── Why an AsyncLocalStorage context ────────────────────────────────────────
 * The `operation` of a call (clean_document, extract_knowledge, chat_answer) is
 * known at the call site in llm.ts and is passed explicitly. The `category` is
 * not: llm.ts helpers are shared across the whole app, so the same function is
 * one thing in one pipeline and another elsewhere. `getEmbedding` is the clear
 * case — it embeds a user's question during chat, a chunk during ingestion, and
 * a claim during knowledge extraction, and those are three different budgets.
 * Threading a category parameter through every layer between the API route and
 * the provider call would touch dozens of unrelated signatures and would silently
 * mis-attribute the moment a new caller forgot to pass it.
 *
 * So the category is ambient: each pipeline entry point wraps its work in
 * `withUsageCategory` / `inCategory`, and any provider call underneath — however
 * deep, and across awaits — is attributed to it. Nesting is intentional and the
 * innermost wrapper wins: `addDocument` runs as 'documents', and the
 * `processDocumentKnowledge` call inside it re-enters as 'knowledge', so the
 * clean/summarize/chunk/embed work and the graph-building work are separated even
 * though one calls the other.
 *
 * Calls that reach a provider with no context at all are recorded as 'other'
 * rather than dropped or guessed — an unattributed call is a real (and findable)
 * gap, not something to hide.
 */

export {
    USAGE_CATEGORIES,
    USAGE_CATEGORY_LABELS,
    USAGE_SPANS,
    CHARS_PER_TOKEN,
    estimateTokens,
    resolveSpan,
    normalizeTzOffset,
    floorToBucket,
    bucketKey,
    buildBuckets,
    mergeSeries
} from './usage-buckets';
export type {
    UsageCategory,
    UsageKind,
    UsageResolution,
    UsageSeriesPoint,
    UsageSpan,
    UsageTotals,
    SpanConfig
} from './usage-buckets';

interface UsageContext {
    category: UsageCategory;
}

const contextStore = new AsyncLocalStorage<UsageContext>();

/**
 * Runs `fn` with every provider call underneath attributed to `category`.
 *
 * Returns whatever `fn` returns (including a promise), so this wraps an async
 * function body without changing its signature. Safe to nest — the innermost
 * wrapper wins.
 */
export function withUsageCategory<T>(category: UsageCategory, fn: () => T): T {
    return contextStore.run({ category }, fn);
}

/** The category in effect for the current async context, or 'other'. */
export function currentUsageCategory(): UsageCategory {
    return contextStore.getStore()?.category ?? 'other';
}

/**
 * Wraps a function so every call runs under `category`, preserving its exact
 * signature.
 *
 * Used to attribute a pipeline at its DEFINITION rather than at each caller,
 * which is the property that keeps the accounting honest: `addDocument` has four
 * callers (upload, git sync, wiki save, wiki revert) and `recomputeCommunities`
 * has three, so attributing per-caller would need every one of them to remember —
 * and a caller added later would silently land in 'other'. Attributing at the
 * definition makes that impossible.
 *
 * Written as a wrapper rather than by indenting each function body inside
 * `withUsageCategory` purely to keep the diff readable.
 */
export function inCategory<F extends (...args: never[]) => unknown>(
    category: UsageCategory,
    fn: F
): F {
    return ((...args: Parameters<F>) =>
        withUsageCategory(category, () => fn(...(args as never[])))) as unknown as F;
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface UsageRecord {
    /** Fine-grained task label, e.g. 'clean_document'. Set at the llm.ts call site. */
    operation: string;
    provider: 'litellm' | 'gemini';
    model: string;
    kind: UsageKind;
    promptTokens: number;
    completionTokens: number;
    /** Defaults to prompt + completion when the provider didn't report a total. */
    totalTokens?: number;
    /** True when counts were derived from character length, not reported. */
    estimated?: boolean;
    durationMs?: number;
    /** True when the call errored — the input tokens were still spent. */
    failed?: boolean;
    /** Overrides the ambient category. Only for callers outside any pipeline. */
    category?: UsageCategory;
}

let insertStmt: import('better-sqlite3').Statement | null = null;

/**
 * Writes one usage row. Never throws: token accounting is observability, and a
 * failure to record must not take down the request whose cost it was measuring.
 */
export function recordUsage(record: UsageRecord): void {
    try {
        if (!insertStmt) {
            insertStmt = db.prepare(`
                INSERT INTO token_usage
                    (category, operation, provider, model, kind,
                     prompt_tokens, completion_tokens, total_tokens,
                     estimated, duration_ms, failed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
        }
        const prompt = Math.max(0, Math.round(record.promptTokens || 0));
        const completion = Math.max(0, Math.round(record.completionTokens || 0));
        const total = Math.max(0, Math.round(record.totalTokens ?? prompt + completion));

        insertStmt.run(
            record.category ?? currentUsageCategory(),
            record.operation,
            record.provider,
            record.model,
            record.kind,
            prompt,
            completion,
            total,
            record.estimated ? 1 : 0,
            record.durationMs === undefined ? null : Math.max(0, Math.round(record.durationMs)),
            record.failed ? 1 : 0
        );
    } catch (e) {
        console.error('[Usage] Failed to record token usage:', e);
    }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** SQL expression flooring `created_at` to a bucket key in the viewer's local time. */
function bucketSqlExpr(resolution: UsageResolution): string {
    // `local` shifts the stored UTC timestamp by the bound tz modifier. The
    // 6-hour case has no strftime equivalent, so the hour is divided down and
    // re-padded by hand. Output format matches ./usage-buckets bucketKey().
    const local = `datetime(created_at, ?)`;
    if (resolution === 'day') return `strftime('%Y-%m-%d 00:00:00', ${local})`;
    if (resolution === 'hour') return `strftime('%Y-%m-%d %H:00:00', ${local})`;
    return (
        `strftime('%Y-%m-%d ', ${local}) || ` +
        `printf('%02d:00:00', (CAST(strftime('%H', ${local}) AS INTEGER) / 6) * 6)`
    );
}

const TOTALS_SELECT = `
    COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
    COALESCE(SUM(completion_tokens), 0) AS completionTokens,
    COALESCE(SUM(total_tokens), 0)      AS totalTokens,
    COUNT(*)                            AS calls,
    COALESCE(SUM(CASE WHEN estimated = 1 THEN total_tokens ELSE 0 END), 0) AS estimatedTokens
`;

function rowToTotals(row: Record<string, unknown> | undefined): UsageTotals {
    if (!row) return emptyTotals();
    return {
        promptTokens: Number(row.promptTokens) || 0,
        completionTokens: Number(row.completionTokens) || 0,
        totalTokens: Number(row.totalTokens) || 0,
        calls: Number(row.calls) || 0,
        estimatedTokens: Number(row.estimatedTokens) || 0
    };
}

export interface OperationBreakdown {
    operation: string;
    category: UsageCategory;
    totals: UsageTotals;
}

export interface ModelBreakdown {
    provider: string;
    model: string;
    kind: string;
    totals: UsageTotals;
}

export interface UsageReport {
    span: UsageSpan;
    resolution: UsageResolution;
    bucketMinutes: number;
    tzOffsetMinutes: number;
    /** Inclusive UTC start of the charted window, 'YYYY-MM-DD HH:MM:SS'. */
    from: string;
    generatedAt: string;
    series: UsageSeriesPoint[];
    /** Totals over the charted window only. */
    window: {
        byCategory: Record<UsageCategory, UsageTotals>;
        total: UsageTotals;
        byOperation: OperationBreakdown[];
    };
    /** All-time totals, independent of the selected span. */
    cumulative: {
        byCategory: Record<UsageCategory, UsageTotals>;
        total: UsageTotals;
        byOperation: OperationBreakdown[];
        byModel: ModelBreakdown[];
        failedCalls: number;
        firstRecordedAt: string | null;
        lastRecordedAt: string | null;
    };
    categoryLabels: Record<UsageCategory, string>;
}

/** Formats a UTC epoch ms as SQLite's datetime string, for range comparison. */
function toSqlUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Everything the admin usage dashboard renders, in one round trip: the
 * adaptive-resolution stacked series for the selected span, that window's
 * per-category and per-operation totals, and the all-time cumulative figures.
 *
 * `nowMs` is injectable so tests can pin the window.
 */
export function buildUsageReport(
    spanInput: string | null | undefined,
    tzOffsetInput: string | number | null | undefined,
    nowMs: number = Date.now()
): UsageReport {
    const config = resolveSpan(spanInput);
    const tzOffsetMinutes = normalizeTzOffset(tzOffsetInput);
    const tzModifier = `${tzOffsetMinutes >= 0 ? '+' : '-'}${Math.abs(tzOffsetMinutes)} minutes`;

    const buckets = buildBuckets(config, nowMs, tzOffsetMinutes);
    // The window starts at the first bucket's boundary, converted back to real
    // UTC — anything earlier has no bucket to land in.
    const fromUtc = toSqlUtc(buckets[0] - tzOffsetMinutes * MINUTE_MS);

    const bucketExpr = bucketSqlExpr(config.resolution);
    // The 6-hour expression mentions the local datetime three times, so the tz
    // modifier is bound once per occurrence.
    const tzParams = Array<string>((bucketExpr.match(/\?/g) ?? []).length).fill(tzModifier);

    const seriesRows = db
        .prepare(
            `SELECT ${bucketExpr} AS bucket, category, ${TOTALS_SELECT}
             FROM token_usage
             WHERE created_at >= ?
             GROUP BY bucket, category`
        )
        .all(...tzParams, fromUtc) as Record<string, unknown>[];

    const series = mergeSeries(
        buckets,
        tzOffsetMinutes,
        seriesRows.map((r) => ({
            bucket: String(r.bucket),
            category: String(r.category),
            totals: rowToTotals(r)
        }))
    );

    // Window totals are summed from the series rather than re-queried, so the
    // headline numbers can never disagree with the chart above them.
    const windowByCategory = emptyByCategory();
    const windowTotal = emptyTotals();
    for (const point of series) {
        for (const category of USAGE_CATEGORIES) {
            addTotals(windowByCategory[category], point.byCategory[category]);
        }
        addTotals(windowTotal, point.total);
    }

    const windowOperations = (
        db
            .prepare(
                `SELECT operation, category, ${TOTALS_SELECT}
                 FROM token_usage WHERE created_at >= ?
                 GROUP BY operation, category
                 ORDER BY totalTokens DESC`
            )
            .all(fromUtc) as Record<string, unknown>[]
    ).map((r) => ({
        operation: String(r.operation),
        category: toCategory(r.category),
        totals: rowToTotals(r)
    }));

    const cumulativeByCategory = emptyByCategory();
    const cumulativeTotal = emptyTotals();
    for (const row of db
        .prepare(`SELECT category, ${TOTALS_SELECT} FROM token_usage GROUP BY category`)
        .all() as Record<string, unknown>[]) {
        const totals = rowToTotals(row);
        addTotals(cumulativeByCategory[toCategory(row.category)], totals);
        addTotals(cumulativeTotal, totals);
    }

    const cumulativeOperations = (
        db
            .prepare(
                `SELECT operation, category, ${TOTALS_SELECT}
                 FROM token_usage GROUP BY operation, category ORDER BY totalTokens DESC`
            )
            .all() as Record<string, unknown>[]
    ).map((r) => ({
        operation: String(r.operation),
        category: toCategory(r.category),
        totals: rowToTotals(r)
    }));

    const cumulativeModels = (
        db
            .prepare(
                `SELECT provider, model, kind, ${TOTALS_SELECT}
                 FROM token_usage GROUP BY provider, model, kind ORDER BY totalTokens DESC`
            )
            .all() as Record<string, unknown>[]
    ).map((r) => ({
        provider: String(r.provider),
        model: String(r.model),
        kind: String(r.kind),
        totals: rowToTotals(r)
    }));

    const bounds = db
        .prepare(
            `SELECT MIN(created_at) AS first, MAX(created_at) AS last,
                    COALESCE(SUM(failed), 0) AS failedCalls
             FROM token_usage`
        )
        .get() as { first: string | null; last: string | null; failedCalls: number } | undefined;

    return {
        span: config.span,
        resolution: config.resolution,
        bucketMinutes: config.bucketMinutes,
        tzOffsetMinutes,
        from: fromUtc,
        generatedAt: toSqlUtc(nowMs),
        series,
        window: {
            byCategory: windowByCategory,
            total: windowTotal,
            byOperation: windowOperations
        },
        cumulative: {
            byCategory: cumulativeByCategory,
            total: cumulativeTotal,
            byOperation: cumulativeOperations,
            byModel: cumulativeModels,
            failedCalls: Number(bounds?.failedCalls) || 0,
            firstRecordedAt: bounds?.first ?? null,
            lastRecordedAt: bounds?.last ?? null
        },
        categoryLabels: USAGE_CATEGORY_LABELS
    };
}

/** All-time total token count. Cheap enough for the admin dashboard's stat tile. */
export function totalTokensAllTime(): number {
    try {
        const row = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) AS total FROM token_usage').get() as
            | { total: number }
            | undefined;
        return Number(row?.total) || 0;
    } catch {
        return 0;
    }
}
