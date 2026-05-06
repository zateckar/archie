import { db } from './db';
import { extractKnowledge, checkConsistency, deriveTaxonomyPlacements, deriveTaxonomyFull } from './gemini';
import { embedTopic, embedClaim } from './rag';
import crypto from 'crypto';

/**
 * Validates that a claim is semantically aligned with its assigned topic.
 * Simple heuristic: claim should mention the topic name or significant words from it.
 * Returns true if aligned, false if suspicious (potential LLM extraction error).
 */
function validateClaimTopicAlignment(claimText: string, topicName: string): boolean {
    const normalized = topicName.toLowerCase();
    const words = normalized.split(/[\s\-_]+/).filter(w => w.length > 3);
    const claimLower = claimText.toLowerCase();

    // Check if at least one significant word from topic appears in claim
    const matchCount = words.filter(w => claimLower.includes(w)).length;

    // Accept if at least 1 word matches OR if topic name is short (< 2 words)
    return matchCount >= 1 || words.length < 2;
}

/**
 * Tightened topic-name normaliser.
 * Goals:
 *   - Collapse hyphen / space / underscore variants ("IT-PEP" == "IT PEP" == "IT_PEP").
 *   - Strip trailing categorical suffixes that don't change the concept.
 *   - Strip parenthetical aliases for matching purposes ("AMS (Application Management Service)" -> "AMS").
 *   - Be case-insensitive on the comparison key while preserving a clean display form.
 *
 * Returns:
 *   { displayName, key }
 *   - displayName: cleaned, human-friendly form to store in `topics.name`
 *   - key: lowercase canonical key used purely for de-duplication lookups
 */
export function normalizeTopicName(name: string): { displayName: string; key: string } {
    if (!name) return { displayName: '', key: '' };

    let display = name
        .replace(/[\u2010-\u2015]/g, '-') // unify dashes
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Strip a trailing categorical suffix that does not add semantic information.
    display = display.replace(
        /\s+(Methodology|Methodologies|Process|Processes|Guideline|Guidelines|Policy|Policies|Standard|Standards|Framework|Frameworks)$/i,
        ''
    );

    if (!display) display = name.trim();

    // Build a robust matching key:
    //   - lowercase
    //   - drop parenthetical content
    //   - collapse hyphen and space
    //   - strip non-alphanumerics
    const key = display
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[-\s]+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { displayName: display, key: key || display.toLowerCase() };
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

export async function processDocumentKnowledge(docId: number, chunks: string[]) {
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
    const droppedRelTypes = new Map<string, number>();

    for (const chunk of chunks) {
        // Re-check on every iteration: processDocumentKnowledge runs outside any
        // transaction (Phase 3 of addDocument), so an await gap between chunks lets
        // a concurrent sync or an admin deletion remove the document. Without this
        // check, every subsequent INSERT that references doc_id throws a FK error.
        if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(docId)) {
            console.log(`Document ${docId} was deleted during knowledge processing — aborting.`);
            return;
        }

        const existingNames = getCanonicalTopicNames(80);
        const knowledge = await extractKnowledge(chunk, existingNames);
        if (!knowledge || !knowledge.topics) continue;

        // 1. Process Topics
        for (const topic of knowledge.topics) {
            if (!topic?.name) continue;
            const { displayName, key } = normalizeTopicName(topic.name);

            try {
                // First, try to reuse an existing topic with the same canonical key.
                let topicId = topicIds.get(`__key__:${key}`);

                if (!topicId) {
                    const result = db
                        .prepare(
                            `
                        INSERT INTO topics (name, description, category)
                        VALUES (?, ?, ?)
                        ON CONFLICT(name) DO UPDATE SET
                            description = COALESCE(excluded.description, topics.description),
                            category = COALESCE(excluded.category, topics.category)
                        RETURNING id
                    `
                        )
                        .get(displayName, topic.description ?? null, topic.category ?? null) as
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

        // 3. Process Claims with Consistency Check
        for (const claim of knowledge.claims ?? []) {
            if (!claim?.topic || !claim?.claim) continue;

            const topicId = lookupTopicId(claim.topic, topicIds);
            if (!topicId) continue;

            // Validate claim-topic alignment (heuristic check)
            if (!validateClaimTopicAlignment(claim.claim, claim.topic)) {
                console.warn(`[Knowledge] Suspicious claim-topic alignment: topic="${claim.topic}", claim="${claim.claim.substring(0, 80)}..."`);
                // Continue anyway - this is just a warning, not a blocker
            }

            const claimHash = crypto.createHash('sha256').update(claim.claim).digest('hex');

            // Retrieve document content_hash for version attribution
            const docRow = db.prepare('SELECT content_hash FROM documents WHERE id = ?').get(docId) as { content_hash: string | null } | undefined;
            const docContentHash = docRow?.content_hash ?? null;

            // Check for exact duplicate first
            const existingExact = db
                .prepare('SELECT id FROM knowledge_claims WHERE claim_hash = ?')
                .get(claimHash);
            if (existingExact) continue;

            // Get existing claims for this topic to check consistency
            const existingClaims = db
                .prepare("SELECT claim_text FROM knowledge_claims WHERE topic_id = ? AND status = 'active'")
                .all(topicId) as { claim_text: string }[];

            const consistency = await checkConsistency(claim.claim, existingClaims.map((c) => c.claim_text));

            if (consistency.status === 'duplicate') continue;

            try {
                let claimId: number;
                if (consistency.status === 'conflict') {
                    const result = db.prepare(
                        `
                        INSERT INTO knowledge_claims (topic_id, doc_id, claim_text, claim_hash, status, doc_content_hash)
                        VALUES (?, ?, ?, ?, 'conflicting', ?)
                        RETURNING id
                    `
                    ).get(topicId, docId, claim.claim, claimHash, docContentHash) as { id: number } | undefined;
                    if (!result) continue;
                    claimId = result.id;
                } else {
                    const result = db.prepare(
                        `
                        INSERT INTO knowledge_claims (topic_id, doc_id, claim_text, claim_hash, status, doc_content_hash)
                        VALUES (?, ?, ?, ?, 'active', ?)
                        RETURNING id
                    `
                    ).get(topicId, docId, claim.claim, claimHash, docContentHash) as { id: number } | undefined;
                    if (!result) continue;
                    claimId = result.id;
                }
                claimCount++;

                // Generate and store embedding for new claim
                try {
                    const topicRow = db.prepare('SELECT name FROM topics WHERE id = ?').get(topicId) as { name: string } | undefined;
                    if (topicRow) {
                        await embedClaim(claimId, claim.claim, topicRow.name);
                    }
                } catch (err) {
                    console.error(`Failed to embed claim ${claimId}:`, err);
                }
            } catch (err: any) {
                if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                    console.log(`Document ${docId} removed mid-chunk — aborting knowledge processing.`);
                    return;
                }
                console.error('Failed to insert claim:', err);
            }
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

    console.log(
        `Finished knowledge for document ${docId}: +${topicCount} topics, +${claimCount} claims, +${relCount} relationships`
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
