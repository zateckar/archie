import { db } from './db';

/**
 * Write-side guard against a mixed-dimension vector column.
 *
 * ## Why this exists
 *
 * `providers.embedContent` silently degrades LiteLLM → Gemini on ANY primary
 * error, and those two models return vectors of different length (e.g. 4096 vs
 * 3072). `storeEmbedding` in llm.ts already guards the in-memory query cache
 * against that — but nothing guarded the writes that land in SQLite, where the
 * consequence is both worse and permanent.
 *
 * Measured against the real sqlite-vector extension, a wrong-dimension vector is:
 *   1. accepted by `vector_as_f32` with no error, even on a column whose index is
 *      already locked to a different dimension;
 *   2. silently SKIPPED by `vector_full_scan` — the row is simply absent from
 *      results. Nothing throws, nothing logs.
 *
 * So one LiteLLM blip during ingestion permanently removes the affected rows from
 * vector search with no signal anywhere. Chunks keep partial cover via the FTS
 * half of hybrid search; `searchTopics` and `searchClaims` are pure vector, so a
 * topic or claim written during the blip is unretrievable through the primary
 * knowledge path for good.
 *
 * It also corrupts the auto-migration decision in rag.ts:
 * `currentCorpusDimension()` reads one arbitrary row via `LIMIT 1`, so on a mixed
 * corpus it can either skip a re-embed that is genuinely needed or trigger a full
 * one that is not.
 *
 * Failing the write loudly is strictly better than storing an invisible row: the
 * ingestion errors, the operator sees why, and a retry once the gateway recovers
 * produces a correct corpus.
 *
 * ## Why it's a separate module
 *
 * `communities.ts` needs the same guard, and rag.ts already imports
 * communities.ts — importing it back would be a cycle whose hoisting order
 * decides whether rag.ts's module-level constants are initialised. Extracted here
 * for the same reason fts-query.ts and retrieval-probe.ts were: no dependency
 * beyond `db`, and the comparison logic is pure so it can be unit-tested without
 * one.
 */

export type EmbeddedTable = 'chunks' | 'topics' | 'knowledge_claims' | 'community_reports';

/** Thrown when an embedding's dimension disagrees with the corpus it's joining. */
export class EmbeddingDimensionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EmbeddingDimensionError';
    }
}

/**
 * The dimension currently stored in `table`, or null when it holds no embeddings
 * (nothing to conflict with, so the next write legitimately defines it).
 *
 * Note this is the same `LIMIT 1` probe rag.ts uses for index initialisation. It
 * is only trustworthy *because* this guard keeps the column uniform — which is
 * the point: with the guard in place one row does describe the whole table.
 */
export function storedDimension(table: EmbeddedTable): number | null {
    try {
        const row = db
            .prepare(`SELECT LENGTH(embedding) AS len FROM ${table} WHERE embedding IS NOT NULL LIMIT 1`)
            .get() as { len: number } | undefined;
        return row ? row.len / 4 : null;
    } catch {
        return null;
    }
}

/**
 * Every distinct dimension present in `table`, ascending.
 *
 * More than one entry means the column is already mixed — i.e. a provider
 * fallback wrote into it before the guard below existed. Those rows are invisible
 * to `vector_full_scan` and cannot be repaired in place (the vector has to be
 * regenerated), so the only fix is a full re-embed; `ensureEmbeddingsMigrated`
 * uses this to detect and trigger exactly that.
 *
 * Deliberately a full scan of the column's blob lengths rather than a `LIMIT 1`
 * probe — spotting the minority row is the entire purpose.
 */
export function distinctDimensions(table: EmbeddedTable): number[] {
    try {
        const rows = db
            .prepare(
                `SELECT DISTINCT LENGTH(embedding) / 4 AS dim
                 FROM ${table}
                 WHERE embedding IS NOT NULL
                 ORDER BY dim`
            )
            .all() as { dim: number }[];
        return rows.map(r => r.dim);
    } catch {
        return [];
    }
}

/**
 * Pure comparison behind `assertStorableEmbedding`, split out so the failure
 * modes can be tested without a database. Returns the vector's dimension, or
 * throws `EmbeddingDimensionError`.
 */
export function checkDimension(
    stored: number | null,
    vector: number[],
    table: EmbeddedTable,
    label: string
): number {
    if (!Array.isArray(vector) || vector.length === 0) {
        throw new EmbeddingDimensionError(
            `Refusing to store an empty embedding in ${table} for ${label}.`
        );
    }
    if (stored !== null && stored !== vector.length) {
        throw new EmbeddingDimensionError(
            `Embedding dimension mismatch writing to ${table} for ${label}: ` +
            `got ${vector.length}-dim but the table already holds ${stored}-dim vectors. ` +
            `This almost always means the embedding provider fell back mid-run ` +
            `(LiteLLM → Gemini). Storing it would make the row invisible to vector search ` +
            `with no error at query time, so the write is refused. Retry once the primary ` +
            `provider is healthy, or run \`npm run reembed\` to rebuild the corpus at the ` +
            `current model's dimension.`
        );
    }
    return vector.length;
}

/**
 * Verifies `vector` can be stored in `table` without creating a mixed-dimension
 * column, and returns its dimension.
 *
 * An empty (or fully-cleared) table has no dimension to conflict with, so the
 * first write defines it — which is also what makes this safe to call from inside
 * `reembedAll`, whose first step is to NULL every embedding.
 */
export function assertStorableEmbedding(
    table: EmbeddedTable,
    vector: number[],
    label: string
): number {
    return checkDimension(storedDimension(table), vector, table, label);
}

/**
 * Pure batch comparison behind `assertUniformEmbeddings`.
 */
export function checkUniformDimensions(
    stored: number | null,
    vectors: number[][],
    table: EmbeddedTable,
    label: string
): number | null {
    if (vectors.length === 0) return null;
    const first = checkDimension(stored, vectors[0], table, label);
    for (let i = 1; i < vectors.length; i++) {
        if (vectors[i]?.length !== first) {
            throw new EmbeddingDimensionError(
                `Embedding dimension changed mid-batch for ${label}: item 0 is ${first}-dim ` +
                `but item ${i} is ${vectors[i]?.length ?? 0}-dim. The embedding provider almost ` +
                `certainly fell back (LiteLLM → Gemini) partway through. Refusing to write a ` +
                `mixed-dimension batch; retry once the primary provider is healthy.`
            );
        }
    }
    return first;
}

/**
 * Batch form, for callers that fetch every embedding before writing any (the
 * ingestion path embeds all of a document's chunks up front). Catches a fallback
 * that happened partway through the batch *before* a transaction is opened and
 * before any row is written, so the document fails as a unit rather than landing
 * half-visible.
 */
export function assertUniformEmbeddings(
    table: EmbeddedTable,
    vectors: number[][],
    label: string
): number | null {
    return checkUniformDimensions(storedDimension(table), vectors, table, label);
}
