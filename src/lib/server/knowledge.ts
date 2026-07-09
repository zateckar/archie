import { db } from './db';
import { extractKnowledge, checkConsistencyBatch, deriveTaxonomyPlacements, deriveTaxonomyFull, getEmbedding } from './gemini';
import { embedTopic, embedClaim, searchTopics } from './rag';
import { normalizeTopicName } from './topic-normalize';
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
function normalizeForDuplicateCheck(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
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
 */
function lookupTopicId(name: string, topicIds: Map<string, number>): number | undefined {
    if (!name) return undefined;
    const direct = topicIds.get(name);
    if (direct) return direct;
    const { key } = normalizeTopicName(name);
    return topicIds.get(`__key__:${key}`);
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
        const relevant = await searchTopics(chunkContent.slice(0, 1000), 20);
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

export async function processDocumentKnowledge(docId: number, chunks: { id: number; content: string }[], documentSummary?: string) {
    console.log(`Processing knowledge for document ${docId} (${chunks.length} chunks)...`);

    // Guard: the document may have been deleted before this async processing completed
    // (e.g. during E2E tests that upload then quickly delete a document).
    if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(docId)) {
        console.log(`Document ${docId} was deleted before knowledge processing finished — skipping.`);
        return;
    }

    // Seed the per-document map with everything we already know so the LLM's
    // topic names are folded into existing canonical entries.
    const topicIds = seedExistingTopics();

    let topicCount = 0;
    let claimCount = 0;
    let relCount = 0;
    let totalFlaggedCount = 0;
    let failedChunkCount = 0;
    const droppedRelTypes = new Map<string, number>();

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Re-check on every iteration: processDocumentKnowledge runs outside any
        // transaction (Phase 3 of addDocument), so an await gap between chunks lets
        // a concurrent sync or an admin deletion remove the document. Without this
        // check, every subsequent INSERT that references doc_id throws a FK error.
        if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(docId)) {
            console.log(`Document ${docId} was deleted during knowledge processing — aborting.`);
            return;
        }

        const existingNames = await buildVocabularyHint(chunk.content, 80);

        // Build sliding window context for cross-chunk coherence
        const prevContext = i > 0
            ? `[PRECEDING SECTION]\n${chunks[i - 1].content.substring(0, 800)}\n[/PRECEDING SECTION]\n\n`
            : '';
        const nextContext = i < chunks.length - 1
            ? `\n\n[FOLLOWING SECTION]\n${chunks[i + 1].content.substring(0, 800)}\n[/FOLLOWING SECTION]`
            : '';
        const contextualizedChunk = `${prevContext}[CURRENT SECTION — extract knowledge from THIS section only]\n${chunk.content}\n[/CURRENT SECTION]${nextContext}`;

        // extractKnowledge() now returns null (not an empty-but-valid object) when
        // the LLM call or JSON parse genuinely failed, so a transient failure is
        // no longer indistinguishable from "this chunk legitimately had nothing to
        // extract." Retry once — most failures here are transient (a malformed
        // JSON response on one attempt is often clean on the next) — and if it
        // still fails, mark the chunk so the failure is visible instead of being
        // silently swallowed with just a console.error.
        let knowledge = await extractKnowledge(contextualizedChunk, existingNames, documentSummary);
        if (knowledge === null) {
            console.warn(`[Knowledge] Extraction failed for chunk ${chunk.id} (doc ${docId}), retrying once...`);
            knowledge = await extractKnowledge(contextualizedChunk, existingNames, documentSummary);
        }
        if (knowledge === null) {
            failedChunkCount++;
            console.error(`[Knowledge] Extraction failed for chunk ${chunk.id} (doc ${docId}) after retry — this chunk's knowledge was NOT extracted.`);
            try {
                db.prepare('UPDATE chunks SET extraction_failed = 1 WHERE id = ?').run(chunk.id);
            } catch (err) {
                // Column may not exist on databases that haven't run the migration yet; non-fatal.
            }
            continue;
        }
        // Successful extraction (possibly genuinely empty) clears any prior failure mark.
        try {
            db.prepare('UPDATE chunks SET extraction_failed = 0 WHERE id = ?').run(chunk.id);
        } catch (err) {
            // Column may not exist yet; non-fatal.
        }
        if (!knowledge.topics) continue;

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
                    topicCount++;

                    // Generate and store embedding for new topic
                    try {
                        await embedTopic(topicId, displayName, topic.description ?? null, topic.category ?? null);
                    } catch (err) {
                        console.error(`Failed to embed topic ${displayName}:`, err);
                    }
                }

                // Index by every alias we can think of, so subsequent claims/relationships
                // in the same chunk resolve regardless of how the LLM spelled them.
                topicIds.set(topic.name, topicId);
                topicIds.set(displayName, topicId);
                topicIds.set(`__key__:${key}`, topicId);

                // Link document to topic
                db.prepare('INSERT OR IGNORE INTO document_topics (doc_id, topic_id) VALUES (?, ?)').run(
                    docId,
                    topicId
                );
            } catch (err: any) {
                if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                    // Document was deleted between the per-chunk check and this insert.
                    console.log(`Document ${docId} removed mid-chunk — aborting knowledge processing.`);
                    return;
                }
                console.error(`Failed to process topic ${topic.name}:`, err);
            }
        }

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
                    if (r.changes > 0) relCount++;
                } catch (err) {
                    console.error('Failed to insert relationship:', err);
                }
            }
        }

        // 3. Process Claims with Quality Filtering and Batch Consistency Check
        // Group valid claims by topic for efficient batch processing
        const claimsByTopicForBatch = new Map<number, { claim: string; topicName: string; type?: string; aligned: boolean }[]>();

        for (const claim of knowledge.claims ?? []) {
            if (!claim?.topic || !claim?.claim) continue;

            const topicId = lookupTopicId(claim.topic, topicIds);
            if (!topicId) continue;

            // Validate claim-topic alignment (heuristic + embedding-similarity check).
            // Misaligned claims are still inserted (the check is too approximate to
            // safely delete data outright) but routed to `flagged` status below
            // instead of `active`, so they are excluded from user-facing retrieval
            // until a human reviews them via the admin UI's Flagged tab.
            const aligned = await validateClaimTopicAlignment(claim.claim, claim.topic, topicId);
            if (!aligned) {
                console.warn(`[Knowledge] Suspicious claim-topic alignment (flagging for review): topic="${claim.topic}", claim="${claim.claim.substring(0, 80)}..."`);
            }

            // Skip exact hash duplicates early
            const claimHash = crypto.createHash('sha256').update(claim.claim).digest('hex');
            const existingExact = db
                .prepare('SELECT id FROM knowledge_claims WHERE claim_hash = ?')
                .get(claimHash);
            if (existingExact) continue;

            if (!claimsByTopicForBatch.has(topicId)) {
                claimsByTopicForBatch.set(topicId, []);
            }
            claimsByTopicForBatch.get(topicId)!.push({ claim: claim.claim, topicName: claim.topic, type: claim.type, aligned });
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

        // Retrieve document content_hash once per chunk
        const docRow = db.prepare('SELECT content_hash FROM documents WHERE id = ?').get(docId) as { content_hash: string | null } | undefined;
        const docContentHash = docRow?.content_hash ?? null;

        let flaggedCount = 0;

        // Batch consistency check per topic — much more efficient than per-claim
        for (const [topicId, claims] of claimsByTopicForBatch) {
            if (claims.length === 0) continue;

            const existingClaims = db
                .prepare("SELECT claim_text FROM knowledge_claims WHERE topic_id = ? AND status = 'active'")
                .all(topicId) as { claim_text: string }[];

            const batchResults = await checkConsistencyBatch(
                claims.map(c => c.claim),
                existingClaims.map(c => c.claim_text)
            );

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
                    flaggedCount++;
                } else {
                    status = result.status === 'conflict' ? 'conflicting' : 'active';
                }

                try {
                    const insertResult = db.prepare(
                        `INSERT INTO knowledge_claims (topic_id, doc_id, chunk_id, claim_text, claim_hash, status, doc_content_hash, claim_type)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                         RETURNING id`
                    ).get(topicId, docId, chunk.id, claimData.claim, claimHash, status, docContentHash, claimData.type || 'assertion') as { id: number } | undefined;

                    if (!insertResult) continue;
                    claimCount++;

                    // Generate and store embedding for new claim
                    try {
                        const topicRow = db.prepare('SELECT name FROM topics WHERE id = ?').get(topicId) as { name: string } | undefined;
                        if (topicRow) {
                            await embedClaim(insertResult.id, claimData.claim, topicRow.name);
                        }
                    } catch (err) {
                        console.error(`Failed to embed claim ${insertResult.id}:`, err);
                    }
                } catch (err: any) {
                    if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                        console.log(`Document ${docId} removed mid-chunk — aborting knowledge processing.`);
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
        }

        if (flaggedCount > 0) {
            console.warn(`[Knowledge] Flagged ${flaggedCount} claim(s) for review in document ${docId} due to topic-alignment concerns.`);
            totalFlaggedCount += flaggedCount;
        }
    }

    // Log dropped relationship types summary
    if (droppedRelTypes.size > 0) {
        const summary = Array.from(droppedRelTypes.entries())
            .map(([type, count]) => `'${type}' x${count}`)
            .join(', ');
        console.warn(
            `[Knowledge] Dropped ${Array.from(droppedRelTypes.values()).reduce((a, b) => a + b, 0)} relationships with unknown types: ${summary}`
        );
    }

    if (failedChunkCount > 0) {
        console.error(
            `[Knowledge] ${failedChunkCount}/${chunks.length} chunk(s) in document ${docId} FAILED extraction after retry — their content contributed NO topics/claims/relationships. ` +
            `Query \`SELECT id FROM chunks WHERE doc_id = ${docId} AND extraction_failed = 1\` to find them, or re-run via POST /api/knowledge/reprocess.`
        );
    }

    console.log(
        `Finished knowledge for document ${docId}: +${topicCount} topics, +${claimCount} claims (${totalFlaggedCount} flagged for review), +${relCount} relationships` +
        (failedChunkCount > 0 ? `, ${failedChunkCount} chunk(s) failed extraction` : '')
    );

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
 * Incremental taxonomy placement: assigns parent_topic_id to topics that don't have one.
 * Called automatically after processDocumentKnowledge() completes.
 */
export async function placeTaxonomyForNewTopics(): Promise<number> {
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
export async function rebuildTaxonomy(): Promise<{ total: number; updated: number }> {
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
