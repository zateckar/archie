import { db } from './db';
import { processDocumentKnowledge } from './knowledge';
import { recomputeCommunities, RELATIONSHIP_WEIGHTS, DEFAULT_EDGE_WEIGHT } from './communities';
import crypto from 'crypto';
import { getEmbedding, rerank, semanticChunk, cleanDocument, summarizeDocument, splitIntoSections } from './gemini';

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight at once.
 * Used for embedding generation, which previously ran one chunk at a time —
 * for a 50-chunk document that meant 50 sequential network round trips before
 * ingestion could even start knowledge extraction. Embedding calls are
 * independent of each other (unlike per-chunk knowledge extraction, which
 * intentionally stays sequential — see the comment in processDocumentKnowledge
 * about why parallelizing that would degrade topic de-duplication quality).
 */
async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

const EMBED_CONCURRENCY = 5;

// ── Embedding dimension configuration ───────────────────────────────────────
// Fallback dimension used ONLY when a vector index needs to be initialized
// and no embeddings exist yet anywhere in that table (so there's nothing to
// detect a real dimension from). Previously this was hardcoded to 768 in one
// place (ensureVectorInit) and as inline literal strings in two others
// (searchTopics, searchClaims), while the ingestion path derived it correctly
// from the actual embedding output — an inconsistency that could silently
// lock in the wrong dimension for the whole vector index if a search ran
// against a fresh, empty table before any document had ever been ingested,
// and the configured EMBEDDING_MODEL's real output dimension differs from
// 768. Overridable via EMBEDDING_DIMENSION so operators aren't stuck with a
// wrong guess if they change EMBEDDING_MODEL to one with a different output
// size (e.g. via Gemini's `outputDimensionality` parameter).
const EMBEDDING_DIMENSION = Number(process.env.EMBEDDING_DIMENSION) || 768;

/**
 * Detects the actual stored embedding dimension from an existing row in
 * `table`, if one exists. Preferred over guessing whenever possible — a
 * table that already has embedded rows tells us its real dimension with
 * certainty, removing any need to trust a hardcoded fallback. Only tables
 * with zero embedded rows (nothing to search yet) fall back to
 * EMBEDDING_DIMENSION, and in that case the fallback's correctness doesn't
 * matter yet, because the first real embedding written (via addDocument /
 * embedTopic / embedClaim, all of which derive dimension from the actual
 * embedding output) is what actually fixes the index's dimension in sqlite-vector.
 */
function detectStoredDimension(table: 'chunks' | 'topics' | 'knowledge_claims'): number | null {
    try {
        const row = db.prepare(`SELECT LENGTH(embedding) AS len FROM ${table} WHERE embedding IS NOT NULL LIMIT 1`).get() as { len: number } | undefined;
        return row ? row.len / 4 : null;
    } catch {
        return null;
    }
}

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

    // Semantic Chunking using LLM, falling back to the regex/markdown chunker
    // only where coverage falls short (see semanticChunkDocument for why
    // large documents no longer skip semantic chunking entirely, and
    // semanticChunkSection for the 80%-coverage safety check).
    const chunks = await semanticChunkDocument(cleanedContent, filename);
    // Enrich chunks with metadata for better embedding context
    const chunksWithMetadata = chunks.map(chunk => `Document: ${metadata.path || filename}\n\n${chunk}`);

    // Fetch all embeddings before opening any transaction. Independent calls,
    // so run them with bounded concurrency instead of one at a time.
    const embeddings = await mapWithConcurrency(
        chunksWithMetadata,
        EMBED_CONCURRENCY,
        (text) => getEmbedding(text, "RETRIEVAL_DOCUMENT", filename)
    );

    // Ensure vector index is initialised before the transaction
    if (embeddings.length > 0) {
        try {
            db.prepare("SELECT vector_init('chunks', 'embedding', ?)").get(`dimension=${embeddings[0].length},distance=cosine`);
        } catch (e) {
            // Already initialised
        }
    }

    // ── Phase 2: fast synchronous DB writes (transaction is brief) ────────────
    const { docId, chunkRecords } = db.transaction(() => {
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

        const chunkRecords: { id: number; content: string }[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunkResult = db.prepare('INSERT INTO chunks (doc_id, content, embedding) VALUES (?, ?, vector_as_f32(?)) RETURNING id')
                .get(newDocId, chunks[i], JSON.stringify(embeddings[i])) as { id: number };
            chunkRecords.push({ id: chunkResult.id, content: chunks[i] });
        }

        return { docId: newDocId, chunkRecords };
    })();

    // ── Phase 3: async knowledge processing (outside any transaction) ─────────
    await processDocumentKnowledge(Number(docId), chunkRecords, summary);

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
    const dimension = detectStoredDimension('chunks') ?? EMBEDDING_DIMENSION;
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
        let chunkRows: { id: number; content: string }[];
        if (options.rechunk) {
            db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(doc.id);
            // Re-embed via the regular pipeline
            await embedAndStoreChunks(doc.id, doc.filename, doc.content, undefined);
            chunkRows = db.prepare('SELECT id, content FROM chunks WHERE doc_id = ?').all(doc.id) as { id: number; content: string }[];
        } else {
            chunkRows = db.prepare('SELECT id, content FROM chunks WHERE doc_id = ?').all(doc.id) as { id: number; content: string }[];
        }

        if (chunkRows.length === 0) {
            console.warn(`Doc ${doc.id} (${doc.filename}) has no chunks; skipping knowledge processing.`);
            continue;
        }

        await processDocumentKnowledge(doc.id, chunkRows, doc.summary ?? undefined);
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
    const chunks = await semanticChunkDocument(content, filename);
    const chunksWithMetadata = chunks.map((chunk) => `Document: ${pathHint || filename}\n\n${chunk}`);

    // Independent calls — fetch with bounded concurrency, then write sequentially
    // (DB writes are cheap/synchronous; only the network-bound embedding calls
    // benefit from parallelism).
    const embeddings = await mapWithConcurrency(
        chunksWithMetadata,
        EMBED_CONCURRENCY,
        (text) => getEmbedding(text, 'RETRIEVAL_DOCUMENT', filename)
    );

    for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddings[i];
        const dimension = embedding.length;
        try {
            db.prepare("SELECT vector_init('chunks', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
        } catch (e) {
            // already initialized
        }
        db.prepare('INSERT INTO chunks (doc_id, content, embedding) VALUES (?, ?, vector_as_f32(?))').run(
            docId,
            chunks[i],
            JSON.stringify(embedding)
        );
    }
    return chunks;
}

// Semantic (LLM) chunking used to be limited outright to documents under
// 50K chars, with anything larger falling back ENTIRELY to the regex/
// markdown chunker below — inverting the relationship between document size
// and chunking quality (the largest, most content-rich documents got the
// dumbest treatment, precisely where good section boundaries matter most).
// Documents over this size are now split into sections first (reusing the
// same markdown-aware splitter cleanDocument's own large-document path uses)
// and each section is semantically chunked independently, so every part of
// a large document still gets a chance at LLM-quality chunking; only
// sections that individually fail the coverage bar fall back to regex.
const SEMANTIC_CHUNK_SECTION_SIZE = 45000;
const CHUNK_COVERAGE_THRESHOLD = 0.8;

/**
 * Semantically chunk a single section (must already be under
 * SEMANTIC_CHUNK_SECTION_SIZE), falling back to the regex chunker if the LLM
 * result doesn't cover at least CHUNK_COVERAGE_THRESHOLD of the section's
 * characters (guards against silent truncation when the LLM hits output
 * token limits or returns partial JSON).
 */
async function semanticChunkSection(section: string, label: string): Promise<string[]> {
    const semantic = await semanticChunk(section);
    const coveredChars = semantic.reduce((n: number, c: string) => n + (c?.length ?? 0), 0);
    if (semantic.length > 0 && coveredChars >= section.length * CHUNK_COVERAGE_THRESHOLD) {
        return semantic;
    }
    if (semantic.length > 0) {
        console.warn(
            `Semantic chunking covered only ${Math.round((100 * coveredChars) / section.length)}% of "${label}" (${semantic.length} chunks); falling back to markdown-aware chunker for this section.`
        );
    }
    return chunkText(section, 1500, 200);
}

/**
 * Chunk a full (already-cleaned) document into embeddable pieces, preferring
 * LLM semantic chunking over the regex fallback wherever feasible — see
 * SEMANTIC_CHUNK_SECTION_SIZE above for why large documents no longer skip
 * semantic chunking entirely.
 */
async function semanticChunkDocument(content: string, label: string): Promise<string[]> {
    if (content.length <= SEMANTIC_CHUNK_SECTION_SIZE) {
        return semanticChunkSection(content, label);
    }

    const sections = splitIntoSections(content, SEMANTIC_CHUNK_SECTION_SIZE);
    console.log(`[Chunking] "${label}" is ${content.length} chars — splitting into ${sections.length} section(s) for semantic chunking instead of falling back entirely to the regex chunker.`);

    const allChunks: string[] = [];
    for (const section of sections) {
        allChunks.push(...(await semanticChunkSection(section, label)));
    }
    return allChunks;
}

function chunkText(text: string, maxChars: number, overlap: number = 200): string[] {
    // Markdown-aware chunking
    // 1. Split by headers
    const sections = text.split(/(?=\n#{1,6} )/);
    const chunks: string[] = [];

    // Accumulates consecutive small (<=maxChars) sections instead of emitting
    // each as its own chunk. Header-dense documents (reference/API-style docs
    // with many short subsections) previously produced a pile of tiny,
    // context-poor chunks — e.g. a 40-char "### Prerequisites\n- Node 18+"
    // section embedded and retrieved in near-total isolation — instead of
    // packing adjacent small sections up to maxChars like the paragraph-level
    // logic below already does within an oversized section.
    let pendingSmallSections = "";
    function flushPending() {
        if (pendingSmallSections.trim()) {
            chunks.push(pendingSmallSections.trim());
        }
        pendingSmallSections = "";
    }

    for (const section of sections) {
        if (section.length <= maxChars) {
            if ((pendingSmallSections.length + section.length) <= maxChars) {
                pendingSmallSections += section;
            } else {
                flushPending();
                pendingSmallSections = section;
            }
        } else {
            flushPending();
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
    flushPending();
    return chunks.filter(c => c.length > overlap / 2); // Filter out tiny chunks that are mostly overlap
}

// Cosine similarity has no natural cutoff — vector_full_scan(..., limit)
// always returns up to `limit` rows in distance order regardless of whether
// any of them are actually relevant to the query. Without a floor,
// searchTopics(query, 5) returns close to 5 results for almost any query,
// including ones that are off-corpus or only tangentially related, diluting
// buildKnowledgeContext's briefing with weakly-related material. Below this
// threshold a topic is dropped rather than force-filled; buildKnowledgeContext
// already has a keyword-based (LIKE) fallback for the "nothing cleared the
// bar" case, so returning fewer (or zero) results here correctly hands off
// to that fallback instead of injecting a barely-related vector match.
const MIN_TOPIC_RELEVANCE = 0.45;
const MIN_CLAIM_RELEVANCE = 0.4;

/**
 * Semantic search on topics using embeddings.
 * Returns topics ranked by relevance to the query, filtered to those that
 * clear `minScore` (see MIN_TOPIC_RELEVANCE for rationale).
 *
 * `useRerank`: when true, over-fetches a wider candidate pool and runs it
 * through the same LLM reranker searchChunks() already uses for chunks.
 * Previously chunks were the only retrieval type that got LLM reranking —
 * topics and claims (the primary structured-knowledge path) relied on raw
 * cosine order alone. Off by default so callers that don't need the extra
 * LLM round trip (e.g. the vocabulary-hint lookup during ingestion) don't
 * pay for it; buildKnowledgeContext enables it for the query-facing search.
 */
export async function searchTopics(query: string, limit = 10, minScore = MIN_TOPIC_RELEVANCE, useRerank = false): Promise<{ id: number; name: string; description: string | null; category: string | null; score: number }[]> {
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");

    try {
        const dimension = detectStoredDimension('topics') ?? EMBEDDING_DIMENSION;
        db.prepare("SELECT vector_init('topics', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    try {
        const fetchLimit = useRerank ? Math.max(limit * 3, 15) : limit;
        const results = db.prepare(`
            SELECT t.id, t.name, t.description, t.category,
                   (1 - v.distance) as score
            FROM vector_full_scan('topics', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
            JOIN topics t ON t.id = v.rowid
            WHERE t.embedding IS NOT NULL
            ORDER BY v.distance ASC
        `).all(JSON.stringify(queryEmbedding), fetchLimit) as { id: number; name: string; description: string | null; category: string | null; score: number }[];

        const filtered = results.filter(r => r.score >= minScore);
        if (!useRerank || filtered.length <= limit) {
            return filtered.slice(0, limit);
        }

        const rankedIndices = await rerank(query, filtered.map(t => ({ content: `${t.name}: ${t.description ?? ''}` })));
        return rankedIndices.map(i => filtered[i]).filter(Boolean).slice(0, limit);
    } catch (e) {
        console.warn('searchTopics failed (no embeddings or vector extension unavailable):', (e as Error).message);
        return [];
    }
}

/**
 * Semantic search on claims, optionally filtered by topic IDs.
 *
 * `useRerank`: see searchTopics — over-fetches a wider pool and applies the
 * same LLM reranker used for chunks, instead of relying on raw cosine order.
 */
export async function searchClaims(
    query: string,
    topicIds: number[] | null = null,
    limit = 20,
    minScore = MIN_CLAIM_RELEVANCE,
    useRerank = false
): Promise<{ id: number; claim_text: string; topic_name: string; topic_id: number; doc_id: number; score: number; claim_type: string; filename: string; path: string | null }[]> {
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");

    try {
        const dimension = detectStoredDimension('knowledge_claims') ?? EMBEDDING_DIMENSION;
        db.prepare("SELECT vector_init('knowledge_claims', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    try {
        let sql: string;
        let params: any[];
        const fetchLimit = useRerank ? Math.max(limit * 2, 20) : limit * 2;

        if (topicIds && topicIds.length > 0) {
            const placeholders = topicIds.map(() => '?').join(',');
            sql = `
                SELECT kc.id, kc.claim_text, kc.topic_id, kc.doc_id, t.name as topic_name,
                       COALESCE(kc.claim_type, 'assertion') as claim_type,
                       COALESCE(d.filename, '') as filename, d.path,
                       (1 - v.distance) as score
                FROM vector_full_scan('knowledge_claims', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
                JOIN knowledge_claims kc ON kc.id = v.rowid
                JOIN topics t ON kc.topic_id = t.id
                LEFT JOIN documents d ON kc.doc_id = d.id
                WHERE kc.embedding IS NOT NULL
                  AND kc.status = 'active'
                  AND kc.topic_id IN (${placeholders})
                ORDER BY v.distance ASC
            `;
            params = [JSON.stringify(queryEmbedding), fetchLimit, ...topicIds]; // Fetch more then filter
        } else {
            sql = `
                SELECT kc.id, kc.claim_text, kc.topic_id, kc.doc_id, t.name as topic_name,
                       COALESCE(kc.claim_type, 'assertion') as claim_type,
                       COALESCE(d.filename, '') as filename, d.path,
                       (1 - v.distance) as score
                FROM vector_full_scan('knowledge_claims', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
                JOIN knowledge_claims kc ON kc.id = v.rowid
                JOIN topics t ON kc.topic_id = t.id
                LEFT JOIN documents d ON kc.doc_id = d.id
                WHERE kc.embedding IS NOT NULL
                  AND kc.status = 'active'
                ORDER BY v.distance ASC
            `;
            params = [JSON.stringify(queryEmbedding), fetchLimit];
        }

        const results = db.prepare(sql).all(...params) as { id: number; claim_text: string; topic_name: string; topic_id: number; doc_id: number; score: number; claim_type: string; filename: string; path: string | null }[];
        const filtered = results.filter(r => r.score >= minScore);

        if (!useRerank || filtered.length <= limit) {
            return filtered.slice(0, limit);
        }

        const rankedIndices = await rerank(query, filtered.map(c => ({ content: `[${c.topic_name}] ${c.claim_text}` })));
        return rankedIndices.map(i => filtered[i]).filter(Boolean).slice(0, limit);
    } catch (e) {
        console.warn('searchClaims failed (no embeddings or vector extension unavailable):', (e as Error).message);
        return [];
    }
}

/**
 * Traverse topic relationships via BFS to find related topics.
 * Returns topics connected to the starting topic within maxDepth hops.
 *
 * Relationships are explored in descending edge-weight order (using the same
 * RELATIONSHIP_WEIGHTS map community detection uses) so that when a caller
 * caps how many related topics it will accept — see buildKnowledgeContext's
 * `allTopicIds.size < maxTopics * 2` — strong structural relationships
 * (is_part_of, is_a, governs) are preferred over weak referential ones
 * (references, uses) instead of whichever order SQLite happens to return.
 */
export function getRelatedTopics(topicId: number, maxDepth = 2): { id: number; name: string; relationship_path: string[]; depth: number; weight: number }[] {
    const visited = new Set<number>();
    const queue: { id: number; depth: number; path: string[] }[] = [{ id: topicId, depth: 0, path: [] }];
    const results: { id: number; name: string; relationship_path: string[]; depth: number; weight: number }[] = [];

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

        // Strongest relationships first, so BFS discovers/queues the most
        // structurally significant neighbors before weaker ones at this level.
        relationships.sort((a, b) => {
            const wa = RELATIONSHIP_WEIGHTS[a.rel_type.replace(/^inverse_/, '')] ?? DEFAULT_EDGE_WEIGHT;
            const wb = RELATIONSHIP_WEIGHTS[b.rel_type.replace(/^inverse_/, '')] ?? DEFAULT_EDGE_WEIGHT;
            return wb - wa;
        });

        for (const rel of relationships) {
            if (visited.has(rel.related_id)) continue;

            visited.add(rel.related_id);
            const newPath = [...current.path, rel.rel_type];
            const weight = RELATIONSHIP_WEIGHTS[rel.rel_type.replace(/^inverse_/, '')] ?? DEFAULT_EDGE_WEIGHT;

            // Get topic name
            const topicRow = db.prepare('SELECT id, name FROM topics WHERE id = ?').get(rel.related_id) as { id: number; name: string } | undefined;
            if (topicRow) {
                results.push({
                    id: topicRow.id,
                    name: topicRow.name,
                    relationship_path: newPath,
                    depth: current.depth + 1,
                    weight
                });

                queue.push({ id: rel.related_id, depth: current.depth + 1, path: newPath });
            }
        }
    }

    // Present strongest relationships first regardless of which BFS depth found them.
    return results.sort((a, b) => b.weight - a.weight || a.depth - b.depth);
}

/**
 * Get all active claims for a set of topics.
 */
export function getTopicClaims(topicIds: number[], status = 'active'): { id: number; claim_text: string; topic_name: string; topic_id: number; claim_type: string; filename: string; path: string | null }[] {
    if (topicIds.length === 0) return [];

    const placeholders = topicIds.map(() => '?').join(',');
    const sql = `
        SELECT kc.id, kc.claim_text, kc.topic_id, t.name as topic_name,
               COALESCE(kc.claim_type, 'assertion') as claim_type,
               COALESCE(d.filename, '') as filename, d.path
        FROM knowledge_claims kc
        JOIN topics t ON kc.topic_id = t.id
        LEFT JOIN documents d ON kc.doc_id = d.id
        WHERE kc.topic_id IN (${placeholders})
          AND kc.status = ?
        ORDER BY kc.topic_id, kc.created_at
    `;

    return db.prepare(sql).all(...topicIds, status) as { id: number; claim_text: string; topic_name: string; topic_id: number; claim_type: string; filename: string; path: string | null }[];
}

/**
 * Get active AND conflicting claims for a set of topics, tagged with their
 * status. Unlike `getTopicClaims('active')`, this surfaces `conflicting`
 * claims too (capped per topic) so callers can present documented
 * contradictions instead of silently hiding them. Previously, claims flagged
 * `conflicting` by the consistency checker were written to the DB but never
 * read back by anything — `synthesizeContext`'s prompt explicitly asks the
 * model to "note contradictions or gaps", but it never had any contradictory
 * material to work with because this data path excluded them entirely.
 */
export function getTopicClaimsWithConflicts(
    topicIds: number[],
    maxConflictingPerTopic = 3
): { id: number; claim_text: string; topic_name: string; topic_id: number; claim_type: string; filename: string; path: string | null; status: string }[] {
    if (topicIds.length === 0) return [];

    const placeholders = topicIds.map(() => '?').join(',');
    const sql = `
        SELECT kc.id, kc.claim_text, kc.topic_id, t.name as topic_name,
               COALESCE(kc.claim_type, 'assertion') as claim_type,
               COALESCE(d.filename, '') as filename, d.path, kc.status
        FROM knowledge_claims kc
        JOIN topics t ON kc.topic_id = t.id
        LEFT JOIN documents d ON kc.doc_id = d.id
        WHERE kc.topic_id IN (${placeholders})
          AND kc.status IN ('active', 'conflicting')
        ORDER BY kc.topic_id, kc.status, kc.created_at
    `;

    const rows = db.prepare(sql).all(...topicIds) as { id: number; claim_text: string; topic_name: string; topic_id: number; claim_type: string; filename: string; path: string | null; status: string }[];

    // Cap conflicting claims per topic so a topic with a long history of
    // superseded/contradicted claims doesn't crowd out the active facts.
    const conflictingCountByTopic = new Map<number, number>();
    return rows.filter(r => {
        if (r.status !== 'conflicting') return true;
        const count = conflictingCountByTopic.get(r.topic_id) ?? 0;
        if (count >= maxConflictingPerTopic) return false;
        conflictingCountByTopic.set(r.topic_id, count + 1);
        return true;
    });
}

export interface KnowledgeContextResult {
    text: string;
    topicCount: number;
    claimCount: number;
    hasConflicts: boolean;
}

/**
 * Build structured knowledge context from the knowledge graph for a query.
 * This is the main function used by the chat endpoint to retrieve information.
 *
 * Returns metadata (topicCount/claimCount/hasConflicts) alongside the text so
 * callers can make cheap decisions — e.g. the chat endpoint skips the extra
 * `synthesizeContext` LLM pass entirely for simple single-topic queries that
 * are already well covered, instead of always paying for a reformatting pass.
 */
export async function buildKnowledgeContext(query: string, maxTopics = 5, maxClaims = 15): Promise<KnowledgeContextResult> {
    // Step 1: Find most relevant topics. Reranked — this is the primary
    // query-facing retrieval path, so it's worth the extra LLM round trip
    // (previously only searchChunks() got LLM reranking; topics/claims relied
    // on raw cosine order alone).
    const relevantTopics = await searchTopics(query, maxTopics, MIN_TOPIC_RELEVANCE, true);

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
            return { text: 'No relevant knowledge found for this query.', topicCount: 0, claimCount: 0, hasConflicts: false };
        }
    }

    // Step 2: Expand to related topics (depth 1 only to avoid explosion).
    // getRelatedTopics now returns strongest relationships first, so when the
    // `maxTopics * 2` cap is hit, structurally significant neighbors
    // (is_part_of, is_a, governs, ...) win over weak referential ones.
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

    // Step 3: Get claims for all topics (primary + related), including
    // documented conflicts so they can be surfaced rather than silently
    // dropped (previously `status='conflicting'` claims were written to the
    // DB but never read back by any retrieval path).
    const topicClaims = getTopicClaimsWithConflicts(Array.from(allTopicIds));

    // Step 4: Semantic search for most relevant claims (to ensure we get the best ones).
    // Reranked for the same reason as the topic search above.
    const semanticClaims = await searchClaims(query, null, maxClaims, MIN_CLAIM_RELEVANCE, true);

    // Step 5: Merge and deduplicate claims, prioritizing semantic search results
    const claimMap = new Map<number, { claim_text: string; topic_name: string; topic_id: number; score: number; claim_type: string; filename?: string; path?: string | null; status: string }>();

    // Conflicting claims are inserted FIRST and unconditionally (they're already
    // capped per-topic at the source by getTopicClaimsWithConflicts). If these
    // were subject to the same `claimMap.size < maxClaims` cap as everything
    // else, a topic with many active claims — like the pre-existing "SLA
    // Management" topic in this corpus — fills the cap before the loop ever
    // reaches its one conflicting claim (status sorts after 'active' in the
    // source query), silently dropping exactly the signal `getTopicClaimsWithConflicts`
    // exists to surface. Conflicts are rare in practice, so guaranteeing them a
    // slot doesn't meaningfully crowd out active facts.
    for (const claim of topicClaims) {
        if (claim.status === 'conflicting' && !claimMap.has(claim.id)) {
            claimMap.set(claim.id, { ...claim, score: 0.2, claim_type: claim.claim_type || 'assertion' });
        }
    }

    for (const claim of semanticClaims) {
        if (!claimMap.has(claim.id)) {
            claimMap.set(claim.id, { ...claim, score: claim.score, claim_type: claim.claim_type || 'assertion', status: 'active' });
        }
    }

    for (const claim of topicClaims) {
        if (claim.status !== 'conflicting' && !claimMap.has(claim.id) && claimMap.size < maxClaims) {
            claimMap.set(claim.id, { ...claim, score: 0.3, claim_type: claim.claim_type || 'assertion' });
        }
    }

    // Boost constraint claims for question queries
    if (/\b(does|can|is|should|will|could|would|may|might)\b/i.test(query)) {
        for (const [id, claim] of claimMap) {
            if (['negation', 'condition', 'boundary'].includes(claim.claim_type)) {
                claim.score *= 1.5;
            }
        }
    }

    const hasConflicts = Array.from(claimMap.values()).some(c => c.status === 'conflicting');
    console.log(`[KnowledgeContext] query="${query.slice(0, 60)}" topics=${relevantTopics.length} claims=${claimMap.size}${hasConflicts ? ' (includes conflicting claims)' : ''}`);

    // Step 6: Build structured context
    const lines: string[] = ['KNOWLEDGE CONTEXT:', ''];

    // Group claims by topic, separating active from conflicting
    const claimsByTopic = new Map<number, { claim_text: string; score: number; claim_type: string; source?: string; status: string }[]>();
    for (const claim of claimMap.values()) {
        if (!claimsByTopic.has(claim.topic_id)) {
            claimsByTopic.set(claim.topic_id, []);
        }
        claimsByTopic.get(claim.topic_id)!.push({
            claim_text: claim.claim_text,
            score: claim.score,
            claim_type: claim.claim_type || 'assertion',
            source: claim.path || claim.filename,
            status: claim.status
        });
    }

    // Output primary topics first, then related
    const sortedTopics = Array.from(topicMap.entries())
        .sort((a, b) => b[1].score - a[1].score);

    // Counts topics that actually rendered content (a claim or a description),
    // as opposed to `relevantTopics.length` which is just the raw semantic
    // -search result count. searchTopics(query, 5) tends to return close to 5
    // results for almost any query regardless of how relevant they actually
    // are (cosine similarity has no natural cutoff), so using that raw count
    // for the synthesis-skip decision in the chat endpoint would make the
    // "single-topic query" fast path effectively never fire. Counting
    // topics-with-actual-content is a much more honest signal of how complex
    // this context really is.
    let topicsWithContent = 0;

    for (const [topicId, topic] of sortedTopics) {
        const allClaimsForTopic = claimsByTopic.get(topicId);
        if (!allClaimsForTopic || allClaimsForTopic.length === 0) {
            // Still surface the topic with its description if no claims exist yet
            if (topic.description) {
                lines.push(`### ${topic.name}${topic.category ? ` (${topic.category})` : ''}`);
                lines.push(`*${topic.description}*`);
                lines.push('');
                topicsWithContent++;
            }
            continue;
        }

        const claims = allClaimsForTopic.filter(c => c.status !== 'conflicting');
        const conflicting = allClaimsForTopic.filter(c => c.status === 'conflicting');
        topicsWithContent++;

        lines.push(`### ${topic.name}${topic.category ? ` (${topic.category})` : ''}`);
        if (topic.description) {
            lines.push(`*${topic.description}*`);
        }
        lines.push('');
        // Sort claims by score within topic
        claims.sort((a, b) => b.score - a.score);

        const assertions = claims.filter(c => c.claim_type === 'assertion' || !c.claim_type);
        const constraints = claims.filter(c => ['negation', 'condition', 'boundary', 'comparison'].includes(c.claim_type));

        if (assertions.length > 0) {
            lines.push('**Facts:**');
            for (const c of assertions) {
                lines.push(`- ${c.claim_text}${c.source ? ` [${c.source}]` : ''}`);
            }
        }
        if (constraints.length > 0) {
            lines.push('**Constraints & Exceptions:**');
            for (const c of constraints) {
                lines.push(`- ${c.claim_text}${c.source ? ` [${c.source}]` : ''}`);
            }
        }
        if (assertions.length === 0 && constraints.length === 0 && claims.length > 0) {
            lines.push('**Claims:**');
            for (const c of claims) {
                lines.push(`- ${c.claim_text}${c.source ? ` [${c.source}]` : ''}`);
            }
        }

        if (conflicting.length > 0) {
            conflicting.sort((a, b) => b.score - a.score);
            lines.push('**⚠ Disputed / Unverified (conflicts with another claim on this topic — treat with caution and flag the discrepancy to the user):**');
            for (const c of conflicting) {
                lines.push(`- ${c.claim_text}${c.source ? ` [${c.source}]` : ''}`);
            }
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

    return {
        text: lines.join('\n'),
        topicCount: topicsWithContent,
        claimCount: claimMap.size,
        hasConflicts
    };
}
