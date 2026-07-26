import { db } from './db';
import { extractKnowledge, checkConsistencyBatch, deriveTaxonomyPlacements, deriveTaxonomyFull, getEmbedding } from './llm';
import { embedTopic, embedClaim, searchTopics, mapWithConcurrency } from './rag';
import { normalizeTopicName, foldDiacritics } from './topic-normalize';
import { markVectorIndexDirty } from './vector-index';
import { inCategory } from './usage';
import crypto from 'crypto';

export { normalizeTopicName };

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

// Minimum cosine similarity between a claim and its assigned topic's stored
// embedding for the semantic fallback (below) to consider them aligned.
// Deliberately lenient — this only runs on claims that already failed the
// cheap literal-overlap check, and its job is to rescue false positives
// (paraphrases/synonyms of the topic name), not to add a second way to fail.
const ALIGNMENT_SIMILARITY_THRESHOLD = 0.35;

/**
 * Validates that a claim is semantically aligned with its assigned topic.
 *
 * Two-tier check:
 * 1. Cheap literal-overlap heuristic: does a significant word from the topic
 *    name appear verbatim in the claim? Fast, no API call, catches the
 *    common case.
 * 2. Embedding-similarity fallback: ONLY runs when (1) fails. A claim can be
 *    perfectly well-aligned while sharing zero literal words with its topic
 *    name — e.g. topic "Multi-Factor Authentication" / claim "Users must
 *    provide a second verification factor when signing in" — and the
 *    word-overlap heuristic alone was flagging (and thereby hiding from
 *    retrieval — see below) a meaningful share of genuinely good claims.
 *    Comparing the claim's embedding against the topic's already-stored
 *    embedding catches these paraphrase/synonym cases that no literal-string
 *    heuristic can.
 *
 * Returns true if aligned, false if still suspicious after both checks.
 *
 * Claims that fail this check are NOT discarded outright (the heuristic is
 * still approximate), but the caller uses the result to route the claim to a
 * `flagged` status instead of `active` so it is excluded from user-facing
 * retrieval until a human reviews it via the admin UI's "Flagged" tab
 * (`/api/knowledge/topics/:id/claims?status=flagged`).
 */
async function validateClaimTopicAlignment(claimText: string, topicName: string, topicId: number): Promise<boolean> {
    const normalized = topicName.toLowerCase();
    const words = normalized.split(/[\s\-_]+/).filter(w => w.length > 3);
    const claimLower = claimText.toLowerCase();

    // Tier 1: literal word overlap (fast path, no API call)
    const matchCount = words.filter(w => claimLower.includes(w)).length;
    if (matchCount >= 1 || words.length < 2) return true;

    // Tier 2: embedding similarity fallback
    try {
        const topicRow = db.prepare('SELECT embedding FROM topics WHERE id = ?').get(topicId) as { embedding: Buffer | null } | undefined;
        if (!topicRow?.embedding) return false; // no embedding to compare against — keep tier-1 result

        const topicVec = new Float32Array(
            topicRow.embedding.buffer,
            topicRow.embedding.byteOffset,
            topicRow.embedding.byteLength / 4
        );
        const claimEmbedding = await getEmbedding(claimText, 'RETRIEVAL_QUERY');
        const similarity = cosineSimilarity(topicVec, Float32Array.from(claimEmbedding));
        return similarity >= ALIGNMENT_SIMILARITY_THRESHOLD;
    } catch (err) {
        console.warn(`[Knowledge] Embedding-based alignment fallback failed for topic="${topicName}":`, (err as Error).message);
        return false; // preserve prior conservative (tier-1) result on failure
    }
}

/**
 * Cheap, deterministic near-duplicate detector for claims extracted from the
 * SAME chunk. `checkConsistencyBatch` only compares new claims against claims
 * already committed to the DB, so two near-identical claims produced by the
 * LLM within one extraction call (common on repetitive source text) would
 * both sail through as "unique" and both get inserted. This normalises
 * whitespace/punctuation/case and drops later duplicates before they reach
 * the DB.
 */
export function normalizeForDuplicateCheck(text: string): string {
    // Fold BEFORE stripping to ASCII. The previous version stripped with the
    // ASCII-only `\w` class and an EMPTY replacement, which DELETED accented
    // letters and glued the survivors together — measured: "bezpečnostní" became
    // "bezpenostn", "řízení" became "zen", "úřad" became "ad".
    //
    // That is UNDER-normalisation, the opposite of this function's purpose. The
    // verified failure: the extractor emits "Řízení musí být schváleno." and
    // "Rizeni musi byt schvaleno." from one chunk, they key differently, the
    // `seenNormalized` guard never fires, and both are inserted, embedded, and
    // later retrieved into the same answer as two independent facts. Mixed
    // -diacritic spelling is routine in a Czech corpus, so that was the common
    // case. (There was a false-merge direction too: "má" and "mě" both keyed to
    // "m".) Same ordering contract documented in topic-normalize.ts.
    //
    // The replacement is now a SPACE, not '', so deletion can no longer glue two
    // words into a third. The explicit NFC makes the key encoding-independent —
    // previously the NFC and NFD forms of the same visible string produced
    // different keys, so the key's meaning depended on how the markdown happened
    // to be saved.
    //
    // This is aggressive LOSSY folding, which is right for duplicate detection
    // and would be WRONG for FTS query building — see ./fts-query, where the
    // tokenizer already folds and folding again would be redundant. Do not
    // "unify" the two.
    return foldDiacritics(text.normalize('NFC').toLowerCase())
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Closed vocabulary of relationship types we accept. Anything outside this list
 * is mapped to the closest synonym; if no mapping is possible, the relation is
 * dropped. This stops the long tail of single-use predicates the LLM invents.
 */
const ALLOWED_RELATIONSHIPS = new Set([
    'governs',
    'depends_on',
    'is_part_of',
    'is_a',
    'manages',
    'uses',
    'defines',
    'implements',
    'complies_with',
    'references',
    'supports',
    'includes',
    'constrains',
    'enforces',
    'enables'
]);

const RELATIONSHIP_SYNONYMS: Record<string, string> = {
    governed_by: 'governs', // direction kept; UI shows source/target
    is_governed_by: 'governs',
    governs_usage_of: 'governs',
    governs_stages_of: 'governs',
    governs_safety_of: 'governs',
    governs_process_of: 'governs',
    governs_new_instances_of: 'governs',
    governs_conditions_of: 'governs',
    oversees: 'governs',
    regulated_by: 'governs',
    is_regulated_by: 'governs',
    enforced_by: 'enforces',
    is_enforced_by: 'enforces',
    enforces_training_for: 'enforces',
    enforces_protection_of: 'enforces',
    must_comply_with: 'complies_with',
    must_adhere_to: 'complies_with',
    upheld_by: 'complies_with',
    sub_process_of: 'is_part_of',
    is_subset_of: 'is_part_of',
    is_a_subset_of: 'is_part_of',
    is_subject_to: 'is_part_of',
    specializes: 'is_a',
    extends: 'is_a',
    includes_variant: 'includes',
    includes_references_to: 'includes',
    populates: 'includes',
    integrates_with: 'includes',
    requires: 'depends_on',
    requires_approval_by: 'depends_on',
    requires_assignment_of: 'depends_on',
    requires_documentation: 'depends_on',
    requires_documentation_from: 'depends_on',
    requires_format: 'depends_on',
    depends_on_approval_from: 'depends_on',
    is_required_by: 'depends_on',
    is_mandatory_in: 'depends_on',
    must_use: 'uses',
    utilizes: 'uses',
    uses_data_from: 'uses',
    uses_for_monitoring: 'uses',
    operates_and_secures: 'manages',
    owns_and_manages: 'manages',
    manages_operations_of: 'manages',
    managed_by: 'manages',
    coordinates: 'manages',
    coordinates_with: 'manages',
    responsible_for: 'manages',
    creates_and_maintains: 'manages',
    initiates: 'manages',
    executes: 'implements',
    applies_to: 'implements',
    implements_for: 'implements',
    defines_rules_for: 'defines',
    defines_principles_for: 'defines',
    defines_requirements_for: 'defines',
    defines_structure_of: 'defines',
    defines_parameters_for: 'defines',
    defines_accountability_for: 'defines',
    defines_legal_status_of: 'defines',
    defines_approval_framework_for: 'defines',
    defines_risk_level_of: 'defines',
    defines_level_S: 'defines',
    defined_in: 'defines',
    is_the_basis_for: 'defines',
    classifies: 'defines',
    augments: 'supports',
    complements: 'supports',
    funds: 'supports',
    enables_resource_acquisition_for: 'enables',
    enables_usage_of: 'enables',
    is_tracked_via: 'enables',
    secures: 'constrains',
    threatens: 'constrains',
    limits_hardware_for: 'constrains',
    restricts_scope_of: 'constrains',
    determines_thresholds_for: 'constrains',
    references_topic: 'references',
    follows_rules_of: 'references',
    follows_process_of: 'references',
    methodologically_directs: 'references',
    transfers_deliverables_to: 'references',
    hands_over_to: 'references',
    precedes: 'references',
    triggers: 'references',
    must_be_recorded_in: 'references',
    is_applied_at_level_D: 'references',
    provides_standards_for: 'defines',
    provides_deviation_pathway_for: 'enables',
    verifies: 'complies_with',
    verifies_compliance_with: 'complies_with',
    validates: 'complies_with',
    authorizes: 'enables',
    approves: 'enables'
};

function normalizeRelationship(type: string): string | null {
    if (!type) return null;
    const t = type.toLowerCase().trim().replace(/\s+/g, '_');
    if (ALLOWED_RELATIONSHIPS.has(t)) return t;
    if (RELATIONSHIP_SYNONYMS[t]) return RELATIONSHIP_SYNONYMS[t];
    // Out-of-vocabulary: return null so caller can track the drop
    return null;
}

/**
 * Look up an existing topic id by either its raw name or its normalised key.
 * Used both during ingestion (to reuse canonical topics across documents/chunks)
 * and to resolve `relationships` and `claims` to a topic id.
 *
 * Falls back to a DB lookup on `canonical_key` when the in-memory map misses.
 * The map is seeded once per call and then written to as chunks are processed,
 * so with chunks running concurrently (see KNOWLEDGE_CHUNK_CONCURRENCY) a chunk
 * can legitimately reference a topic that a sibling chunk — or a concurrent
 * ingestion of another document — created after this call's map was seeded.
 * Without this fallback those relationships and claims would be silently
 * dropped for want of a topic id that does exist in the database.
 */
function lookupTopicId(name: string, topicIds: Map<string, number>): number | undefined {
    if (!name) return undefined;
    const direct = topicIds.get(name);
    if (direct) return direct;
    const { key } = normalizeTopicName(name);
    const byKey = topicIds.get(`__key__:${key}`);
    if (byKey) return byKey;

    if (!key) return undefined;
    try {
        const row = db.prepare('SELECT id FROM topics WHERE canonical_key = ?').get(key) as { id: number } | undefined;
        if (row) {
            // Memoise so siblings resolve it without another query.
            topicIds.set(`__key__:${key}`, row.id);
            topicIds.set(name, row.id);
            return row.id;
        }
    } catch (err) {
        console.warn(`[Knowledge] canonical_key lookup failed for "${name}":`, (err as Error).message);
    }
    return undefined;
}

/**
 * Fetch every existing topic from the DB and seed the in-memory map so that
 * the LLM-extracted topic names get folded into the canonical vocabulary
 * across documents.
 */
function seedExistingTopics(): Map<string, number> {
    const topicIds = new Map<string, number>();
    const rows = db.prepare('SELECT id, name FROM topics').all() as { id: number; name: string }[];
    for (const row of rows) {
        const { displayName, key } = normalizeTopicName(row.name);
        topicIds.set(row.name, row.id);
        topicIds.set(displayName, row.id);
        topicIds.set(`__key__:${key}`, row.id);
    }
    return topicIds;
}

/**
 * Returns the names of the most-referenced topics in the DB, capped to `limit`.
 * Used to inject a vocabulary hint into the extractor prompt so the LLM reuses
 * canonical topic names instead of inventing per-chunk synonyms.
 */
export function getCanonicalTopicNames(limit = 80): string[] {
    const rows = db
        .prepare(
            `
            SELECT t.name, COUNT(dt.doc_id) AS refs
            FROM topics t
            LEFT JOIN document_topics dt ON dt.topic_id = t.id
            GROUP BY t.id
            ORDER BY refs DESC, t.id ASC
            LIMIT ?
        `
        )
        .all(limit) as { name: string; refs: number }[];
    return rows.map((r) => r.name);
}

/**
 * Threshold beyond which a pure "top-N by reference count" vocabulary hint
 * stops covering the corpus well — past this many topics, real-but-rarely
 * -referenced topics fall out of the top-80 and the LLM starts reinventing
 * synonyms for them, defeating de-duplication.
 */
const VOCAB_SCALE_THRESHOLD = 100;

/**
 * Builds the topic-name vocabulary hint injected into the extractor prompt.
 * For small/medium corpora this is just the most-referenced topic names
 * (cheap, no extra API call). Once the corpus grows past
 * `VOCAB_SCALE_THRESHOLD`, it also runs a semantic search for topics related
 * to the current chunk's content and merges those in — this keeps the hint
 * relevant to what's actually being extracted instead of only reflecting
 * global popularity, so long-tail topics keep getting reused correctly.
 */
async function buildVocabularyHint(chunkContent: string, baseLimit = 80): Promise<string[]> {
    const baseNames = getCanonicalTopicNames(baseLimit);

    const totalTopics = (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;
    if (totalTopics <= VOCAB_SCALE_THRESHOLD) return baseNames;

    try {
        // cache: false — a per-chunk chunk-prefix probe is never reused, so
        // caching it would only evict the query vectors that are.
        const relevant = await searchTopics(chunkContent.slice(0, 1000), 20, undefined, false, { cache: false });
        const seen = new Set(baseNames);
        const merged = [...baseNames];
        for (const t of relevant) {
            if (!seen.has(t.name)) {
                seen.add(t.name);
                merged.push(t.name);
            }
        }
        return merged;
    } catch (err) {
        console.warn('[Knowledge] Vocabulary hint expansion via embedding search failed, falling back to frequency-only hint:', (err as Error).message);
        return baseNames;
    }
}

// ── Ingestion concurrency ───────────────────────────────────────────────────
//
// Knowledge extraction used to run strictly one chunk at a time: for a 50-chunk
// document that is 50 sequential LLM round trips, each with a per-claim
// alignment check and a per-claim embedding call nested inside it, before
// ingestion finished. The dominant cost is network latency, not CPU.
//
// Chunk-level parallelism is bounded and *batched* rather than unlimited,
// because the vocabulary hint fed to the extractor (`buildVocabularyHint`) is
// read from the DB: chunks inside one batch see the topic vocabulary as it stood
// when the batch started, so a topic first created by chunk 7 cannot be
// suggested to chunk 8 if they run together. That costs some de-duplication
// quality, which is why the window is small and a barrier separates batches —
// staleness is bounded to at most CHUNK_CONCURRENCY-1 chunks instead of growing
// across the whole document. Two further mitigations mean the residual risk is
// low: the `canonical_key` upsert converges differently-spelled names for the
// same concept onto one row regardless of ordering, and `lookupTopicId` now
// falls back to a DB lookup so a sibling chunk's topic still resolves.
//
// Set KNOWLEDGE_CHUNK_CONCURRENCY=1 to restore the fully sequential behaviour.
const CHUNK_CONCURRENCY = Math.max(1, Number(process.env.KNOWLEDGE_CHUNK_CONCURRENCY) || 3);

/**
 * Concurrency for the independent per-claim network calls (alignment-check
 * embeddings, claim embeddings) and per-topic consistency checks. These have no
 * ordering constraints between them at all — unlike chunk-level work — so this
 * can be set higher; the ceiling is the embedding provider's rate limit.
 */
const CLAIM_CONCURRENCY = Math.max(1, Number(process.env.KNOWLEDGE_CLAIM_CONCURRENCY) || 5);

/** Per-chunk outcome, aggregated by the caller. */
interface ChunkStats {
    topics: number;
    claims: number;
    relationships: number;
    flagged: number;
    superseded: number;
    failed: boolean;
}

const EMPTY_CHUNK_STATS: ChunkStats = {
    topics: 0, claims: 0, relationships: 0, flagged: 0, superseded: 0, failed: false
};

/**
 * Mutable state shared by all chunks of one document run.
 *
 * `aborted` replaces what used to be bare `return`s inside the chunk loop: with
 * chunks in flight concurrently, one chunk discovering that the document was
 * deleted has to signal the others rather than just returning from its own
 * frame, or the remaining chunks keep issuing INSERTs that fail on the foreign
 * key.
 */
interface IngestContext {
    docId: number;
    docContentHash: string | null;
    documentSummary?: string;
    topicIds: Map<string, number>;
    droppedRelTypes: Map<string, number>;
    aborted: boolean;
}

/** True if the document still exists; flips `aborted` and logs once if not. */
function documentStillExists(ctx: IngestContext): boolean {
    if (ctx.aborted) return false;
    if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(ctx.docId)) {
        if (!ctx.aborted) {
            ctx.aborted = true;
            console.log(`Document ${ctx.docId} was deleted during knowledge processing — aborting.`);
        }
        return false;
    }
    return true;
}

/**
 * Builds the knowledge graph for one document's chunks. Metered under the
 * 'knowledge' category — per-chunk extraction and consistency checking is the
 * dominant LLM cost of ingestion, and keeping it apart from the 'documents'
 * cleaning/chunking work is the whole point of tracking the two separately.
 */
export const processDocumentKnowledge = inCategory('knowledge', processDocumentKnowledgeImpl);

async function processDocumentKnowledgeImpl(docId: number, chunks: { id: number; content: string }[], documentSummary?: string) {
    console.log(
        `Processing knowledge for document ${docId} (${chunks.length} chunks, concurrency ${CHUNK_CONCURRENCY})...`
    );

    // Guard: the document may have been deleted before this async processing completed
    // (e.g. during E2E tests that upload then quickly delete a document).
    if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(docId)) {
        console.log(`Document ${docId} was deleted before knowledge processing finished — skipping.`);
        return;
    }

    const docRow = db.prepare('SELECT content_hash FROM documents WHERE id = ?').get(docId) as
        { content_hash: string | null } | undefined;

    const ctx: IngestContext = {
        docId,
        docContentHash: docRow?.content_hash ?? null,
        documentSummary,
        // Seed the per-document map with everything we already know so the LLM's
        // topic names are folded into existing canonical entries.
        topicIds: seedExistingTopics(),
        droppedRelTypes: new Map<string, number>(),
        aborted: false
    };

    let topicCount = 0;
    let claimCount = 0;
    let relCount = 0;
    let totalFlaggedCount = 0;
    let totalSupersededCount = 0;
    let failedChunkCount = 0;

    // Process in sequential batches so the vocabulary hint refreshes between
    // them (see CHUNK_CONCURRENCY). Within a batch, extraction and topic upserts
    // run first for every chunk, then all new topics are embedded, and only then
    // do claims run — the alignment check reads `topics.embedding`, so claims
    // must not start until every topic this batch created has one, or claims
    // would be spuriously flagged for want of an embedding that is moments away.
    for (let start = 0; start < chunks.length && !ctx.aborted; start += CHUNK_CONCURRENCY) {
        const batch = chunks.slice(start, start + CHUNK_CONCURRENCY);

        if (!documentStillExists(ctx)) break;

        // Phase A: extract + upsert topics (per chunk, concurrent).
        // `start + i` is the chunk's index in the whole document, which is what
        // the sliding-window context in extractAndUpsertTopics needs — the index
        // mapWithConcurrency hands back is relative to the batch.
        const extractions = await mapWithConcurrency(batch, CHUNK_CONCURRENCY, (chunk, i) =>
            extractAndUpsertTopics(chunk, start + i, chunks, ctx)
        );

        const succeeded = extractions.filter((e): e is SuccessfulExtraction => e !== null && !e.failed);
        failedChunkCount += extractions.filter(e => e?.failed).length;
        topicCount += succeeded.reduce((sum, e) => sum + e.newTopics.length, 0);

        if (ctx.aborted) break;

        // Phase A2: embed every topic this batch created, concurrently.
        const newTopics = succeeded.flatMap(e => e.newTopics);
        if (newTopics.length > 0) {
            await mapWithConcurrency(newTopics, CLAIM_CONCURRENCY, async (t) => {
                try {
                    await embedTopic(t.id, t.displayName, t.description, t.category);
                } catch (err) {
                    console.error(`Failed to embed topic ${t.displayName}:`, err);
                }
            });
        }

        if (ctx.aborted) break;

        // Phase B: relationships + claims (per chunk, concurrent)
        const chunkStats = await mapWithConcurrency(
            succeeded,
            CHUNK_CONCURRENCY,
            (extraction) => processRelationshipsAndClaims(extraction, ctx)
        );

        for (const stats of chunkStats) {
            claimCount += stats.claims;
            relCount += stats.relationships;
            totalFlaggedCount += stats.flagged;
            totalSupersededCount += stats.superseded;
        }
    }

    if (ctx.aborted) return;

    logIngestSummary(docId, chunks.length, {
        topicCount, claimCount, relCount, totalFlaggedCount, totalSupersededCount, failedChunkCount,
        droppedRelTypes: ctx.droppedRelTypes
    });

    // Incremental taxonomy: place any new/orphan topics into the existing hierarchy
    if (topicCount > 0) {
        try {
            await placeTaxonomyForNewTopics();
        } catch (err) {
            console.error('[Taxonomy] Incremental placement failed:', err);
        }
    }
}

/**
 * Deletes topics no surviving document supports any more, and (by FK cascade)
 * every graph edge that touched them.
 *
 * Why this is needed: a document change is a delete-then-reinsert of the
 * `documents` row (see addDocument), so `chunks`, `knowledge_claims` and
 * `document_topics` are cleaned by cascade — but `topics` has no document FK and
 * `topic_relationships` has no document provenance at all, so both are
 * append-only without this sweep. The result was that a topic asserted only by
 * the *old* version of an edited document kept its row, its description and its
 * embedding, and stayed retrievable: searchTopics filters only on
 * `embedding IS NOT NULL`, so dead topics were still being injected into chat
 * context, and edges asserted by since-edited text could never be retracted.
 *
 * A topic is orphaned when it has no `document_topics` link AND no claims of any
 * status. Both conditions matter: the link alone would drop topics whose claims
 * outlived their link row, and claims alone would keep topics whose claims were
 * all rejected by an admin. Superseded claims count as support — retiring a
 * claim is deliberately reversible (see the `restore` action), so a topic still
 * holding retired history is not garbage.
 *
 * Safe to run while another document is mid-ingestion: extractAndUpsertTopics
 * writes the topic row and its `document_topics` link in the same synchronous
 * block with no await between them, and nothing else inserts topics — so "no
 * link" can never mean "not linked yet". (A topic whose claims are still being
 * extracted is already linked, which is what keeps it.)
 *
 * Children of a deleted parent get `parent_topic_id = NULL` (FK ON DELETE SET
 * NULL) and are re-placed by the next incremental taxonomy pass, which targets
 * exactly the parentless rows.
 */
export function sweepOrphanTopics(): { topics: number; relationships: number } {
    const ORPHAN_PREDICATE = `
        NOT EXISTS (SELECT 1 FROM document_topics dt WHERE dt.topic_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_claims kc WHERE kc.topic_id = t.id)
    `;

    return db.transaction(() => {
        // Count the edges first: after the DELETE they are gone via cascade, so
        // there is nothing left to attribute the removal to.
        const relationships = (db.prepare(`
            SELECT COUNT(*) AS c FROM topic_relationships r
            WHERE EXISTS (SELECT 1 FROM topics t WHERE t.id = r.source_topic_id AND ${ORPHAN_PREDICATE})
               OR EXISTS (SELECT 1 FROM topics t WHERE t.id = r.target_topic_id AND ${ORPHAN_PREDICATE})
        `).get() as { c: number }).c;

        const result = db.prepare(`
            DELETE FROM topics WHERE id IN (SELECT t.id FROM topics t WHERE ${ORPHAN_PREDICATE})
        `).run();

        const topics = result.changes;
        if (topics > 0) {
            // Deleted embeddings: the quantized index must not keep serving them.
            markVectorIndexDirty('topics');
            console.log(`[KnowledgeGC] Removed ${topics} orphaned topic(s) and ${relationships} stale relationship(s).`);
        }

        return { topics, relationships };
    })();
}

/** Topic created during Phase A, awaiting its embedding in Phase A2. */
interface PendingTopic {
    id: number;
    displayName: string;
    description: string | null;
    category: string | null;
}

/**
 * Result of Phase A for one chunk. A discriminated union rather than a struct
 * with a `failed` flag, so a chunk whose extraction failed carries no fake
 * empty `knowledge` object for Phase B to be trusted not to read.
 */
type ChunkExtraction =
    | { failed: true; chunk: { id: number; content: string } }
    | {
        failed: false;
        chunk: { id: number; content: string };
        knowledge: NonNullable<Awaited<ReturnType<typeof extractKnowledge>>>;
        newTopics: PendingTopic[];
    };

/** Narrowing helper — the success variant is the only one with knowledge/topics. */
type SuccessfulExtraction = Extract<ChunkExtraction, { failed: false }>;

/**
 * Phase A for one chunk: build the vocabulary hint, extract knowledge, and
 * upsert the topics.
 *
 * The topic upserts stay sequential within the chunk — they are synchronous
 * SQLite writes, so there is nothing to win by interleaving them, and the
 * in-memory alias map stays coherent. Embedding, the part that actually costs a
 * network round trip, is deferred to the caller so every new topic in the batch
 * can be embedded concurrently.
 */
async function extractAndUpsertTopics(
    chunk: { id: number; content: string },
    i: number,
    chunks: { id: number; content: string }[],
    ctx: IngestContext
): Promise<ChunkExtraction | null> {
    if (ctx.aborted) return null;

    const existingNames = await buildVocabularyHint(chunk.content, 80);

    // Build sliding window context for cross-chunk coherence
    const prevContext = i > 0
        ? `[PRECEDING SECTION]\n${chunks[i - 1].content.substring(0, 800)}\n[/PRECEDING SECTION]\n\n`
        : '';
    const nextContext = i < chunks.length - 1
        ? `\n\n[FOLLOWING SECTION]\n${chunks[i + 1].content.substring(0, 800)}\n[/FOLLOWING SECTION]`
        : '';
    const contextualizedChunk = `${prevContext}[CURRENT SECTION — extract knowledge from THIS section only]\n${chunk.content}\n[/CURRENT SECTION]${nextContext}`;

    // extractKnowledge() returns null (not an empty-but-valid object) when
    // the LLM call or JSON parse genuinely failed, so a transient failure is
    // no longer indistinguishable from "this chunk legitimately had nothing to
    // extract." Retry once — most failures here are transient (a malformed
    // JSON response on one attempt is often clean on the next) — and if it
    // still fails, mark the chunk so the failure is visible instead of being
    // silently swallowed with just a console.error.
    let knowledge = await extractKnowledge(contextualizedChunk, existingNames, ctx.documentSummary);
    if (knowledge === null) {
        console.warn(`[Knowledge] Extraction failed for chunk ${chunk.id} (doc ${ctx.docId}), retrying once...`);
        knowledge = await extractKnowledge(contextualizedChunk, existingNames, ctx.documentSummary);
    }
    if (knowledge === null) {
        console.error(`[Knowledge] Extraction failed for chunk ${chunk.id} (doc ${ctx.docId}) after retry — this chunk's knowledge was NOT extracted.`);
        try {
            db.prepare('UPDATE chunks SET extraction_failed = 1 WHERE id = ?').run(chunk.id);
        } catch (err) {
            // Column may not exist on databases that haven't run the migration yet; non-fatal.
        }
        return { failed: true, chunk };
    }
    // Successful extraction (possibly genuinely empty) clears any prior failure mark.
    try {
        db.prepare('UPDATE chunks SET extraction_failed = 0 WHERE id = ?').run(chunk.id);
    } catch (err) {
        // Column may not exist yet; non-fatal.
    }

    const extraction: SuccessfulExtraction = { failed: false, chunk, knowledge, newTopics: [] };
    if (!knowledge.topics) return extraction;

    const { topicIds } = ctx;

    // 1. Process Topics
    for (const topic of knowledge.topics) {
        if (!topic?.name) continue;
        const { displayName, key } = normalizeTopicName(topic.name);

        try {
            // First, try to reuse an existing topic with the same canonical key.
            let topicId = topicIds.get(`__key__:${key}`);

            if (!topicId) {
                // Upsert keyed on canonical_key (not name) so that two differently
                // -spelled names for the same concept — e.g. "IT-PEP" inserted by one
                // request and "IT PEP" by a concurrent one — always converge onto a
                // single row instead of racing past the raw-name UNIQUE constraint.
                // This is also what makes bounded chunk-level concurrency safe: two
                // chunks in the same batch that both invent a name for the same
                // concept still land on one row.
                // On conflict, only replace description/category with the new value
                // when it's actually more informative (longer description; category
                // only fills in if it was previously unset) — this stops a later,
                // lower-quality chunk from clobbering a good earlier description.
                // NOTE: the ON CONFLICT target's WHERE clause must match
                // idx_topics_canonical_key's predicate exactly (db.ts) for SQLite to
                // recognise it as the same partial unique index.
                const result = db
                    .prepare(
                        `
                    INSERT INTO topics (name, description, category, canonical_key)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(canonical_key) WHERE canonical_key IS NOT NULL AND canonical_key != '' DO UPDATE SET
                        description = CASE
                            WHEN excluded.description IS NOT NULL
                                 AND LENGTH(excluded.description) > LENGTH(COALESCE(topics.description, ''))
                            THEN excluded.description
                            ELSE topics.description
                        END,
                        category = COALESCE(topics.category, excluded.category)
                    RETURNING id
                `
                    )
                    .get(displayName, topic.description ?? null, topic.category ?? null, key || null) as
                    | { id: number }
                    | undefined;
                if (!result) continue;
                topicId = result.id;

                // Embedding is deferred to the caller so every new topic in the
                // batch is embedded concurrently instead of one round trip at a
                // time. Claims do not start until that has finished, because the
                // alignment check reads topics.embedding.
                extraction.newTopics.push({
                    id: topicId,
                    displayName,
                    description: topic.description ?? null,
                    category: topic.category ?? null
                });
            }

            // Index by every alias we can think of, so subsequent claims/relationships
            // in the same chunk resolve regardless of how the LLM spelled them.
            topicIds.set(topic.name, topicId);
            topicIds.set(displayName, topicId);
            topicIds.set(`__key__:${key}`, topicId);

            // Link document to topic
            db.prepare('INSERT OR IGNORE INTO document_topics (doc_id, topic_id) VALUES (?, ?)').run(
                ctx.docId,
                topicId
            );
        } catch (err: any) {
            if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                // Document was deleted between the per-chunk check and this insert.
                ctx.aborted = true;
                console.log(`Document ${ctx.docId} removed mid-chunk — aborting knowledge processing.`);
                return extraction;
            }
            console.error(`Failed to process topic ${topic.name}:`, err);
        }
    }

    return extraction;
}

/**
 * Records that the document being ingested asserts `claimId`, whether or not
 * this ingestion is the one that created the claim row.
 *
 * INSERT OR IGNORE because the same claim text legitimately recurs across chunks
 * of one document: the first chunk records the assertion, later ones are no-ops
 * (the (claim_id, doc_id) primary key), so the first chunk to state a fact keeps
 * the lineage. A foreign-key failure means the document was deleted mid-ingest,
 * which the surrounding code already handles by aborting — nothing to add here,
 * so it stays a warning rather than a throw.
 */
function recordClaimAssertion(claimId: number, ctx: IngestContext, chunkId: number): void {
    try {
        db.prepare(`
            INSERT OR IGNORE INTO claim_documents (claim_id, doc_id, chunk_id, doc_content_hash)
            VALUES (?, ?, ?, ?)
        `).run(claimId, ctx.docId, chunkId, ctx.docContentHash);
    } catch (err) {
        console.warn(`[Knowledge] Could not record assertion of claim ${claimId} by document ${ctx.docId}:`, err);
    }
}

/**
 * Phase B for one chunk: relationships, then claims.
 *
 * Runs after every topic in the batch has been created *and* embedded, so
 * `validateClaimTopicAlignment`'s embedding-similarity tier always has a topic
 * vector to compare against.
 */
async function processRelationshipsAndClaims(
    extraction: SuccessfulExtraction,
    ctx: IngestContext
): Promise<ChunkStats> {
    if (ctx.aborted) return { ...EMPTY_CHUNK_STATS };

    const { chunk, knowledge } = extraction;
    const { topicIds, droppedRelTypes } = ctx;
    const stats: ChunkStats = { ...EMPTY_CHUNK_STATS };

    // 2. Process Relationships
    for (const rel of knowledge.relationships ?? []) {
        const sourceId = lookupTopicId(rel.source, topicIds);
        const targetId = lookupTopicId(rel.target, topicIds);
        const relType = normalizeRelationship(rel.type);

        if (!relType && rel.type) {
            // Track dropped out-of-vocabulary relationship types
            const rawType = rel.type.toLowerCase().trim().replace(/\s+/g, '_');
            droppedRelTypes.set(rawType, (droppedRelTypes.get(rawType) || 0) + 1);
        }

        if (sourceId && targetId && relType && sourceId !== targetId) {
            try {
                const r = db
                    .prepare(
                        `
                    INSERT OR IGNORE INTO topic_relationships (source_topic_id, target_topic_id, relationship_type)
                    VALUES (?, ?, ?)
                `
                    )
                    .run(sourceId, targetId, relType);
                if (r.changes > 0) stats.relationships++;
            } catch (err) {
                console.error('Failed to insert relationship:', err);
            }
        }
    }

    // 3. Process Claims with Quality Filtering and Batch Consistency Check
    // Group valid claims by topic for efficient batch processing
    const claimsByTopicForBatch = new Map<number, { claim: string; topicName: string; type?: string; aligned: boolean }[]>();

    // Resolve topics and drop exact-hash duplicates first (both synchronous), so
    // the alignment checks below — which each cost an embedding round trip in
    // the worst case — only run on claims that will actually be inserted.
    const candidates: { claim: string; topic: string; type?: string; topicId: number }[] = [];
    for (const claim of knowledge.claims ?? []) {
        if (!claim?.topic || !claim?.claim) continue;

        const topicId = lookupTopicId(claim.topic, topicIds);
        if (!topicId) continue;

        // Exact hash duplicate: the claim text already exists corpus-wide, so no
        // second row is created (see idx_knowledge_claims_hash). Record that THIS
        // document asserts it too, though — that record is what keeps the fact
        // alive when the document currently credited with it is edited or
        // deleted. Dropping the assertion silently, as this used to, is what made
        // shared facts disappear with whichever document happened to be ingested
        // first. Still no LLM cost here: alignment and consistency checks are
        // skipped exactly as before.
        const claimHash = crypto.createHash('sha256').update(claim.claim).digest('hex');
        const existingExact = db
            .prepare('SELECT id FROM knowledge_claims WHERE claim_hash = ?')
            .get(claimHash) as { id: number } | undefined;
        if (existingExact) {
            recordClaimAssertion(existingExact.id, ctx, chunk.id);
            continue;
        }

        candidates.push({ claim: claim.claim, topic: claim.topic, type: claim.type, topicId });
    }

    // Validate claim-topic alignment (heuristic + embedding-similarity check).
    // Concurrent: each check is an independent read plus at most one embedding
    // call, with no ordering relationship to any other check.
    // Misaligned claims are still inserted (the check is too approximate to
    // safely delete data outright) but routed to `flagged` status below
    // instead of `active`, so they are excluded from user-facing retrieval
    // until a human reviews them via the admin UI's Flagged tab.
    const alignmentResults = await mapWithConcurrency(candidates, CLAIM_CONCURRENCY, async (c) => {
        const aligned = await validateClaimTopicAlignment(c.claim, c.topic, c.topicId);
        if (!aligned) {
            console.warn(`[Knowledge] Suspicious claim-topic alignment (flagging for review): topic="${c.topic}", claim="${c.claim.substring(0, 80)}..."`);
        }
        return aligned;
    });

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!claimsByTopicForBatch.has(c.topicId)) {
            claimsByTopicForBatch.set(c.topicId, []);
        }
        claimsByTopicForBatch.get(c.topicId)!.push({
            claim: c.claim,
            topicName: c.topic,
            type: c.type,
            aligned: alignmentResults[i]
        });
    }

    // In-batch near-duplicate suppression: checkConsistencyBatch below only compares
    // each new claim against claims already committed to the DB, so two near-identical
    // claims produced by the LLM within THIS SAME extraction call (common on repetitive
    // source text) would both sail through as "unique". Drop later duplicates here,
    // before spending an LLM call on them.
    for (const [topicId, claims] of claimsByTopicForBatch) {
        const seenNormalized = new Set<string>();
        const deduped = claims.filter(c => {
            const norm = normalizeForDuplicateCheck(c.claim);
            if (seenNormalized.has(norm)) {
                console.warn(`[Knowledge] Dropping in-batch duplicate claim for topic ${topicId}: "${c.claim.substring(0, 80)}..."`);
                return false;
            }
            seenNormalized.add(norm);
            return true;
        });
        claimsByTopicForBatch.set(topicId, deduped);
    }

    // Claim embeddings are collected and issued after all inserts rather than
    // awaited inline, so a topic with 20 new claims costs one concurrent burst
    // instead of 20 serial round trips.
    const pendingEmbeds: { claimId: number; text: string; topicName: string }[] = [];

    // Batch consistency check per topic — much more efficient than per-claim.
    // Run concurrently ACROSS topics: each topic's check reads and writes only
    // its own claims, so there is no interaction between them. The one shared
    // risk, two runs inserting the same claim_hash, is already handled by the
    // UNIQUE-constraint catch below.
    const topicWork = Array.from(claimsByTopicForBatch.entries()).filter(([, claims]) => claims.length > 0);

    await mapWithConcurrency(topicWork, CLAIM_CONCURRENCY, async ([topicId, claims]) => {
        if (ctx.aborted) return;

        // `id` comes along so an `update` verdict can retire the specific
        // claim it replaces; the checker refers to them by list position.
        const existingClaims = db
            .prepare("SELECT id, claim_text FROM knowledge_claims WHERE topic_id = ? AND status = 'active' ORDER BY id")
            .all(topicId) as { id: number; claim_text: string }[];

        const batchResults = await checkConsistencyBatch(
            claims.map(c => c.claim),
            existingClaims.map(c => c.claim_text)
        );

        if (ctx.aborted) return;

        const topicRow = db.prepare('SELECT name FROM topics WHERE id = ?').get(topicId) as { name: string } | undefined;

        // One existing claim can only be retired once per batch. Without
        // this, two new claims that both name the same target would each
        // fire the UPDATE and the second would overwrite the first's
        // `superseded_by`, leaving a pointer to a claim that never
        // superseded anything.
        const retiredThisBatch = new Set<number>();

        for (const result of batchResults) {
            if (result.status === 'duplicate') continue;

            const claimData = claims[result.claimIndex];
            if (!claimData) continue;

            const claimHash = crypto.createHash('sha256').update(claimData.claim).digest('hex');
            // Alignment failures take priority: a claim that doesn't semantically
            // match its assigned topic is routed to `flagged` for human review
            // regardless of what the consistency checker concluded, since a
            // conflict/update verdict against the wrong topic's claims is meaningless.
            let status: string;
            if (!claimData.aligned) {
                status = 'flagged';
                stats.flagged++;
            } else {
                status = result.status === 'conflict' ? 'conflicting' : 'active';
            }

            try {
                const insertResult = db.prepare(
                    `INSERT INTO knowledge_claims (topic_id, doc_id, chunk_id, claim_text, claim_hash, status, doc_content_hash, claim_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     RETURNING id`
                ).get(topicId, ctx.docId, chunk.id, claimData.claim, claimHash, status, ctx.docContentHash, claimData.type || 'assertion') as { id: number } | undefined;

                if (!insertResult) continue;
                stats.claims++;
                recordClaimAssertion(insertResult.id, ctx, chunk.id);

                // Retire the claim this one replaces. Only for an aligned
                // `update` with a target the checker actually identified —
                // a misaligned claim was routed to `flagged` above and has
                // no business retiring anything.
                if (status === 'active' && result.status === 'update' && result.supersedesIndex !== undefined) {
                    const target = existingClaims[result.supersedesIndex];
                    if (!target) {
                        console.warn(
                            `[Knowledge] Ignoring out-of-range supersedesIndex ${result.supersedesIndex} ` +
                            `(topic ${topicId} has ${existingClaims.length} active claim(s)).`
                        );
                    } else if (target.id === insertResult.id || retiredThisBatch.has(target.id)) {
                        // Self-reference or already retired by an earlier
                        // claim in this same batch.
                    } else {
                        // Guarded on status so a claim retired by a
                        // concurrent ingestion run isn't retired twice with
                        // a different successor.
                        const retired = db.prepare(
                            `UPDATE knowledge_claims
                             SET status = 'superseded', superseded_by = ?, superseded_at = CURRENT_TIMESTAMP
                             WHERE id = ? AND status = 'active'`
                        ).run(insertResult.id, target.id);

                        if (retired.changes > 0) {
                            retiredThisBatch.add(target.id);
                            stats.superseded++;
                            console.log(
                                `[Knowledge] Claim ${target.id} superseded by ${insertResult.id} ` +
                                `(topic ${topicId})${result.reason ? `: ${result.reason}` : ''}`
                            );
                        }
                    }
                }

                if (topicRow) {
                    pendingEmbeds.push({ claimId: insertResult.id, text: claimData.claim, topicName: topicRow.name });
                }
            } catch (err: any) {
                if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                    ctx.aborted = true;
                    console.log(`Document ${ctx.docId} removed mid-chunk — aborting knowledge processing.`);
                    return;
                }
                if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT') {
                    // Lost a race with a concurrent ingestion run inserting the same
                    // claim_hash — not an error, just a no-op duplicate.
                    continue;
                }
                console.error('Failed to insert claim:', err);
            }
        }
    });

    if (pendingEmbeds.length > 0) {
        await mapWithConcurrency(pendingEmbeds, CLAIM_CONCURRENCY, async (e) => {
            try {
                await embedClaim(e.claimId, e.text, e.topicName);
            } catch (err) {
                console.error(`Failed to embed claim ${e.claimId}:`, err);
            }
        });
    }

    if (stats.flagged > 0) {
        console.warn(`[Knowledge] Flagged ${stats.flagged} claim(s) for review in document ${ctx.docId} due to topic-alignment concerns.`);
    }

    return stats;
}

function logIngestSummary(
    docId: number,
    chunkTotal: number,
    totals: {
        topicCount: number;
        claimCount: number;
        relCount: number;
        totalFlaggedCount: number;
        totalSupersededCount: number;
        failedChunkCount: number;
        droppedRelTypes: Map<string, number>;
    }
) {
    // Log dropped relationship types summary
    if (totals.droppedRelTypes.size > 0) {
        const summary = Array.from(totals.droppedRelTypes.entries())
            .map(([type, count]) => `'${type}' x${count}`)
            .join(', ');
        console.warn(
            `[Knowledge] Dropped ${Array.from(totals.droppedRelTypes.values()).reduce((a, b) => a + b, 0)} relationships with unknown types: ${summary}`
        );
    }

    if (totals.failedChunkCount > 0) {
        console.error(
            `[Knowledge] ${totals.failedChunkCount}/${chunkTotal} chunk(s) in document ${docId} FAILED extraction after retry — their content contributed NO topics/claims/relationships. ` +
            `Query \`SELECT id FROM chunks WHERE doc_id = ${docId} AND extraction_failed = 1\` to find them, or re-run via POST /api/knowledge/reprocess.`
        );
    }

    console.log(
        `Finished knowledge for document ${docId}: +${totals.topicCount} topics, +${totals.claimCount} claims (${totals.totalFlaggedCount} flagged for review), +${totals.relCount} relationships` +
        (totals.totalSupersededCount > 0 ? `, ${totals.totalSupersededCount} older claim(s) superseded` : '') +
        (totals.failedChunkCount > 0 ? `, ${totals.failedChunkCount} chunk(s) failed extraction` : '')
    );
}

/**
 * Incremental taxonomy placement: assigns parent_topic_id to topics that don't have one.
 * Called automatically after processDocumentKnowledge() completes.
 */
export const placeTaxonomyForNewTopics = inCategory('knowledge', placeTaxonomyForNewTopicsImpl);

async function placeTaxonomyForNewTopicsImpl(): Promise<number> {
    // Find orphan topics (no parent assigned)
    const orphans = db.prepare(
        'SELECT id, name, description, category FROM topics WHERE parent_topic_id IS NULL'
    ).all() as { id: number; name: string; description: string; category: string }[];

    if (orphans.length === 0) return 0;

    // Get existing taxonomy (topics that already have parents, plus roots for context)
    const existingTaxonomy = db.prepare(
        'SELECT id, name, category, parent_topic_id FROM topics'
    ).all() as { id: number; name: string; category: string; parent_topic_id: number | null }[];

    // Only place orphans that are "new" — if ALL topics are orphans (first import), skip incremental
    // and let the full rebuild handle it. Threshold: at least 3 topics must already have parents.
    const withParents = existingTaxonomy.filter(t => t.parent_topic_id !== null);
    if (withParents.length < 3 && existingTaxonomy.length > 5) {
        console.log('[Taxonomy] Skipping incremental placement — not enough existing taxonomy structure. Use full rebuild.');
        return 0;
    }

    console.log(`[Taxonomy] Placing ${orphans.length} orphan topics into existing taxonomy...`);

    const placements = await deriveTaxonomyPlacements(orphans, existingTaxonomy);

    let placed = 0;
    const validTopicIds = new Set(existingTaxonomy.map(t => t.id));

    for (const p of placements) {
        if (!p.topicId) continue;
        // Validate: parentId must exist and not be self
        if (p.parentId !== null && (!validTopicIds.has(p.parentId) || p.parentId === p.topicId)) continue;

        try {
            const r = db.prepare('UPDATE topics SET parent_topic_id = ? WHERE id = ? AND parent_topic_id IS NULL')
                .run(p.parentId, p.topicId);
            if (r.changes > 0) placed++;
        } catch (err) {
            console.error(`[Taxonomy] Failed to set parent for topic ${p.topicId}:`, err);
        }
    }

    console.log(`[Taxonomy] Placed ${placed}/${orphans.length} topics into taxonomy.`);
    return placed;
}

/**
 * Full taxonomy rebuild: LLM reviews ALL topics and produces an optimal hierarchy.
 * Triggered manually from admin UI or after git sync batch.
 */
export const rebuildTaxonomy = inCategory('knowledge', rebuildTaxonomyImpl);

async function rebuildTaxonomyImpl(): Promise<{ total: number; updated: number }> {
    const allTopics = db.prepare(`
        SELECT t.id, t.name, t.description, t.category,
               COUNT(kc.id) as claimCount
        FROM topics t
        LEFT JOIN knowledge_claims kc ON kc.topic_id = t.id
        GROUP BY t.id
        ORDER BY claimCount DESC, t.name ASC
    `).all() as { id: number; name: string; description: string; category: string; claimCount: number }[];

    if (allTopics.length === 0) {
        return { total: 0, updated: 0 };
    }

    console.log(`[Taxonomy] Full rebuild starting for ${allTopics.length} topics...`);

    const assignments = await deriveTaxonomyFull(allTopics);

    // Validate assignments: check for circular dependencies
    const parentMap = new Map<number, number | null>();
    const validTopicIds = new Set(allTopics.map(t => t.id));

    for (const a of assignments) {
        if (!a.topicId || !validTopicIds.has(a.topicId)) continue;
        if (a.parentId !== null && (!validTopicIds.has(a.parentId) || a.parentId === a.topicId)) continue;
        parentMap.set(a.topicId, a.parentId);
    }

    // Detect and break cycles
    function hasCycle(id: number): boolean {
        const visited = new Set<number>();
        let current: number | null | undefined = id;
        while (current != null) {
            if (visited.has(current)) return true;
            visited.add(current);
            current = parentMap.get(current) ?? null;
            if (current === null) break;
        }
        return false;
    }

    // Clear all existing parent assignments first
    db.prepare('UPDATE topics SET parent_topic_id = NULL').run();

    let updated = 0;
    for (const [topicId, parentId] of parentMap) {
        // Skip if this would create a cycle
        if (parentId !== null && hasCycle(topicId)) {
            console.warn(`[Taxonomy] Skipping cycle: topic ${topicId} -> parent ${parentId}`);
            continue;
        }

        if (parentId !== null) {
            try {
                db.prepare('UPDATE topics SET parent_topic_id = ? WHERE id = ?').run(parentId, topicId);
                updated++;
            } catch (err) {
                console.error(`[Taxonomy] Failed to update topic ${topicId}:`, err);
            }
        }
    }

    console.log(`[Taxonomy] Full rebuild complete: ${updated}/${allTopics.length} topics assigned parents.`);
    return { total: allTopics.length, updated };
}
