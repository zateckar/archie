/**
 * TurboQuant index lifecycle for sqlite-vector.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Every vector search in this app was a `vector_full_scan`: exact, and O(corpus)
 * per query with the whole embedding column read from disk. At 3072 dims that is
 * ~12KB per row, so the claims table alone (2163 rows) costs ~25MB of reads and
 * ~16ms per search — and there are three to five vector searches per chat turn.
 * That cost grows linearly and is what puts a ceiling on how much data the
 * corpus can hold.
 *
 * `vector_quantize_scan` searches a precomputed 4-bit TurboQuant structure
 * instead. Measured on this corpus (scripts/eval/quantization.ts, 40 query
 * vectors per table, cosine, k=5/10/20, query noise 0–0.5×RMS):
 *
 *   table              rows   recall@10   recall@20   exact top-1 kept   speedup
 *   chunks              445     97.5%       97.6%          100%           1.8×
 *   topics             1585     97.2%       98.0%          100%           3.2×
 *   knowledge_claims   2163     96.7%       98.4%          100%           3.0×
 *
 * qbits=4 is the operating point: qbits=2 drops recall@20 to ~93%, and qbits=3
 * has no SIMD path in this build (it measured *slower* than the exact scan).
 * The exact top hit survived every single query at qbits=4, which is the
 * property that matters most here — the retrieval pipeline over-fetches and
 * reranks, so it can absorb reordering inside the candidate set but not the best
 * match going missing. The speedup also grows with corpus size (1.8× at 445 rows,
 * 3.2× at 1585), which is the direction that matters.
 *
 * ── The staleness hazard this module exists to prevent ──────────────────────
 * `vector_quantize` persists its structure into a `vector0_<table>_<column>`
 * shadow table, so a scan can run against it with no quantize call in the
 * current process. That is a trap: rows embedded since the last quantize are
 * INVISIBLE to `vector_quantize_scan`, with no error and no warning — measured
 * directly (see the probe results recorded in the commit for this change: ten
 * rows identical to the query vector were absent from the quantized top-5 while
 * the exact scan ranked them 1st–4th). A quantized index that silently omits the
 * newest documents is worse than a slow one.
 *
 * So the rule here is: **never serve an approximate result from an index that
 * might be stale.** A table whose embeddings changed since its last quantize
 * falls back to the exact scan for that query and re-quantizes in the
 * background, debounced. Correctness degrades to "slower", never to "wrong".
 */
import { db } from './db';
import { storedDimension } from './embedding-dimension';

export type VectorTable = 'chunks' | 'topics' | 'knowledge_claims' | 'community_reports';

const QUANTIZATION_ENABLED = (process.env.VECTOR_QUANTIZATION ?? 'on').toLowerCase() !== 'off';

/**
 * TurboQuant precision. 4 is the measured sweet spot (see the table above);
 * exposed because a much larger corpus may prefer 2 bits to keep the structure
 * in RAM, and that trade is a deployment decision.
 */
const QBITS = Number(process.env.VECTOR_QBITS) || 4;

/**
 * Below this many embedded rows an exact scan already costs a couple of
 * milliseconds, and maintaining a quantized structure buys latency that nobody
 * can perceive while adding a way to be subtly wrong. Small corpora stay exact.
 */
const MIN_ROWS_FOR_QUANTIZATION = Number(process.env.VECTOR_QUANTIZE_MIN_ROWS) || 512;

/**
 * Memory budget handed to `vector_quantize`. The extension's own default is
 * 30MB, which at 3072 dims is exhausted somewhere around 20K rows — and a
 * partial quantization is precisely the silent-omission failure this module
 * guards against, so the budget is set explicitly and the row count returned by
 * `vector_quantize` is verified against the table below.
 */
const MAX_MEMORY = process.env.VECTOR_QUANTIZE_MAX_MEMORY || '256MB';

/**
 * How long to wait for embedding writes to settle before rebuilding. A git sync
 * ingests documents back to back, each writing chunk, topic and claim
 * embeddings; without debouncing, a 2000-row rebuild would run between every
 * one of them. Searches during the quiet-down window use the exact scan, so the
 * only cost of waiting is latency, never accuracy.
 */
const REQUANTIZE_DEBOUNCE_MS = Number(process.env.VECTOR_REQUANTIZE_DEBOUNCE_MS) || 3000;

interface IndexState {
    /**
     * Row count covered by the last `vector_quantize` this process ran, or null
     * if it has never run one. Starts null on purpose: a structure persisted by
     * an earlier process may describe any subset of the current rows, and there
     * is no way to ask the extension how fresh it is.
     */
    quantizedRows: number | null;
    /** An embedding write happened since the last successful quantize. */
    dirty: boolean;
    /** Quantization failed or came back short; stop trying on this table. */
    unusable: boolean;
    /** Debounce handle for the pending background rebuild. */
    timer: NodeJS.Timeout | null;
    lastQuantizeMs: number;
}

const state = new Map<VectorTable, IndexState>();

function stateFor(table: VectorTable): IndexState {
    let s = state.get(table);
    if (!s) {
        s = { quantizedRows: null, dirty: true, unusable: false, timer: null, lastQuantizeMs: 0 };
        state.set(table, s);
    }
    return s;
}

/**
 * `vector_quantize` requires a vector context on the column — it fails with
 * "Vector context not found … Ensure that vector_init() has been called" if the
 * connection has not initialised it yet.
 *
 * The search paths in rag.ts each call `vector_init` before scanning, but the
 * boot-time warm-up runs before any search, so this module has to establish the
 * context itself. Measured the hard way: without this, every warm-up quantize
 * failed and marked its table unusable, silently disabling quantization for the
 * life of the process.
 *
 * The dimension comes from the stored rows (same helper rag.ts uses), so this
 * cannot lock the index to a different dimension than the corpus.
 */
function ensureVectorContext(table: VectorTable): boolean {
    const dimension = storedDimension(table);
    if (dimension === null) return false; // nothing embedded yet — nothing to quantize
    try {
        db.prepare(`SELECT vector_init(?, 'embedding', ?)`).get(table, `dimension=${dimension},distance=cosine`);
    } catch {
        // Already initialised on this connection, which is the common case.
    }
    return true;
}

function embeddedRowCount(table: VectorTable): number {
    try {
        return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE embedding IS NOT NULL`).get() as { c: number }).c;
    } catch {
        // Table absent on an older DB (community_reports is created defensively).
        return 0;
    }
}

/**
 * Records that `table`'s embeddings changed, so the next search uses the exact
 * scan until the quantized structure has been rebuilt.
 *
 * Call this from every path that writes, clears or deletes an `embedding`. The
 * row-count check in `chooseScan` catches inserts and deletes on its own, but
 * NOT an in-place update — re-embedding a topic leaves the count identical while
 * changing the vector the structure was built from — so the explicit signal is
 * what makes those safe.
 */
export function markVectorIndexDirty(table: VectorTable): void {
    const s = stateFor(table);
    s.dirty = true;
    scheduleRequantize(table);
}

/** Marks every table dirty — for corpus-wide operations (see reembedAll). */
export function markAllVectorIndexesDirty(): void {
    for (const table of ['chunks', 'topics', 'knowledge_claims', 'community_reports'] as VectorTable[]) {
        markVectorIndexDirty(table);
    }
}

function scheduleRequantize(table: VectorTable): void {
    if (!QUANTIZATION_ENABLED) return;
    const s = stateFor(table);
    if (s.unusable) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
        s.timer = null;
        quantizeNow(table);
    }, REQUANTIZE_DEBOUNCE_MS);
    // The rebuild is an optimisation; it must never be the reason the process
    // stays alive (scripts/reembed.ts and the eval harness both exit on their own).
    s.timer.unref?.();
}

/**
 * Rebuilds the quantized structure for `table` synchronously. Safe to call at
 * any time; a no-op when quantization is off, the table is too small, or a
 * previous attempt marked it unusable.
 *
 * Exported so a script or admin action can force a rebuild rather than waiting
 * for the debounce.
 */
export function quantizeNow(table: VectorTable): { quantized: number; rows: number; ms: number } | null {
    if (!QUANTIZATION_ENABLED) return null;
    const s = stateFor(table);
    if (s.unusable) return null;

    const rows = embeddedRowCount(table);
    if (rows < MIN_ROWS_FOR_QUANTIZATION) {
        // Not an error: below the threshold the exact scan is the intended path.
        // Left dirty so a table that grows past the threshold gets picked up.
        return null;
    }

    // Not marked unusable when this fails: an absent context means "no embeddings
    // yet", a state the table can grow out of.
    if (!ensureVectorContext(table)) return null;

    const started = Date.now();
    let quantized: number;
    try {
        quantized = db
            .prepare(`SELECT vector_quantize(?, 'embedding', ?)`)
            .pluck()
            .get(table, `qtype=TURBO,qbits=${QBITS},max_memory=${MAX_MEMORY}`) as number;
    } catch (e) {
        s.unusable = true;
        console.warn(
            `[VectorIndex] vector_quantize failed on '${table}' (${(e as Error).message}). ` +
            `Falling back to exact vector_full_scan for this table.`
        );
        return null;
    }

    const ms = Date.now() - started;

    // A short count means the structure covers only part of the table, and a
    // scan against it would silently omit the remainder — the exact failure mode
    // this module exists to prevent. Refuse to use it rather than quietly
    // shrinking the searchable corpus.
    if (typeof quantized !== 'number' || quantized < rows) {
        s.unusable = true;
        console.warn(
            `[VectorIndex] vector_quantize('${table}') covered ${quantized} of ${rows} embedded row(s) — ` +
            `likely the ${MAX_MEMORY} budget (VECTOR_QUANTIZE_MAX_MEMORY). Using exact search for this table ` +
            `rather than an index that would silently omit rows.`
        );
        return null;
    }

    s.quantizedRows = quantized;
    s.dirty = false;
    s.lastQuantizeMs = ms;
    console.log(`[VectorIndex] Quantized ${quantized} row(s) of '${table}' (qbits=${QBITS}) in ${ms}ms.`);
    return { quantized, rows, ms };
}

export type ScanFunction = 'vector_full_scan' | 'vector_quantize_scan';

/**
 * The whole approximate-vs-exact decision, as a pure function of the inputs.
 *
 * Kept separate from the SQLite-touching code so the rule that protects recall
 * can be tested directly (see vector-index.test.ts) — the interesting cases are
 * all about *refusing* the fast path, and a rule that silently starts saying
 * "quantized" when the index is stale is exactly the regression that would never
 * show up as an error.
 *
 * `quantizedRows` is the count this process last quantized; `rows` is the count
 * present now. Any difference means the structure describes a different corpus
 * than the one being searched.
 */
export function decideScan(input: {
    enabled: boolean;
    unusable: boolean;
    dirty: boolean;
    rows: number;
    quantizedRows: number | null;
    minRows: number;
}): ScanFunction {
    if (!input.enabled) return 'vector_full_scan';
    if (input.unusable) return 'vector_full_scan';
    if (input.rows < input.minRows) return 'vector_full_scan';
    if (input.dirty) return 'vector_full_scan';
    if (input.quantizedRows === null || input.quantizedRows !== input.rows) return 'vector_full_scan';
    return 'vector_quantize_scan';
}

/**
 * Picks the scan function for `table`: the quantized one only when this process
 * has quantized exactly the rows currently present, the exact one otherwise
 * (scheduling a rebuild on the way out).
 *
 * Note there is deliberately no `vector_quantize_preload` call anywhere. Preload
 * exists to pull a persisted structure into memory for a process that did not
 * build it — which is the one situation this module refuses to search in, since
 * a persisted structure's freshness cannot be verified.
 */
function chooseScan(table: VectorTable): ScanFunction {
    const s = stateFor(table);
    const rows = embeddedRowCount(table);
    const scan = decideScan({
        enabled: QUANTIZATION_ENABLED,
        unusable: s.unusable,
        dirty: s.dirty,
        rows,
        quantizedRows: s.quantizedRows,
        minRows: MIN_ROWS_FOR_QUANTIZATION
    });

    // Falling back because the structure is missing or stale is the one case
    // worth acting on: rebuild it so the next query gets the fast path.
    if (
        scan === 'vector_full_scan' &&
        QUANTIZATION_ENABLED &&
        !s.unusable &&
        rows >= MIN_ROWS_FOR_QUANTIZATION &&
        !s.timer
    ) {
        scheduleRequantize(table);
    }

    return scan;
}

/**
 * Runs a vector search over `table`, using the quantized index when it is known
 * to be current.
 *
 * `buildSql` receives the scan function name to interpolate; `exec` runs the
 * resulting SQL. If the quantized scan throws (a structure invalidated
 * out-of-band, a build without TurboQuant), the table is demoted to exact search
 * and the query is retried immediately, so a caller never sees an error it
 * wouldn't have seen before quantization existed.
 */
export function runVectorScan<T>(
    table: VectorTable,
    buildSql: (scanFn: string) => string,
    exec: (sql: string) => T
): T {
    const scanFn = chooseScan(table);
    try {
        return exec(buildSql(scanFn));
    } catch (e) {
        if (scanFn === 'vector_full_scan') throw e;
        const s = stateFor(table);
        s.unusable = true;
        console.warn(
            `[VectorIndex] ${scanFn} failed on '${table}' (${(e as Error).message}); ` +
            `retrying with exact vector_full_scan and disabling quantization for this table.`
        );
        return exec(buildSql('vector_full_scan'));
    }
}

/** Diagnostics for the admin surface / scripts. */
export function vectorIndexStatus(): {
    enabled: boolean;
    qbits: number;
    minRows: number;
    maxMemory: string;
    tables: { table: VectorTable; rows: number; quantizedRows: number | null; dirty: boolean; unusable: boolean; lastQuantizeMs: number; scan: string }[];
} {
    const tables = (['chunks', 'topics', 'knowledge_claims', 'community_reports'] as VectorTable[]).map(table => {
        const s = stateFor(table);
        const rows = embeddedRowCount(table);
        return {
            table,
            rows,
            quantizedRows: s.quantizedRows,
            dirty: s.dirty,
            unusable: s.unusable,
            lastQuantizeMs: s.lastQuantizeMs,
            // Reports what a search *would* pick right now — same rule, so this
            // can't drift from the real decision.
            scan: decideScan({
                enabled: QUANTIZATION_ENABLED,
                unusable: s.unusable,
                dirty: s.dirty,
                rows,
                quantizedRows: s.quantizedRows,
                minRows: MIN_ROWS_FOR_QUANTIZATION
            }) as string
        };
    });
    return { enabled: QUANTIZATION_ENABLED, qbits: QBITS, minRows: MIN_ROWS_FOR_QUANTIZATION, maxMemory: MAX_MEMORY, tables };
}

/**
 * Builds the quantized structures for every eligible table up front, so the
 * first searches after a boot are already fast instead of paying exact-scan
 * latency until the debounce fires. Called at startup after any pending
 * embedding migration has settled.
 */
export function warmVectorIndexes(): void {
    if (!QUANTIZATION_ENABLED) {
        console.log('[VectorIndex] Quantization disabled (VECTOR_QUANTIZATION=off) — using exact vector_full_scan.');
        return;
    }
    for (const table of ['chunks', 'topics', 'knowledge_claims', 'community_reports'] as VectorTable[]) {
        const s = stateFor(table);
        if (s.timer) {
            clearTimeout(s.timer);
            s.timer = null;
        }
        quantizeNow(table);
    }
}
