/**
 * When the corpus-wide taxonomy is due for a full rebuild.
 *
 * ── Why there is a schedule at all ──────────────────────────────────────────
 * Day-to-day hierarchy maintenance is incremental: `placeTaxonomyForNewTopics`
 * attaches each newly extracted topic to the tree that already exists, one
 * ingestion at a time. That is the cheap and correct default, but it is also
 * strictly local — it never revisits a placement made earlier, so it cannot
 * notice that fifteen siblings have accumulated under a parent that should now
 * be split, or that an early topic was filed under the only plausible parent
 * available at the time and a better one has since appeared. The hierarchy drifts
 * toward whatever order the documents happened to arrive in.
 *
 * `rebuildTaxonomy` is the corrective: it re-derives every parent from the full
 * topic set at once. It is also the expensive one — every topic goes back to the
 * model in batches — which is exactly why it must not run per sync (it used to,
 * on an hourly timer, which is what made it the app's largest token line item).
 *
 * So: incremental always, full occasionally, on a clock.
 *
 * ── Kept pure ───────────────────────────────────────────────────────────────
 * These functions take the interval, the last-run stamp and "now" as arguments
 * rather than reading env, the database or the system clock, so every branch
 * below — disabled, never-run, not-yet-due, due, bogus-future-stamp — is
 * reachable in a test without a corpus. The impure half (reading
 * TAXONOMY_FULL_REBUILD_INTERVAL_MS, loading and stamping app_state) lives in
 * ./knowledge next to the rebuild it guards.
 */

/** app_state key holding the epoch-ms timestamp of the last completed full rebuild. */
export const TAXONOMY_FULL_REBUILD_KEY = 'taxonomy_full_rebuild_at';

/** app_state key holding the admin-set interval override, in ms. Absent = follow env. */
export const TAXONOMY_FULL_REBUILD_INTERVAL_KEY = 'taxonomy_full_rebuild_interval_ms';

/** Seven days. Slow enough to be a rounding error against ingestion, often enough to bound drift. */
export const DEFAULT_FULL_REBUILD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Floor for an admin-set interval: one hour.
 *
 * Not arbitrary caution. Repos sync hourly by default, and a rebuild sends every
 * topic back to the model — an interval below the sync period means "rebuild on
 * every sync that changed anything", which is a slider's-width away from the
 * runaway spend this whole schedule exists to prevent (433 calls / 13M tokens a
 * day on an idle corpus). `0` remains available as an explicit, unambiguous OFF.
 *
 * Deliberately NOT applied to the env var: an operator editing deployment config
 * is not clicking a control by accident, and silently rewriting a value they set
 * by hand would be worse than honouring it.
 */
export const MIN_FULL_REBUILD_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Parses TAXONOMY_FULL_REBUILD_INTERVAL_MS.
 *
 * `0` (and any negative value) DISABLES the periodic rebuild — which is why this
 * is not the `Number(env) || DEFAULT` idiom used elsewhere in the codebase: that
 * form treats an explicit `0` as absent and silently re-enables the very thing
 * the operator just switched off. Unset, empty and unparseable all fall back to
 * the default, since those are "no opinion", not "off".
 */
export function parseFullRebuildInterval(
    raw: string | undefined | null,
    fallbackMs: number = DEFAULT_FULL_REBUILD_INTERVAL_MS
): number {
    if (raw === undefined || raw === null || raw.trim() === '') return fallbackMs;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallbackMs;
    return n <= 0 ? 0 : n;
}

/**
 * Whether a full rebuild is due.
 *
 * `lastRunMs === null` (never recorded) counts as DUE on purpose. On an existing
 * deployment the column starts empty over a hierarchy that has been maintained
 * incrementally for as long as it has existed, so that corpus is the one most in
 * need of a corrective pass — and answering "not due" would mean it never gets
 * one. The cost is bounded: one rebuild, on the first sync that changes
 * something, after which the stamp starts the clock.
 *
 * A stamp in the future is also treated as due. That means a clock stepping
 * backwards, or a hand-edited row, costs one extra rebuild instead of parking
 * the schedule until real time catches up — which for a far-future value is
 * indistinguishable from disabling it.
 */
export function isFullRebuildDue(lastRunMs: number | null, nowMs: number, intervalMs: number): boolean {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false; // explicitly disabled
    if (lastRunMs === null) return true; // never run — see above
    if (lastRunMs > nowMs) return true; // bogus/future stamp
    return nowMs - lastRunMs >= intervalMs;
}

/** Where the interval currently in force came from, so the UI can say so. */
export type IntervalSource = 'ui' | 'env' | 'default';

/**
 * The interval actually in force, and where it came from.
 *
 * Precedence is admin override → environment → built-in default. The override
 * wins over env on purpose: the env var states the deployment's intent, and an
 * admin changing the schedule in the UI is a later, more specific decision by
 * someone who can see the corpus. Reporting the source is what keeps that honest
 * — an operator who set the env var and sees `ui` knows why it isn't taking
 * effect, instead of concluding the var is broken.
 *
 * `overrideMs` is what app_state holds (null when never set). A stored negative
 * is read as OFF rather than rejected: the value is already persisted by the time
 * anyone reads it, so the only choice left is how to interpret it, and treating
 * "someone wrote a nonsense interval" as "don't run automatically" fails toward
 * spending nothing.
 */
export function resolveFullRebuildInterval(
    overrideMs: number | null,
    envRaw: string | undefined | null
): { intervalMs: number; source: IntervalSource } {
    if (overrideMs !== null && Number.isFinite(overrideMs)) {
        return { intervalMs: overrideMs <= 0 ? 0 : overrideMs, source: 'ui' };
    }
    // An env value that is absent, blank or unparseable did not decide anything —
    // parseFullRebuildInterval fell back to the default — so it is reported as
    // 'default'. Otherwise an operator would see 'env' next to a number their env
    // var demonstrably did not produce.
    const envSet = envRaw !== undefined && envRaw !== null && envRaw.trim() !== '';
    const envUsable = envSet && Number.isFinite(Number(envRaw));
    return { intervalMs: parseFullRebuildInterval(envRaw), source: envUsable ? 'env' : 'default' };
}

/**
 * Validates an interval submitted from the UI.
 *
 * Returns a discriminated result rather than throwing, so the API route can turn
 * a bad value into a 400 with the reason the admin needs to see.
 */
export function validateFullRebuildInterval(
    value: unknown
): { ok: true; intervalMs: number } | { ok: false; error: string } {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: 'intervalMs must be a finite number of milliseconds' };
    }
    if (value < 0) {
        return { ok: false, error: 'intervalMs cannot be negative — use 0 to disable automatic rebuilds' };
    }
    const ms = Math.round(value);
    if (ms === 0) return { ok: true, intervalMs: 0 }; // explicit OFF
    if (ms < MIN_FULL_REBUILD_INTERVAL_MS) {
        return {
            ok: false,
            error: `intervalMs must be 0 (off) or at least ${MIN_FULL_REBUILD_INTERVAL_MS} ms (1 hour)`
        };
    }
    return { ok: true, intervalMs: ms };
}

/**
 * When the next automatic rebuild becomes possible, or null when there isn't a
 * meaningful answer: the schedule is off, or nothing has been rebuilt yet (in
 * which case it is due immediately — see isFullRebuildDue).
 *
 * "Possible", not "scheduled": nothing fires on a timer. The rebuild is evaluated
 * at the tail of a git sync that actually changed the corpus, so on a quiet repo
 * the real rebuild can land well after this timestamp.
 */
export function nextFullRebuildDueAt(
    lastRunMs: number | null,
    intervalMs: number
): number | null {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
    if (lastRunMs === null) return null;
    return lastRunMs + intervalMs;
}
