/**
 * Pure query-shaping helpers for dual-level retrieval.
 *
 * Kept in their own dependency-free module (no `./db`, no `./llm`) so they can
 * be unit-tested directly — importing `rag.ts` in a test would run the whole
 * schema migration on import.
 */

/**
 * Joins keywords into a retrieval probe.
 *
 * Returned as a comma-separated list rather than glued onto the query, because
 * the point of the high/low-level split is to give each retrieval path an
 * embedding that is *not* the condensed question — appending keywords to the
 * query would just produce a slightly noisier version of the same vector.
 *
 * Returns null when the keywords add nothing the query string doesn't already
 * contain, so the caller can skip a second search that would retrieve the same
 * neighbourhood for the price of another embedding call.
 */
export function buildKeywordProbe(query: string, keywords: string[] | undefined): string | null {
    if (!keywords || keywords.length === 0) return null;

    const cleaned = keywords
        .filter(k => typeof k === 'string')
        .map(k => k.trim())
        .filter(k => k.length > 0);
    if (cleaned.length === 0) return null;

    const queryLower = query.toLowerCase();
    const novel = cleaned.filter(k => !queryLower.includes(k.toLowerCase()));
    if (novel.length === 0) return null;

    return cleaned.join(', ');
}

/**
 * Merges candidate lists by id, keeping the higher score for anything that
 * appears in more than one. Used to pool the query-level and keyword-level
 * search results before a single rerank pass, rather than reranking each list
 * separately — one pass over the union is both cheaper and a better ordering,
 * because each list ranked alone is blind to the other's candidates.
 */
export function mergeByIdKeepingBestScore<T extends { id: number; score: number }>(...lists: T[][]): T[] {
    const merged = new Map<number, T>();
    for (const list of lists) {
        for (const item of list) {
            const existing = merged.get(item.id);
            if (!existing || item.score > existing.score) merged.set(item.id, item);
        }
    }
    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}
