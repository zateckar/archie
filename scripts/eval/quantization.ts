/**
 * TurboQuant recall benchmark.
 *
 * Measures what `vector_quantize_scan` (sqlite-vector's approximate search over
 * precomputed TurboQuant structures) costs in retrieval accuracy against
 * `vector_full_scan` (exact brute force) on the REAL corpus, per table.
 *
 * Why this exists: quantized search is the only way the vector layer scales past
 * a few thousand rows on a single box — a 4096-dim float32 corpus is ~16KB per
 * row, and every query reads all of it. But an ANN index that silently drops the
 * one relevant claim is worse than a slow exact scan, so the switch has to be a
 * measurement rather than a guess.
 *
 * Ground truth is the exact scan's own top-k for the same query vector, which
 * makes this a pure quantization-loss measurement: no labels needed, and no
 * embedding-provider calls (query vectors are drawn from stored embeddings,
 * optionally perturbed with noise to model a query that is *near* a document
 * rather than identical to one).
 *
 * Usage:
 *   npx tsx scripts/eval/quantization.ts
 *   npx tsx scripts/eval/quantization.ts --qbits 2 --queries 100 --k 10
 *   npx tsx scripts/eval/quantization.ts --db path/to/copy.db --table topics
 *   npx tsx scripts/eval/quantization.ts --json results.json
 *
 * Runs against a COPY of the database by default (see --db): quantization is a
 * per-connection, in-memory structure and should not touch the live file.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
function flag(name: string): boolean {
    return argv.includes(`--${name}`);
}

const SOURCE_DB = arg('db') ?? process.env.DATABASE_PATH ?? 'data/rag.db';
const K_VALUES = (arg('k') ?? '5,10,20').split(',').map(Number);
const QUERIES = Number(arg('queries') ?? 60);
const QBITS = Number(arg('qbits') ?? 4);
const QTYPE = arg('qtype') ?? 'TURBO';
const NOISE_LEVELS = (arg('noise') ?? '0,0.25,0.5').split(',').map(Number);
const ONLY_TABLE = arg('table');
const JSON_OUT = arg('json');
const IN_PLACE = flag('in-place');
const SEED = Number(arg('seed') ?? 1337);

const TABLES = ['chunks', 'topics', 'knowledge_claims', 'community_reports'].filter(
    t => !ONLY_TABLE || t === ONLY_TABLE
);

// ── Deterministic RNG ───────────────────────────────────────────────────────
// A fixed seed makes two runs (e.g. qbits=4 vs qbits=2) comparable: they see the
// same query vectors and the same noise, so a difference in recall is the
// quantizer's, not the sample's.
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED);
/** Box-Muller: unit-variance gaussian, for perturbing query vectors. */
function gauss(): number {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ── Extension loading (mirrors src/lib/server/db.ts) ────────────────────────
function extensionPath(): string {
    if (os.platform() === 'win32') {
        return path.join(process.cwd(), 'node_modules/@sqliteai/sqlite-vector-win32-x86_64/vector.dll');
    }
    const candidates =
        os.arch() === 'arm64'
            ? [
                  'node_modules/@sqliteai/sqlite-vector-linux-arm64/vector.so',
                  'node_modules/@sqliteai/sqlite-vector-linux-arm64-musl/vector.so'
              ]
            : [
                  'node_modules/@sqliteai/sqlite-vector-linux-x86_64/vector.so',
                  'node_modules/@sqliteai/sqlite-vector-linux-x86_64-musl/vector.so'
              ];
    const found = candidates.map(c => path.join(process.cwd(), c)).find(p => fs.existsSync(p));
    if (!found) throw new Error('sqlite-vector extension not found for this platform');
    return found;
}

/**
 * Works on a snapshot unless --in-place. The WAL is copied alongside the main
 * file: without it the snapshot silently loses every write since the last
 * checkpoint, which on this project's DB is most of the corpus.
 */
function openDatabase(): { db: Database.Database; workingPath: string; cleanup: () => void } {
    let workingPath = SOURCE_DB;
    let cleanup = () => {};

    if (!IN_PLACE) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantbench-'));
        workingPath = path.join(dir, path.basename(SOURCE_DB));
        fs.copyFileSync(SOURCE_DB, workingPath);
        for (const suffix of ['-wal', '-shm']) {
            if (fs.existsSync(SOURCE_DB + suffix)) {
                fs.copyFileSync(SOURCE_DB + suffix, workingPath + suffix);
            }
        }
        cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    }

    const db = new Database(workingPath);
    db.loadExtension(extensionPath());
    return { db, workingPath, cleanup };
}

// ── Vector helpers ──────────────────────────────────────────────────────────
function blobToFloats(blob: Buffer): number[] {
    const view = new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
    return Array.from(view);
}

/**
 * Adds gaussian noise of magnitude `level` × the vector's own RMS component
 * size, then renormalises. `level=0` searches with an exact corpus vector (the
 * easiest possible case, and the one where any recall loss is purely the
 * quantizer's); higher levels model a real query, which lands *near* documents
 * rather than on top of one.
 */
function perturb(vec: number[], level: number): number[] {
    if (level <= 0) return vec;
    const rms = Math.sqrt(vec.reduce((s, v) => s + v * v, 0) / vec.length);
    const noisy = vec.map(v => v + gauss() * rms * level);
    const norm = Math.sqrt(noisy.reduce((s, v) => s + v * v, 0)) || 1;
    return noisy.map(v => v / norm);
}

interface Hit {
    rowid: number;
    distance: number;
}

interface NoiseResult {
    noise: number;
    recallAtK: Record<number, number>;
    top1Kept: number;
    meanRankOfExactTop1: number;
    exactMedianMs: number;
    quantMedianMs: number;
}

interface TableResult {
    table: string;
    rows: number;
    dimension: number;
    quantizedRows: number;
    quantizeMs: number;
    quantizeMemoryBytes: number | null;
    noiseResults: NoiseResult[];
    skipped?: string;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function benchmarkTable(db: Database.Database, table: string): TableResult {
    const embeddedRows = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE embedding IS NOT NULL`)
        .get() as { c: number };
    const rows = embeddedRows.c;

    const sample = db
        .prepare(`SELECT embedding FROM ${table} WHERE embedding IS NOT NULL LIMIT 1`)
        .get() as { embedding: Buffer } | undefined;

    if (!sample) {
        return {
            table,
            rows,
            dimension: 0,
            quantizedRows: 0,
            quantizeMs: 0,
            quantizeMemoryBytes: null,
            noiseResults: [],
            skipped: 'no embeddings'
        };
    }

    const dimension = sample.embedding.byteLength / 4;
    const maxK = Math.max(...K_VALUES);
    if (rows <= maxK) {
        return {
            table,
            rows,
            dimension,
            quantizedRows: 0,
            quantizeMs: 0,
            quantizeMemoryBytes: null,
            noiseResults: [],
            skipped: `only ${rows} embedded row(s); nothing to approximate at k=${maxK}`
        };
    }

    db.prepare(`SELECT vector_init(?, 'embedding', ?)`).get(table, `dimension=${dimension},distance=cosine`);

    // Draw query vectors from stored rows. Sampling ids first (rather than
    // ORDER BY RANDOM() over a table of 16KB blobs) keeps this cheap on the
    // large-dimension tables.
    const ids = db
        .prepare(`SELECT rowid AS id FROM ${table} WHERE embedding IS NOT NULL`)
        .all() as { id: number }[];
    const picked: number[] = [];
    const pool = ids.map(r => r.id);
    for (let i = 0; i < Math.min(QUERIES, pool.length); i++) {
        const j = i + Math.floor(rand() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
        picked.push(pool[i]);
    }
    const queryVectors = picked.map(id => {
        const row = db.prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(id) as { embedding: Buffer };
        return blobToFloats(row.embedding);
    });

    const quantizeStart = performance.now();
    const quantizedRows = db
        .prepare(`SELECT vector_quantize(?, 'embedding', ?)`)
        .pluck()
        .get(table, `qtype=${QTYPE},qbits=${QBITS}`) as number;
    const quantizeMs = performance.now() - quantizeStart;

    let quantizeMemoryBytes: number | null = null;
    try {
        quantizeMemoryBytes = db
            .prepare(`SELECT vector_quantize_memory(?, 'embedding')`)
            .pluck()
            .get(table) as number;
    } catch {
        quantizeMemoryBytes = null;
    }

    const exactStmt = db.prepare(
        `SELECT rowid, distance FROM vector_full_scan(?, 'embedding', vector_as_f32(?), CAST(? AS INTEGER))`
    );
    const quantStmt = db.prepare(
        `SELECT rowid, distance FROM vector_quantize_scan(?, 'embedding', vector_as_f32(?), CAST(? AS INTEGER))`
    );

    const noiseResults: NoiseResult[] = [];

    for (const noise of NOISE_LEVELS) {
        const recallHits: Record<number, number[]> = {};
        for (const k of K_VALUES) recallHits[k] = [];
        const exactTimes: number[] = [];
        const quantTimes: number[] = [];
        let top1Kept = 0;
        const exactTop1Ranks: number[] = [];

        for (const base of queryVectors) {
            const vec = JSON.stringify(perturb(base, noise));

            const t0 = performance.now();
            const exact = exactStmt.all(table, vec, maxK) as Hit[];
            exactTimes.push(performance.now() - t0);

            const t1 = performance.now();
            const approx = quantStmt.all(table, vec, maxK) as Hit[];
            quantTimes.push(performance.now() - t1);

            const approxIds = approx.map(h => h.rowid);
            for (const k of K_VALUES) {
                const exactK = new Set(exact.slice(0, k).map(h => h.rowid));
                const overlap = approxIds.slice(0, k).filter(id => exactK.has(id)).length;
                recallHits[k].push(exactK.size === 0 ? 1 : overlap / exactK.size);
            }

            // The single most important result to preserve is the exact best
            // match: a pipeline that reranks its candidates can absorb reordering
            // below it, but not the top hit vanishing from the candidate set.
            if (exact.length > 0) {
                const rank = approxIds.indexOf(exact[0].rowid);
                if (rank === 0) top1Kept++;
                exactTop1Ranks.push(rank === -1 ? maxK : rank);
            }
        }

        const recallAtK: Record<number, number> = {};
        for (const k of K_VALUES) {
            recallAtK[k] = recallHits[k].reduce((a, b) => a + b, 0) / Math.max(1, recallHits[k].length);
        }

        noiseResults.push({
            noise,
            recallAtK,
            top1Kept: top1Kept / Math.max(1, queryVectors.length),
            meanRankOfExactTop1:
                exactTop1Ranks.reduce((a, b) => a + b, 0) / Math.max(1, exactTop1Ranks.length),
            exactMedianMs: median(exactTimes),
            quantMedianMs: median(quantTimes)
        });
    }

    try {
        db.prepare(`SELECT vector_quantize_cleanup(?, 'embedding')`).get(table);
    } catch {
        // Cleanup is best-effort; the connection is about to close anyway.
    }

    return { table, rows, dimension, quantizedRows, quantizeMs, quantizeMemoryBytes, noiseResults };
}

// ── Report ──────────────────────────────────────────────────────────────────
function formatBytes(bytes: number | null): string {
    if (bytes === null) return 'n/a';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function main() {
    if (!fs.existsSync(SOURCE_DB)) {
        console.error(`Database not found: ${SOURCE_DB}`);
        process.exit(1);
    }

    const { db, workingPath, cleanup } = openDatabase();
    try {
        const version = db.prepare('SELECT vector_version()').pluck().get();
        let turboBackend = 'unavailable';
        try {
            turboBackend = db.prepare('SELECT vector_turboquant_backend()').pluck().get() as string;
        } catch {
            console.error(
                'vector_turboquant_backend() is unavailable — this build of sqlite-vector has no TurboQuant support.'
            );
            process.exit(1);
        }

        console.log('── TurboQuant recall benchmark ──');
        console.log(`extension       : sqlite-vector ${version} (SIMD ${db.prepare('SELECT vector_backend()').pluck().get()}, TurboQuant ${turboBackend})`);
        console.log(`database        : ${SOURCE_DB}${IN_PLACE ? ' (in place)' : ` → snapshot ${workingPath}`}`);
        console.log(`quantization    : qtype=${QTYPE}, qbits=${QBITS}`);
        console.log(`queries / table : ${QUERIES} (seed ${SEED}), k = ${K_VALUES.join(', ')}`);
        console.log(`query noise     : ${NOISE_LEVELS.join(', ')} × RMS component\n`);

        const results: TableResult[] = [];
        for (const table of TABLES) {
            let exists = true;
            try {
                db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
            } catch {
                exists = false;
            }
            if (!exists) {
                console.log(`${table}: table not present, skipping\n`);
                continue;
            }
            const result = benchmarkTable(db, table);
            results.push(result);

            if (result.skipped) {
                console.log(`${table}: skipped — ${result.skipped}\n`);
                continue;
            }

            console.log(
                `${result.table} — ${result.rows} rows × ${result.dimension} dims ` +
                    `(raw float32 ${formatBytes(result.rows * result.dimension * 4)})`
            );
            console.log(
                `  quantized ${result.quantizedRows} rows in ${result.quantizeMs.toFixed(0)} ms, ` +
                    `structure ${formatBytes(result.quantizeMemoryBytes)}`
            );
            console.log(
                `  ${'noise'.padEnd(7)}${K_VALUES.map(k => `recall@${k}`.padEnd(11)).join('')}` +
                    `${'top1kept'.padEnd(10)}${'exact ms'.padEnd(10)}${'quant ms'.padEnd(10)}speedup`
            );
            for (const nr of result.noiseResults) {
                const speedup = nr.quantMedianMs > 0 ? nr.exactMedianMs / nr.quantMedianMs : 0;
                console.log(
                    `  ${String(nr.noise).padEnd(7)}` +
                        K_VALUES.map(k => (nr.recallAtK[k] * 100).toFixed(1).padStart(6).padEnd(11)).join('') +
                        `${(nr.top1Kept * 100).toFixed(1).padStart(6).padEnd(10)}` +
                        `${nr.exactMedianMs.toFixed(2).padStart(7).padEnd(10)}` +
                        `${nr.quantMedianMs.toFixed(2).padStart(7).padEnd(10)}` +
                        `${speedup.toFixed(2)}×`
                );
            }
            console.log('');
        }

        if (JSON_OUT) {
            fs.writeFileSync(
                JSON_OUT,
                JSON.stringify(
                    { qtype: QTYPE, qbits: QBITS, queries: QUERIES, seed: SEED, k: K_VALUES, results },
                    null,
                    2
                )
            );
            console.log(`Wrote ${JSON_OUT}`);
        }

        // Verdict: the retrieval pipeline over-fetches and reranks, so what
        // matters is whether the exact top hit survives into the candidate set
        // and how much of the exact top-k is retained at the largest k.
        const maxK = Math.max(...K_VALUES);
        const measured = results.filter(r => !r.skipped);
        for (const r of measured) {
            const worst = r.noiseResults.reduce(
                (acc, nr) => Math.min(acc, nr.recallAtK[maxK]),
                1
            );
            const verdict = worst >= 0.95 ? 'OK' : worst >= 0.9 ? 'MARGINAL' : 'LOSSY';
            console.log(`verdict ${r.table.padEnd(18)} worst recall@${maxK} ${(worst * 100).toFixed(1)}% → ${verdict}`);
        }
    } finally {
        db.close();
        cleanup();
    }
}

main();
