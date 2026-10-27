/**
 * Vector helpers for claim ingestion, kept free of database and provider
 * imports so they can be unit-tested directly.
 */

/** Cosine similarity between two vectors (compared over the shorter length). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}

/**
 * Picks the existing claims worth showing the consistency checker: the `limit`
 * whose embedding is closest to ANY of the new claims, in their original order.
 *
 * Hub topics hold 200+ claims ("Compliance", "ŠKODA AUTO Internal
 * Documentation"). Sending all of them asks the model to compare every new
 * claim against hundreds of unrelated ones, which is where spurious conflict
 * and update verdicts come from — and an `update` retires a claim. Claims
 * without an embedding are kept, since nothing can be said about their distance.
 */
export function pickComparableClaims<T extends { embedding: ArrayLike<number> | null }>(
    existing: T[],
    newVectors: ArrayLike<number>[],
    limit: number
): T[] {
    if (existing.length <= limit || newVectors.length === 0) return existing;
    const scored = existing.map((claim, index) => ({
        index,
        score: claim.embedding
            ? Math.max(...newVectors.map(v => cosineSimilarity(v, claim.embedding!)))
            : Number.POSITIVE_INFINITY
    }));
    const keep = new Set(
        scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.index)
    );
    return existing.filter((_, i) => keep.has(i));
}

/**
 * The candidate closest to `vector`, with its similarity, or null when no
 * candidate has an embedding. Used to recover which chunk a claim came from.
 */
export function nearest<T extends { embedding: ArrayLike<number> | null }>(
    vector: ArrayLike<number>,
    candidates: T[]
): { item: T; score: number } | null {
    let best: { item: T; score: number } | null = null;
    for (const item of candidates) {
        if (!item.embedding) continue;
        const score = cosineSimilarity(vector, item.embedding);
        if (!best || score > best.score) best = { item, score };
    }
    return best;
}

/** Reads a float32 BLOB as written by sqlite-vector's `vector_as_f32`. */
export function blobToVector(blob: Buffer | null | undefined): Float32Array | null {
    if (!blob || blob.byteLength === 0) return null;
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
