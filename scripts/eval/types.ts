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
     * Documents that should supply verbatim passages for this question: case-
     * insensitive substrings of `documents.path` (or filename), e.g.
     * "MP_1_808". Scored against the chunks the chat pipeline would retrieve.
     */
    expectedSources?: string[];
    /**
     * Facts a correct ANSWER must state, written by a domain expert in plain
     * language. Only used with `--answers`, where an LLM judge checks each one
     * against the generated answer. This is the only part of a case that says
     * whether the answer is right rather than whether retrieval looked right.
     */
    expectedFacts?: string[];
    /** Subject area, for `--area` filtering (e.g. "application-integration"). */
    area?: string;
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
    /** Fraction of expectedSources found among the retrieved chunks (1 when none expected). */
    sourceRecall: number;
    missingSources: string[];
    /** Present only with `--answers`. */
    answer?: AnswerResult;
    elapsedMs: number;
    error?: string;
}

export interface AnswerResult {
    text: string;
    /** expectedFacts the judge found stated in the answer / total. */
    factHits: number;
    factTotal: number;
    missingFacts: string[];
    /**
     * Statements in the answer that the retrieved context does not support —
     * the judge's hallucination signal, independent of expectedFacts.
     */
    unsupported: string[];
    /** Answer statements carrying a [source] citation / statements checked. */
    citedRatio: number;
    /**
     * The judge's reason when the answer does not address the question asked
     * (answers something else, leads with an incidental detail). Unset when it does.
     */
    offTopic?: string;
}
