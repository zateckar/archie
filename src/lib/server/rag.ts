import { db } from './db';
import { processDocumentKnowledge } from './knowledge';
import { recomputeCommunities } from './communities';
import crypto from 'crypto';
import { getEmbedding, rerank, semanticChunk, cleanDocument, summarizeDocument } from './gemini';

export async function addDocument(filename: string, content: string, metadata: { repoId?: number, path?: string } = {}) {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    // ── Phase 0: Document preprocessing ──────────────────────────────────────
    // Clean the document to remove noise, then generate a comprehensive summary.
    // Cleaning removes boilerplate, formatting artifacts, and valueless content.
    // The summary captures the document's overall meaning and aids knowledge extraction.
    const cleanedContent = await cleanDocument(content);
    const summary = await summarizeDocument(cleanedContent, filename);
    console.log(`[DocPreprocess] "${filename}": cleaned ${content.length} → ${cleanedContent.length} chars, summary: ${summary.length} chars`);

    // ── Phase 1: async AI work (no transaction held) ──────────────────────────
    // All expensive async operations (LLM calls, embeddings) run here so that
    // a SQLite transaction is never held open while awaiting network I/O.
    // This prevents "cannot start a transaction within a transaction" when the
    // auto-sync timer fires a second time before the first document finishes.

    // Semantic Chunking using LLM, fallback to regex.
    // We require the LLM result to cover at least 80% of the source character
    // count. The previous implementation accepted *any* non-empty array, which
    // led to documents being silently truncated to 7-50% coverage when the LLM
    // hit output token limits or returned partial JSON.
    let chunks: string[] = [];
    const COVERAGE_THRESHOLD = 0.8;
    if (cleanedContent.length < 50000) {
        const semantic = await semanticChunk(cleanedContent);
        const coveredChars = semantic.reduce((n: number, c: string) => n + (c?.length ?? 0), 0);
        if (semantic.length > 0 && coveredChars >= cleanedContent.length * COVERAGE_THRESHOLD) {
            chunks = semantic;
        } else if (semantic.length > 0) {
            console.warn(
                `Semantic chunking covered only ${Math.round(
                    (100 * coveredChars) / cleanedContent.length
                )}% of "${filename}" (${semantic.length} chunks); falling back to markdown-aware chunker.`
            );
        }
    }
    if (!chunks || chunks.length === 0) {
        chunks = chunkText(cleanedContent, 1500, 200);
    }
    // Enrich chunks with metadata for better embedding context
    const chunksWithMetadata = chunks.map(chunk => `Document: ${metadata.path || filename}\n\n${chunk}`);

    // Fetch all embeddings before opening any transaction
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(chunksWithMetadata[i], "RETRIEVAL_DOCUMENT", filename);
        embeddings.push(embedding);
    }

    // Ensure vector index is initialised before the transaction
    if (embeddings.length > 0) {
        try {
            db.prepare("SELECT vector_init('chunks', 'embedding', ?)").get(`dimension=${embeddings[0].length},distance=cosine`);
        } catch (e) {
            // Already initialised
        }
    }

    // ── Phase 2: fast synchronous DB writes (transaction is brief) ────────────
    const docId = db.transaction(() => {
        // Explicitly delete to avoid unique constraint issues with partial indexes
        if (metadata.repoId && metadata.path) {
            db.prepare('DELETE FROM documents WHERE repo_id = ? AND path = ?').run(metadata.repoId, metadata.path);
        }

        const result = db.prepare('INSERT INTO documents (filename, content, context, summary, repo_id, path, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            filename,
            content,
            `doc_${Date.now()}`,
            summary,
            metadata.repoId || null,
            metadata.path || null,
            contentHash
        );
        const newDocId = result.lastInsertRowid;

        for (let i = 0; i < chunks.length; i++) {
            db.prepare('INSERT INTO chunks (doc_id, content, embedding) VALUES (?, ?, vector_as_f32(?))')
                .run(newDocId, chunks[i], JSON.stringify(embeddings[i]));
        }

        return newDocId;
    })();

    // ── Phase 3: async knowledge processing (outside any transaction) ─────────
    await processDocumentKnowledge(Number(docId), chunks, summary);

    // ── Phase 4: Community detection (outside any transaction) ─────────────────
    // Recompute communities after knowledge extraction. Full recompute is fast
    // (<100ms for <5000 nodes) so no incremental heuristic is needed.
    try {
        await recomputeCommunities();
    } catch (err) {
        console.error('[CommunityDetection] Recompute failed:', err);
    }

    return { docId, cleanedContent };
}

async function ensureVectorInit() {
    const dimension = 768; // Gemini embedding dimension
    try {
        db.prepare("SELECT vector_init('chunks', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized or table doesn't exist yet
    }
}

/**
 * Generate and store embedding for a topic. Called when topic is created or updated.
 */
export async function embedTopic(topicId: number, name: string, description: string | null, category: string | null) {
    const embeddingText = `Topic: ${name}\nCategory: ${category || 'Uncategorized'}\nDescription: ${description || 'No description'}`;
    const embedding = await getEmbedding(embeddingText, "RETRIEVAL_DOCUMENT", name);
    const dimension = embedding.length;

    try {
        db.prepare("SELECT vector_init('topics', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    db.prepare('UPDATE topics SET embedding = vector_as_f32(?), embedding_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(embedding), topicId);
}

/**
 * Generate and store embedding for a claim. Called when claim is created or updated.
 */
export async function embedClaim(claimId: number, claimText: string, topicName: string) {
    const embeddingText = `Topic: ${topicName}\nClaim: ${claimText}`;
    const embedding = await getEmbedding(embeddingText, "RETRIEVAL_DOCUMENT", topicName);
    const dimension = embedding.length;

    try {
        db.prepare("SELECT vector_init('knowledge_claims', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    db.prepare('UPDATE knowledge_claims SET embedding = vector_as_f32(?), embedding_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(embedding), claimId);
}

/**
 * Backfill embeddings for all topics and claims that don't have them yet.
 * Run this after adding embedding columns to migrate existing data.
 */
export async function backfillAllEmbeddings(): Promise<{ topicsEmbedded: number; claimsEmbedded: number }> {
    console.log('Starting embedding backfill...');

    // Backfill topics
    const topicsToEmbed = db.prepare('SELECT id, name, description, category FROM topics WHERE embedding IS NULL').all() as
        { id: number; name: string; description: string | null; category: string | null }[];

    console.log(`Found ${topicsToEmbed.length} topics to embed`);
    let topicsEmbedded = 0;

    for (const topic of topicsToEmbed) {
        await embedTopic(topic.id, topic.name, topic.description, topic.category);
        topicsEmbedded++;
        if (topicsEmbedded % 50 === 0) {
            console.log(`  Embedded ${topicsEmbedded}/${topicsToEmbed.length} topics`);
        }
    }

    // Backfill claims
    const claimsToEmbed = db.prepare(`
        SELECT kc.id, kc.claim_text, t.name as topic_name
        FROM knowledge_claims kc
        JOIN topics t ON kc.topic_id = t.id
        WHERE kc.embedding IS NULL
    `).all() as { id: number; claim_text: string; topic_name: string }[];

    console.log(`Found ${claimsToEmbed.length} claims to embed`);
    let claimsEmbedded = 0;

    for (const claim of claimsToEmbed) {
        await embedClaim(claim.id, claim.claim_text, claim.topic_name);
        claimsEmbedded++;
        if (claimsEmbedded % 50 === 0) {
            console.log(`  Embedded ${claimsEmbedded}/${claimsToEmbed.length} claims`);
        }
    }

    console.log(`Embedding backfill complete: ${topicsEmbedded} topics, ${claimsEmbedded} claims`);
    return { topicsEmbedded, claimsEmbedded };
}


export async function searchChunks(query: string, limit = 5) {
    await ensureVectorInit();
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");
    
    // Create a safe FTS query by extracting alphanumeric words and using prefix matching.
    // Strip FTS5 special characters and operators to prevent injection.
    const words = query
        .replace(/[^\w\s]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(w => w.length > 2 && /^[a-zA-Z0-9_]+$/.test(w));
    const ftsQuery = words.length > 0
        ? words.map(w => `"${w.replace(/"/g, '""')}"*`).join(' OR ')
        : '"*"';
    
    // Hybrid Search using Reciprocal Rank Fusion (RRF)
    // We fetch more results initially to allow for better reranking
    let results: { content: string, filename: string, path: string | null, score: number }[] = [];
    try {
        results = db.prepare(`
            WITH vector_results AS (
                SELECT rowid, row_number() OVER (ORDER BY distance ASC) as rank
                FROM vector_full_scan('chunks', 'embedding', vector_as_f32(?), 50)
            ),
            fts_results AS (
                SELECT rowid, row_number() OVER (ORDER BY rank ASC) as rank
                FROM chunks_fts
                WHERE content MATCH ?
                LIMIT 50
            )
            SELECT c.content,
                   d.filename,
                   d.path,
                   (COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + f.rank), 0)) as score
            FROM chunks c
            JOIN documents d ON c.doc_id = d.id
            LEFT JOIN vector_results v ON c.id = v.rowid
            LEFT JOIN fts_results f ON c.id = f.rowid
            WHERE v.rank IS NOT NULL OR f.rank IS NOT NULL
            ORDER BY score DESC
            LIMIT 20
        `).all(JSON.stringify(queryEmbedding), ftsQuery) as { content: string, filename: string, path: string | null, score: number }[];
    } catch (e) {
        console.warn('searchChunks: hybrid search failed (vector extension unavailable or no indexed data):', (e as Error).message);
        return [];
    }

    if (results.length === 0) return [];

    // Rerank top results using LLM for maximum relevance
    const rankedIndices = await rerank(query, results);
    const rerankedResults = rankedIndices
        .map(index => results[index])
        .filter(Boolean)
        .slice(0, limit);

    return rerankedResults;
}

/**
 * Wipe and rebuild the knowledge layer (topics, claims, relationships, doc-topic
 * links) for one or all documents. Chunks and embeddings are preserved when
 * `rechunk` is false; the knowledge graph is reconstructed from existing chunks.
 *
 * Use this after ingestion-pipeline fixes to back-fill the corpus without
 * re-embedding everything (which is expensive and rate-limited).
 */
export async function reprocessKnowledge(
    options: { docId?: number; wipeAll?: boolean; rechunk?: boolean } = {}
): Promise<{ processed: number; topicsBefore: number; topicsAfter: number; claimsBefore: number; claimsAfter: number }> {
    const topicsBefore = (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;
    const claimsBefore = (db.prepare('SELECT COUNT(*) AS c FROM knowledge_claims').get() as { c: number }).c;

    if (options.wipeAll) {
        // Wipe knowledge tables but keep chunks/embeddings/documents.
        db.exec(`
            DELETE FROM knowledge_claims;
            DELETE FROM document_topics;
            DELETE FROM topic_relationships;
            DELETE FROM topics;
        `);
    } else if (options.docId) {
        // Wipe only this document's knowledge links; topics/claims it solely
        // owned will be left orphaned (cleaned up on next full wipe).
        db.prepare('DELETE FROM knowledge_claims WHERE doc_id = ?').run(options.docId);
        db.prepare('DELETE FROM document_topics WHERE doc_id = ?').run(options.docId);
    }

    const docs = options.docId
        ? (db.prepare('SELECT id, filename, content, summary FROM documents WHERE id = ?').all(options.docId) as { id: number; filename: string; content: string; summary: string | null }[])
        : (db.prepare('SELECT id, filename, content, summary FROM documents ORDER BY id').all() as { id: number; filename: string; content: string; summary: string | null }[]);

    let processed = 0;
    for (const doc of docs) {
        let chunkRows: { content: string }[];
        if (options.rechunk) {
            db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(doc.id);
            // Re-embed via the regular pipeline
            await embedAndStoreChunks(doc.id, doc.filename, doc.content, undefined);
            chunkRows = db.prepare('SELECT content FROM chunks WHERE doc_id = ?').all(doc.id) as { content: string }[];
        } else {
            chunkRows = db.prepare('SELECT content FROM chunks WHERE doc_id = ?').all(doc.id) as { content: string }[];
        }

        if (chunkRows.length === 0) {
            console.warn(`Doc ${doc.id} (${doc.filename}) has no chunks; skipping knowledge processing.`);
            continue;
        }

        await processDocumentKnowledge(doc.id, chunkRows.map((c) => c.content), doc.summary ?? undefined);
        processed++;
    }

    const topicsAfter = (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;
    const claimsAfter = (db.prepare('SELECT COUNT(*) AS c FROM knowledge_claims').get() as { c: number }).c;

    return { processed, topicsBefore, topicsAfter, claimsBefore, claimsAfter };
}

/**
 * Internal helper that performs the chunking + embedding portion of ingestion,
 * extracted so `reprocessKnowledge` can re-chunk on demand without duplicating
 * the LLM-with-fallback logic.
 */
async function embedAndStoreChunks(
    docId: number | bigint,
    filename: string,
    content: string,
    pathHint: string | undefined
): Promise<string[]> {
    let chunks: string[] = [];
    const COVERAGE_THRESHOLD = 0.8;
    if (content.length < 50000) {
        const semantic = await semanticChunk(content);
        const coveredChars = semantic.reduce((n: number, c: string) => n + (c?.length ?? 0), 0);
        if (semantic.length > 0 && coveredChars >= content.length * COVERAGE_THRESHOLD) {
            chunks = semantic;
        }
    }
    if (!chunks || chunks.length === 0) {
        chunks = chunkText(content, 1500, 200);
    }
    const chunksWithMetadata = chunks.map((chunk) => `Document: ${pathHint || filename}\n\n${chunk}`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkWithMetadata = chunksWithMetadata[i];
        const embedding = await getEmbedding(chunkWithMetadata, 'RETRIEVAL_DOCUMENT', filename);
        const dimension = embedding.length;
        try {
            db.prepare("SELECT vector_init('chunks', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
        } catch (e) {
            // already initialized
        }
        db.prepare('INSERT INTO chunks (doc_id, content, embedding) VALUES (?, ?, vector_as_f32(?))').run(
            docId,
            chunk,
            JSON.stringify(embedding)
        );
    }
    return chunks;
}

function chunkText(text: string, maxChars: number, overlap: number = 200): string[] {
    // Markdown-aware chunking
    // 1. Split by headers
    const sections = text.split(/(?=\n#{1,6} )/);
    const chunks: string[] = [];
    
    for (const section of sections) {
        if (section.length <= maxChars) {
            chunks.push(section.trim());
        } else {
            // 2. Split by paragraphs
            const paragraphs = section.split(/\n\n+/);
            let currentChunk = "";
            for (const para of paragraphs) {
                if (para.length > maxChars) {
                    // 3. Paragraph too big, split by sentences (rough)
                    if (currentChunk) {
                        chunks.push(currentChunk.trim());
                        // Start next chunk with overlap from previous
                        currentChunk = currentChunk.slice(-overlap);
                    }
                    const sentences = para.split(/(?<=[.!?])\s+|\n/);
                    for (const sentence of sentences) {
                        if ((currentChunk.length + sentence.length) <= maxChars) {
                            currentChunk += (currentChunk ? " " : "") + sentence;
                        } else {
                            if (currentChunk) chunks.push(currentChunk.trim());
                            currentChunk = (currentChunk.slice(-overlap) + " " + sentence).trim();
                        }
                    }
                } else if ((currentChunk.length + para.length) <= maxChars) {
                    currentChunk += (currentChunk ? "\n\n" : "") + para;
                } else {
                    if (currentChunk) chunks.push(currentChunk.trim());
                    currentChunk = (currentChunk.slice(-overlap) + "\n\n" + para).trim();
                }
            }
            if (currentChunk) chunks.push(currentChunk.trim());
        }
    }
    return chunks.filter(c => c.length > overlap / 2); // Filter out tiny chunks that are mostly overlap
}

/**
 * Semantic search on topics using embeddings.
 * Returns topics ranked by relevance to the query.
 */
export async function searchTopics(query: string, limit = 10): Promise<{ id: number; name: string; description: string | null; category: string | null; score: number }[]> {
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");

    try {
        db.prepare("SELECT vector_init('topics', 'embedding', ?)").get('dimension=768,distance=cosine');
    } catch (e) {
        // Already initialized
    }

    try {
        const results = db.prepare(`
            SELECT t.id, t.name, t.description, t.category,
                   (1 - v.distance) as score
            FROM vector_full_scan('topics', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
            JOIN topics t ON t.id = v.rowid
            WHERE t.embedding IS NOT NULL
            ORDER BY v.distance ASC
        `).all(JSON.stringify(queryEmbedding), limit) as { id: number; name: string; description: string | null; category: string | null; score: number }[];

        return results;
    } catch (e) {
        console.warn('searchTopics failed (no embeddings or vector extension unavailable):', (e as Error).message);
        return [];
    }
}

/**
 * Semantic search on claims, optionally filtered by topic IDs.
 */
export async function searchClaims(
    query: string,
    topicIds: number[] | null = null,
    limit = 20
): Promise<{ id: number; claim_text: string; topic_name: string; topic_id: number; doc_id: number; score: number }[]> {
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");

    try {
        db.prepare("SELECT vector_init('knowledge_claims', 'embedding', ?)").get('dimension=768,distance=cosine');
    } catch (e) {
        // Already initialized
    }

    try {
        let sql: string;
        let params: any[];

        if (topicIds && topicIds.length > 0) {
            const placeholders = topicIds.map(() => '?').join(',');
            sql = `
                SELECT kc.id, kc.claim_text, kc.topic_id, kc.doc_id, t.name as topic_name,
                       (1 - v.distance) as score
                FROM vector_full_scan('knowledge_claims', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
                JOIN knowledge_claims kc ON kc.id = v.rowid
                JOIN topics t ON kc.topic_id = t.id
                WHERE kc.embedding IS NOT NULL
                  AND kc.status = 'active'
                  AND kc.topic_id IN (${placeholders})
                ORDER BY v.distance ASC
            `;
            params = [JSON.stringify(queryEmbedding), limit * 2, ...topicIds]; // Fetch more then filter
        } else {
            sql = `
                SELECT kc.id, kc.claim_text, kc.topic_id, kc.doc_id, t.name as topic_name,
                       (1 - v.distance) as score
                FROM vector_full_scan('knowledge_claims', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
                JOIN knowledge_claims kc ON kc.id = v.rowid
                JOIN topics t ON kc.topic_id = t.id
                WHERE kc.embedding IS NOT NULL
                  AND kc.status = 'active'
                ORDER BY v.distance ASC
            `;
            params = [JSON.stringify(queryEmbedding), limit];
        }

        const results = db.prepare(sql).all(...params) as { id: number; claim_text: string; topic_name: string; topic_id: number; doc_id: number; score: number }[];
        return results.slice(0, limit);
    } catch (e) {
        console.warn('searchClaims failed (no embeddings or vector extension unavailable):', (e as Error).message);
        return [];
    }
}

/**
 * Traverse topic relationships via BFS to find related topics.
 * Returns topics connected to the starting topic within maxDepth hops.
 */
export function getRelatedTopics(topicId: number, maxDepth = 2): { id: number; name: string; relationship_path: string[]; depth: number }[] {
    const visited = new Set<number>();
    const queue: { id: number; depth: number; path: string[] }[] = [{ id: topicId, depth: 0, path: [] }];
    const results: { id: number; name: string; relationship_path: string[]; depth: number }[] = [];

    visited.add(topicId);

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (current.depth >= maxDepth) continue;

        // Find all relationships where this topic is source or target
        const relationships = db.prepare(`
            SELECT
                CASE
                    WHEN source_topic_id = ? THEN target_topic_id
                    ELSE source_topic_id
                END as related_id,
                CASE
                    WHEN source_topic_id = ? THEN relationship_type
                    ELSE 'inverse_' || relationship_type
                END as rel_type
            FROM topic_relationships
            WHERE source_topic_id = ? OR target_topic_id = ?
        `).all(current.id, current.id, current.id, current.id) as { related_id: number; rel_type: string }[];

        for (const rel of relationships) {
            if (visited.has(rel.related_id)) continue;

            visited.add(rel.related_id);
            const newPath = [...current.path, rel.rel_type];

            // Get topic name
            const topicRow = db.prepare('SELECT id, name FROM topics WHERE id = ?').get(rel.related_id) as { id: number; name: string } | undefined;
            if (topicRow) {
                results.push({
                    id: topicRow.id,
                    name: topicRow.name,
                    relationship_path: newPath,
                    depth: current.depth + 1
                });

                queue.push({ id: rel.related_id, depth: current.depth + 1, path: newPath });
            }
        }
    }

    return results;
}

/**
 * Get all active claims for a set of topics.
 */
export function getTopicClaims(topicIds: number[], status = 'active'): { id: number; claim_text: string; topic_name: string; topic_id: number }[] {
    if (topicIds.length === 0) return [];

    const placeholders = topicIds.map(() => '?').join(',');
    const sql = `
        SELECT kc.id, kc.claim_text, kc.topic_id, t.name as topic_name
        FROM knowledge_claims kc
        JOIN topics t ON kc.topic_id = t.id
        WHERE kc.topic_id IN (${placeholders})
          AND kc.status = ?
        ORDER BY kc.topic_id, kc.created_at
    `;

    return db.prepare(sql).all(...topicIds, status) as { id: number; claim_text: string; topic_name: string; topic_id: number }[];
}

/**
 * Build structured knowledge context from the knowledge graph for a query.
 * This is the main function used by the chat endpoint to retrieve information.
 */
export async function buildKnowledgeContext(query: string, maxTopics = 5, maxClaims = 15): Promise<string> {
    // Step 1: Find most relevant topics
    const relevantTopics = await searchTopics(query, maxTopics);

    if (relevantTopics.length === 0) {
        // Keyword-based fallback: works even when no topic embeddings exist yet
        const words = query.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 3);
        if (words.length > 0) {
            try {
                const likeConditions = words.map(() => "(LOWER(name) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ?)").join(' OR ');
                const likeParams = words.flatMap(w => [`%${w.toLowerCase()}%`, `%${w.toLowerCase()}%`]);
                const fallbackTopics = db.prepare(
                    `SELECT id, name, description, category FROM topics WHERE ${likeConditions} LIMIT ?`
                ).all(...likeParams, maxTopics) as { id: number; name: string; description: string | null; category: string | null }[];
                for (const t of fallbackTopics) {
                    relevantTopics.push({ ...t, score: 0.4 });
                }
            } catch (e) {
                console.warn('[KnowledgeContext] Keyword fallback failed:', (e as Error).message);
            }
        }
        if (relevantTopics.length === 0) {
            console.log(`[KnowledgeContext] No topics found for: "${query.slice(0, 80)}"`);
            return 'No relevant knowledge found for this query.';
        }
    }

    // Step 2: Expand to related topics (depth 1 only to avoid explosion)
    const allTopicIds = new Set<number>(relevantTopics.map(t => t.id));
    const topicMap = new Map<number, { name: string; description: string | null; category: string | null; score: number }>();

    for (const topic of relevantTopics) {
        topicMap.set(topic.id, topic);

        const related = getRelatedTopics(topic.id, 1);
        for (const rel of related) {
            if (!allTopicIds.has(rel.id) && allTopicIds.size < maxTopics * 2) {
                allTopicIds.add(rel.id);
                // Fetch topic details for related topics
                const topicRow = db.prepare('SELECT id, name, description, category FROM topics WHERE id = ?').get(rel.id) as
                    { id: number; name: string; description: string | null; category: string | null } | undefined;
                if (topicRow) {
                    topicMap.set(topicRow.id, { ...topicRow, score: 0.5 }); // Lower score for indirectly related
                }
            }
        }
    }

    // Step 3: Get claims for all topics (primary + related)
    const topicClaims = getTopicClaims(Array.from(allTopicIds), 'active');

    // Step 4: Semantic search for most relevant claims (to ensure we get the best ones)
    const semanticClaims = await searchClaims(query, null, maxClaims);

    // Step 5: Merge and deduplicate claims, prioritizing semantic search results
    const claimMap = new Map<number, { claim_text: string; topic_name: string; topic_id: number; score: number }>();

    for (const claim of semanticClaims) {
        claimMap.set(claim.id, { ...claim, score: claim.score });
    }

    for (const claim of topicClaims) {
        if (!claimMap.has(claim.id) && claimMap.size < maxClaims) {
            claimMap.set(claim.id, { ...claim, score: 0.3 }); // Lower score for topic-based retrieval
        }
    }

    console.log(`[KnowledgeContext] query="${query.slice(0, 60)}" topics=${relevantTopics.length} claims=${claimMap.size}`);

    // Step 6: Build structured context
    const lines: string[] = ['KNOWLEDGE CONTEXT:', ''];

    // Group claims by topic
    const claimsByTopic = new Map<number, { claim_text: string; score: number }[]>();
    for (const claim of claimMap.values()) {
        if (!claimsByTopic.has(claim.topic_id)) {
            claimsByTopic.set(claim.topic_id, []);
        }
        claimsByTopic.get(claim.topic_id)!.push({ claim_text: claim.claim_text, score: claim.score });
    }

    // Output primary topics first, then related
    const sortedTopics = Array.from(topicMap.entries())
        .sort((a, b) => b[1].score - a[1].score);

    for (const [topicId, topic] of sortedTopics) {
        const claims = claimsByTopic.get(topicId);
        if (!claims || claims.length === 0) {
            // Still surface the topic with its description if no claims exist yet
            if (topic.description) {
                lines.push(`### ${topic.name}${topic.category ? ` (${topic.category})` : ''}`);
                lines.push(`*${topic.description}*`);
                lines.push('');
            }
            continue;
        }
        lines.push(`### ${topic.name}${topic.category ? ` (${topic.category})` : ''}`);
        if (topic.description) {
            lines.push(`*${topic.description}*`);
        }
        lines.push('');
        lines.push('**Claims:**');

        // Sort claims by score within topic
        claims.sort((a, b) => b.score - a.score);
        for (const claim of claims) {
            lines.push(`- ${claim.claim_text}`);
        }

        // Show related topics
        const related = getRelatedTopics(topicId, 1);
        if (related.length > 0 && relevantTopics.some(t => t.id === topicId)) {
            const relatedNames = related
                .slice(0, 3)
                .map(r => `${r.name} (${r.relationship_path[0]})`)
                .join(', ');
            lines.push('');
            lines.push(`**Related:** ${relatedNames}`);
        }

        lines.push('');
    }

    return lines.join('\n');
}
