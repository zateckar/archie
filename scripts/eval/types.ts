/**
 * Golden-set schema for retrieval evaluation.
 *
 * A case describes a query and what retrieval *should* surface for it. The
 * point is to make the pipeline's tuning constants (MIN_TOPIC_RELEVANCE,
 * ALIGNMENT_SIMILARITY_THRESHOLD, CHUNK_COVERAGE_THRESHOLD, the negation boost)
 * measurable instead of a matter of taste — none of them can be moved with
 * confidence while there is nothing to score a change against.
 */
export interface GoldenCase {
    id: string;
    /** The user question, phrased as someone would actually ask it. */
    query: string;
    /**
     * Topic names that must appear in the retrieved set, exactly as stored in
     * `topics.name`. Drives recall/precision/MRR.
     */
    expectedTopics: string[];
    /**
     * Distinctive substrings that must appear somewhere in the assembled
     * knowledge context. Keep them short and verbatim — they are matched
     * case-insensitively against the rendered context, so a whole sentence is
     * brittle and a single common word is meaningless.
     */
    expectedClaimSubstrings?: string[];
    /**
     * Substrings that must NOT appear. Use for regressions worth locking down:
     * a superseded fact that came back, a topic that keeps bleeding in from an
     * unrelated area.
     */
    mustNotRetrieve?: string[];
    /**
     * False until a human has confirmed the expectations are actually correct.
     * `seed.ts` writes drafts with `reviewed: false`; the runner skips those by
     * default, because scoring the pipeline against guesses is worse than not
     * scoring it at all — it manufactures confidence.
     */
    reviewed: boolean;
    /** Why this case exists: the bug it pins down, or where it came from. */
    note?: string;
}

export interface GoldenSet {
    version: number;
    /** Free text: what corpus/DB this set was written against. */
    corpus?: string;
    cases: GoldenCase[];
}

export interface CaseResult {
    id: string;
    query: string;
    /** Fraction of expectedTopics that appeared in the retrieved topic list. */
    topicRecall: number;
    /** Fraction of retrieved topics that were expected. */
    topicPrecision: number;
    /** Reciprocal rank of the first expected topic; 0 if none retrieved. */
    mrr: number;
    retrievedTopics: string[];
    missingTopics: string[];
    /** expectedClaimSubstrings that were found / total. */
    claimHits: number;
    claimTotal: number;
    missingClaims: string[];
    /** mustNotRetrieve substrings that leaked through. */
    leaked: string[];
    contextChars: number;
    elapsedMs: number;
    error?: string;
}
