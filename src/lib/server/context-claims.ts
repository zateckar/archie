/**
 * Claim selection for `buildKnowledgeContext`, kept free of database and
 * provider imports so it can be unit-tested directly.
 *
 * Two defects motivated pulling this out of rag.ts:
 *
 *   1. Claims were selected corpus-wide (semantic search with no topic filter)
 *      but rendered only under topics already in the context's topic set. Any
 *      selected claim whose topic had not made the topic cut was silently
 *      dropped — while still occupying one of the `maxClaims` slots. Measured on
 *      the production corpus with stored chunk vectors as proxy queries, ~41% of
 *      the top-15 semantic claims were lost this way. The fix is that a selected
 *      claim brings its topic with it (`topicsToAdopt`).
 *   2. Spare slots were topped up with a topic's claims in `created_at` order,
 *      so a hub topic with 200+ claims contributed its oldest ones regardless of
 *      the question. Filler is now a topic-restricted semantic search, passed in
 *      here already ordered by relevance.
 */

export interface ContextClaim {
    id: number;
    claim_text: string;
    topic_id: number;
    topic_name: string;
    claim_type: string;
    filename?: string;
    path?: string | null;
    /** Repository of the claim's document, so the UI can link the source. */
    repo_id?: number | null;
    score: number;
    status: 'active' | 'conflicting';
}

export interface ClaimSelectionInput {
    /**
     * Claims flagged `conflicting` on the PRIMARY topics. Guaranteed a slot (they
     * are already capped per topic at the source) because a governing
     * contradiction must not lose an ordering contest to plain assertions.
     */
    conflicting: ContextClaim[];
    /** Corpus-wide semantic hits, best first (already reranked). */
    semantic: ContextClaim[];
    /** Topic-restricted semantic hits used to fill spare slots, best first. */
    filler: ContextClaim[];
    maxClaims: number;
}

/**
 * Merges the three claim sources into the final, de-duplicated selection.
 *
 * Order of precedence: conflicts (uncapped), then semantic hits, then filler,
 * the latter two sharing `maxClaims`. Conflicts do not count against the cap —
 * they were guaranteed before, and capping them now would re-open the hole the
 * guarantee closed.
 */
export function selectContextClaims({ conflicting, semantic, filler, maxClaims }: ClaimSelectionInput): ContextClaim[] {
    const selected = new Map<number, ContextClaim>();
    for (const c of conflicting) {
        if (!selected.has(c.id)) selected.set(c.id, { ...c, status: 'conflicting' });
    }
    let budget = maxClaims;
    for (const c of [...semantic, ...filler]) {
        if (budget <= 0) break;
        if (selected.has(c.id)) continue;
        selected.set(c.id, { ...c, status: 'active' });
        budget--;
    }
    return Array.from(selected.values());
}

/**
 * Topic ids that selected claims belong to but that are missing from the
 * context's topic set, each with the best score among its claims. The caller
 * fetches and adds them so every selected claim has a section to render in.
 */
export function topicsToAdopt(claims: ContextClaim[], knownTopicIds: Set<number>): Map<number, number> {
    const adopt = new Map<number, number>();
    for (const c of claims) {
        if (knownTopicIds.has(c.topic_id)) continue;
        adopt.set(c.topic_id, Math.max(adopt.get(c.topic_id) ?? 0, c.score));
    }
    return adopt;
}
