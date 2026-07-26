import { db, recordCleanLog } from './db';
import { processDocumentKnowledge } from './knowledge';
import {
    recomputeCommunities,
    getCommunityReportTopics,
    RELATIONSHIP_WEIGHTS,
    DEFAULT_EDGE_WEIGHT
} from './communities';
import crypto from 'crypto';
import { getEmbedding, rerank, semanticChunk, cleanDocument, summarizeDocument, splitIntoSections, clearEmbeddingCache } from './llm';
import { buildKeywordProbe, mergeByIdKeepingBestScore } from './retrieval-probe';
import { buildFtsMatchQuery, tokenizeForFts } from './fts-query';
import { foldDiacritics } from './topic-normalize';
import {
    storedDimension,
    distinctDimensions,
    assertStorableEmbedding,
    assertUniformEmbeddings,
    type EmbeddedTable
} from './embedding-dimension';
import {
    runVectorScan,
    markVectorIndexDirty,
    markAllVectorIndexesDirty,
    warmVectorIndexes
} from './vector-index';

/**
 * Escapes the LIKE metacharacters `%` and `_` (and the escape character itself)
 * so a keyword is matched literally. Callers must pair this with `ESCAPE '\'`.
 *
 * Not paranoia: measured, `'Rizeni projektu' LIKE '%r_zeni%'` returns a row.
 * This repo's own extracted vocabulary contains underscores — relationship types
 * like `is_part_of`, and `TECHNICAL_TOKEN` identifiers like `max_connections` —
 * so an unescaped `_` is a live false-positive source, not a theoretical one.
 */
function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * SQLite's LOWER() and LIKE are ASCII-only, so no SQL expression can fold
 * `Řízení` down to `rizeni` for comparison. `topics.canonical_key` solves that
 * for topic names (it is stored pre-folded), but `topics.description` has no
 * folded counterpart — so the fold has to be handed to SQLite as a function.
 *
 * Registered lazily from here rather than at the db.ts handle setup because the
 * only consumer is `buildKnowledgeContext`'s fallback, and db.ts must not take a
 * dependency on the diacritic-folding module for one caller's benefit. Guarded
 * by a module-level flag: better-sqlite3 throws if the same function name is
 * registered twice.
 */
let foldFunctionRegistered = false;
function registerFoldFunction(): void {
    if (foldFunctionRegistered) return;
    try {
        db.function('fold', { deterministic: true }, (value: unknown) =>
            foldDiacritics(String(value ?? '').toLowerCase())
        );
        foldFunctionRegistered = true;
    } catch (e) {
        // Already registered by another module instance (Vite dev re-evaluation).
        foldFunctionRegistered = true;
    }
}
import * as providers from './providers';

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight at once.
 * Used for embedding generation, which previously ran one chunk at a time —
 * for a 50-chunk document that meant 50 sequential network round trips before
 * ingestion could even start knowledge extraction.
 *
 * Also used by `processDocumentKnowledge` for its per-chunk and per-claim work;
 * exported for that reason. See the concurrency notes there for why chunk-level
 * parallelism is bounded and batched rather than unlimited.
 */
export async function mapWithConcurrency<T, R>(
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
// Dimension detection and the write-side guard live in ./embedding-dimension so
// communities.ts can share them without importing this module (rag.ts already
// imports communities.ts, so the reverse direction would be a cycle).
const detectStoredDimension = storedDimension;

export async function addDocument(
    filename: string,
    content: string,
    /**
     * `batch: true` marks this as one document in a bulk ingestion (git sync).
     * The community partition is still recomputed — leaving community_id stale
     * would break the thematic retrieval path — but the expensive LLM-written
     * community reports are suppressed. The batch caller MUST finish with an
     * unsuppressed `recomputeCommunities()`, or the corpus ends up with reports
     * describing a partition that has since been renumbered.
     */
    metadata: { repoId?: number, path?: string, batch?: boolean } = {}
) {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    // ── Phase 0: Document preprocessing ──────────────────────────────────────
    // Clean the document to remove noise, then generate a comprehensive summary.
    // Cleaning is deletion + reformatting only (no paraphrase/translation) and
    // returns a structured audit of what it removed plus a verification verdict,
    // which we persist below so aggressive noise removal stays inspectable.
    // The summary captures the document's overall meaning and aids knowledge extraction.
    const cleanResult = await cleanDocument(content);
    const cleanedContent = cleanResult.text;
    const summary = await summarizeDocument(cleanedContent, filename);
    console.log(`[DocPreprocess] "${filename}": cleaned ${content.length} → ${cleanedContent.length} chars (verdict=${cleanResult.verdict}, preserved=${Math.round(cleanResult.preservedRatio * 100)}%, removals=${cleanResult.removals.length}), summary: ${summary.length} chars`);

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

    // Reject a mixed-dimension batch before the transaction opens — see
    // assertUniformEmbeddings. A provider fallback partway through this
    // document's chunks would otherwise write rows that vector search silently
    // ignores for the rest of their existence.
    assertUniformEmbeddings('chunks', embeddings, `document "${filename}"`);

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

        // Store the CLEANED content, not the raw original: every chunk, embedding,
        // and knowledge claim below is derived from `cleanedContent`, so the
        // persisted document must match it (otherwise the stored document text
        // diverges from its own chunks, and reprocessing/re-chunking would work
        // from text that never matched what was indexed). The raw source remains
        // preserved separately (wiki_files table / git working tree). content_hash
        // stays keyed on the raw input so change-detection still triggers on
        // source edits even when cleaning output is stable.
        const result = db.prepare('INSERT INTO documents (filename, content, context, summary, repo_id, path, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            filename,
            cleanedContent,
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

    // New chunk embeddings invalidate the quantized index: until it is rebuilt,
    // searches must not run against a structure that predates this document, or
    // the document just ingested would be unfindable. See ./vector-index.
    markVectorIndexDirty('chunks');

    // Persist the cleaning audit log now that we have a docId. Aggressive noise
    // removal is inspectable via the document_clean_log table: verdict tells you
    // whether cleaning was accepted / flagged / fell back, and `removals` records
    // every span the cleaner dropped and why.
    recordCleanLog({
        docId,
        filename,
        originalChars: content.length,
        cleanedChars: cleanedContent.length,
        verdict: cleanResult.verdict,
        preservedRatio: cleanResult.preservedRatio,
        removals: cleanResult.removals
    });

    // ── Phase 3: async knowledge processing (outside any transaction) ─────────
    await processDocumentKnowledge(Number(docId), chunkRecords, summary);

    // ── Phase 4: Community detection (outside any transaction) ─────────────────
    // Recompute communities after knowledge extraction. Full recompute is fast
    // (<100ms for <5000 nodes) so no incremental heuristic is needed. Community
    // *reports* are not fast — see the `batch` flag above.
    try {
        await recomputeCommunities({ refreshReports: !metadata.batch });
    } catch (err) {
        console.error('[CommunityDetection] Recompute failed:', err);
    }

    return { docId, cleanedContent };
}

async function ensureVectorInit() {
    // Block on any pending dimension migration so a search can't lock the index
    // to a stale dimension while reembedAll() is mid-flight. After the first
    // boot-time call this resolves immediately (shared guarded promise).
    await ensureEmbeddingsMigrated();
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
    // Topics have no FTS fallback — searchTopics is pure vector — so a
    // wrong-dimension row here is a topic that can never be retrieved again.
    const dimension = assertStorableEmbedding('topics', embedding, `topic "${name}"`);

    try {
        db.prepare("SELECT vector_init('topics', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    db.prepare('UPDATE topics SET embedding = vector_as_f32(?), embedding_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(embedding), topicId);

    // An in-place re-embed leaves the row count unchanged, so the count check in
    // vector-index.ts cannot detect it — this signal is what makes it safe.
    markVectorIndexDirty('topics');
}

/**
 * Generate and store embedding for a claim. Called when claim is created or updated.
 */
export async function embedClaim(claimId: number, claimText: string, topicName: string) {
    const embeddingText = `Topic: ${topicName}\nClaim: ${claimText}`;
    const embedding = await getEmbedding(embeddingText, "RETRIEVAL_DOCUMENT", topicName);
    // As with topics: searchClaims is pure vector, so a mismatched dimension
    // silently removes this claim from retrieval permanently.
    const dimension = assertStorableEmbedding('knowledge_claims', embedding, `claim ${claimId} on "${topicName}"`);

    try {
        db.prepare("SELECT vector_init('knowledge_claims', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    db.prepare('UPDATE knowledge_claims SET embedding = vector_as_f32(?), embedding_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(embedding), claimId);

    markVectorIndexDirty('knowledge_claims');
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

/**
 * Re-embeds the ENTIRE corpus (chunks, topics, claims) from scratch.
 *
 * Required when switching the embedding provider/model to one that produces a
 * DIFFERENT vector dimension than the stored vectors (e.g. moving from Gemini's
 * 3072-dim embeddings to the LiteLLM gateway's 4096-dim embeddings). Query and
 * stored vectors MUST share a model/dimension, so all previously stored vectors
 * are stale and vector search silently returns nothing until they're rebuilt.
 *
 * Chunk *text* is preserved and re-embedded as-is (no re-chunking / re-cleaning);
 * only the `embedding` blobs are regenerated with the currently-configured
 * embedding provider (see getEmbedding → providers.embedContent).
 *
 * IMPORTANT: sqlite-vector locks a column's dimension for the life of the
 * connection once `vector_init` runs against it. Run this in a FRESH process
 * (e.g. the reembed script) so the index isn't already pinned to the old
 * dimension. This function clears the stored blobs first (so dimension
 * auto-detection can't re-lock the old size) and then re-initializes each index
 * from the first new embedding's length.
 */
export async function reembedAll(): Promise<{ chunks: number; topics: number; claims: number; communityReports: number; dimension: number | null }> {
    console.log('[Reembed] Starting full corpus re-embedding...');

    // Flush the query-embedding cache on the way in AND on the way out. A vector
    // cached before this point was produced by the old provider/dimension; handed
    // to vector_full_scan against a freshly re-locked index it throws, and every
    // search's catch swallows that into an empty result set with nothing pointing
    // at the cache as the cause. TTL expiry is not sufficient — this needs to be
    // explicit and immediate.
    clearEmbeddingCache();

    // Every quantized structure in the database describes vectors that are about
    // to be deleted, so nothing may search one until it has been rebuilt from the
    // new embeddings. Marked before the first write, not after the last: searches
    // can arrive while this runs (it is long), and an approximate scan mid-migration
    // would be answering from the old dimension's index.
    markAllVectorIndexesDirty();

    // 1. Clear all stored embeddings so nothing pins the old dimension.
    //
    // `community_reports` is included, and was previously missed. Its embeddings
    // are written by communities.ts and read by searchCommunities, so a re-embed
    // that skipped them left the thematic retrieval path holding old-dimension
    // vectors after every migration — and vector_full_scan skips mismatched rows
    // silently while searchCommunities' catch turns the rest into `[]`, so the
    // whole thematic layer went quiet with nothing in the logs. Wrapped because
    // the table is created defensively in db.ts and may not exist on an older DB.
    db.exec(`
        UPDATE chunks SET embedding = NULL;
        UPDATE topics SET embedding = NULL;
        UPDATE knowledge_claims SET embedding = NULL;
    `);
    let reportsCleared = false;
    try {
        db.exec('UPDATE community_reports SET embedding = NULL');
        reportsCleared = true;
    } catch {
        // Pre-migration DB without the community_reports table.
    }
    console.log(
        `[Reembed] Cleared existing embeddings on chunks, topics, knowledge_claims${reportsCleared ? ', community_reports' : ''}.`
    );

    let newDimension: number | null = null;
    const initIndex = (table: string, dimension: number) => {
        try {
            db.prepare("SELECT vector_init(?, 'embedding', ?)").get(table, `dimension=${dimension},distance=cosine`);
        } catch {
            // already initialized this connection
        }
    };

    // 2. Re-embed chunks (from their existing, already-cleaned content).
    const chunkRows = db.prepare('SELECT c.id, c.content, d.filename FROM chunks c JOIN documents d ON c.doc_id = d.id').all() as
        { id: number; content: string; filename: string }[];
    console.log(`[Reembed] Re-embedding ${chunkRows.length} chunks...`);
    const chunkEmbeddings = await mapWithConcurrency(
        chunkRows,
        EMBED_CONCURRENCY,
        (row) => getEmbedding(row.content, 'RETRIEVAL_DOCUMENT', row.filename)
    );
    // A fallback partway through THIS batch is the worst case for the whole
    // system: a re-embed exists to make the corpus uniform, so finishing one that
    // wrote two different dimensions would leave the corpus permanently split
    // while reporting success. Every embedding is already in hand and the table
    // was cleared above, so checking uniformity here costs nothing and fails
    // before the first row is written.
    assertUniformEmbeddings('chunks', chunkEmbeddings, 'full-corpus re-embed');
    for (let i = 0; i < chunkRows.length; i++) {
        const embedding = chunkEmbeddings[i];
        if (newDimension === null) {
            newDimension = embedding.length;
            initIndex('chunks', newDimension);
        }
        db.prepare('UPDATE chunks SET embedding = vector_as_f32(?) WHERE id = ?')
            .run(JSON.stringify(embedding), chunkRows[i].id);
        if ((i + 1) % 25 === 0) console.log(`[Reembed]   chunks ${i + 1}/${chunkRows.length}`);
    }

    // 3. Re-embed topics.
    const topicRows = db.prepare('SELECT id, name, description, category FROM topics').all() as
        { id: number; name: string; description: string | null; category: string | null }[];
    console.log(`[Reembed] Re-embedding ${topicRows.length} topics...`);
    let topicsDone = 0;
    for (const topic of topicRows) {
        await embedTopic(topic.id, topic.name, topic.description, topic.category);
        if (++topicsDone % 50 === 0) console.log(`[Reembed]   topics ${topicsDone}/${topicRows.length}`);
    }

    // 4. Re-embed claims.
    const claimRows = db.prepare(`
        SELECT kc.id, kc.claim_text, t.name AS topic_name
        FROM knowledge_claims kc
        JOIN topics t ON kc.topic_id = t.id
    `).all() as { id: number; claim_text: string; topic_name: string }[];
    console.log(`[Reembed] Re-embedding ${claimRows.length} claims...`);
    let claimsDone = 0;
    for (const claim of claimRows) {
        await embedClaim(claim.id, claim.claim_text, claim.topic_name);
        if (++claimsDone % 50 === 0) console.log(`[Reembed]   claims ${claimsDone}/${claimRows.length}`);
    }

    // 5. Re-embed community reports.
    //
    // Their title/summary text is already persisted, so this needs no LLM call —
    // only a fresh embedding. Skipping this step was what left the thematic path
    // dark after a migration (see the clearing step above). Failures are contained
    // per report so one bad row can't abort a migration that has already rewritten
    // the rest of the corpus.
    let reportsReembedded = 0;
    if (reportsCleared) {
        const reportRows = db.prepare(
            'SELECT id, title, summary FROM community_reports WHERE community_id IS NOT NULL'
        ).all() as { id: number; title: string; summary: string }[];
        console.log(`[Reembed] Re-embedding ${reportRows.length} community reports...`);
        for (const report of reportRows) {
            try {
                const embedding = await getEmbedding(`${report.title}\n\n${report.summary}`, 'RETRIEVAL_DOCUMENT', report.title);
                assertStorableEmbedding('community_reports', embedding, `community report "${report.title}"`);
                if (newDimension === null) newDimension = embedding.length;
                initIndex('community_reports', embedding.length);
                db.prepare('UPDATE community_reports SET embedding = vector_as_f32(?), embedding_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(JSON.stringify(embedding), report.id);
                reportsReembedded++;
            } catch (e) {
                console.error(`[Reembed] Failed to re-embed community report ${report.id} ("${report.title}"):`, (e as Error).message);
            }
        }
    }

    // Exit flush: guarantees nothing embedded under the previous dimension
    // survives into the first post-migration query.
    clearEmbeddingCache();

    // Rebuild the quantized structures now that the corpus is uniform again, so
    // the first post-migration searches don't have to pay for an exact scan
    // (and, in a long-lived server process, don't wait on the debounce).
    warmVectorIndexes();

    console.log(`[Reembed] Done. Re-embedded ${chunkRows.length} chunks, ${topicRows.length} topics, ${claimRows.length} claims, ${reportsReembedded} community reports at dimension ${newDimension}.`);
    return { chunks: chunkRows.length, topics: topicRows.length, claims: claimRows.length, communityReports: reportsReembedded, dimension: newDimension };
}

// ── Automatic embedding-dimension migration ─────────────────────────────────
// When the configured embedding model changes to one with a different vector
// size (e.g. Gemini 3072-dim → LiteLLM/Qwen 4096-dim), every stored vector is
// stale: sqlite-vector locks the index to the stored dimension, so query
// vectors of a different size make `vector_full_scan` throw and each search
// silently returns [] (see the catch blocks in searchChunks/Topics/Claims).
// The remedy is reembedAll(), which previously had to be run by hand. This
// migration detects the mismatch at STARTUP — before any search has locked the
// index to the stale dimension — and rebuilds the corpus automatically.
//
// It must run in a fresh process, before the first search, exactly once. It's
// invoked from hooks.server.ts (server boot) and guarded so concurrent boots /
// repeated calls await the same single run.

let migrationPromise: Promise<void> | null = null;

/** Truthy env values that opt OUT of automatic re-embedding. */
function autoReembedDisabled(): boolean {
    return /^(0|false|no|off)$/i.test(process.env.AUTO_REEMBED || '');
}

/**
 * The stored corpus embedding dimension, if any table has embedded rows.
 * Chunks are checked first, then topics, then claims, so a corpus that only
 * has knowledge (topics/claims) but no chunks is still detected.
 */
function currentCorpusDimension(): number | null {
    return (
        detectStoredDimension('chunks') ??
        detectStoredDimension('topics') ??
        detectStoredDimension('knowledge_claims')
    );
}

/**
 * Tables whose embedding column holds more than one distinct dimension.
 *
 * `currentCorpusDimension()` above reads a single arbitrary row per table, which
 * is only a trustworthy summary of the corpus if the corpus is actually uniform.
 * Before the write-side guard in ./embedding-dimension existed, a provider
 * fallback could interleave two dimensions into the same column — and those
 * minority rows are invisible to `vector_full_scan` with no error at query time,
 * so nothing would ever surface them.
 *
 * A mixed table cannot be repaired in place (the vectors have to be regenerated),
 * so this is treated as grounds for a full re-embed regardless of what the live
 * probe says: even when the majority dimension matches the live model, the
 * minority rows are silently missing from every search until rebuilt.
 */
function mixedDimensionTables(): { table: EmbeddedTable; dimensions: number[] }[] {
    const tables: EmbeddedTable[] = ['chunks', 'topics', 'knowledge_claims', 'community_reports'];
    return tables
        .map(table => ({ table, dimensions: distinctDimensions(table) }))
        .filter(entry => entry.dimensions.length > 1);
}

/**
 * Detects an embedding-dimension mismatch between the stored corpus and the
 * currently-configured embedding model, and re-embeds the whole corpus if
 * needed. Safe to call on every startup:
 *   - No stored embeddings yet → nothing to migrate (first ingestion will set
 *     the dimension correctly), returns immediately.
 *   - Stored dimension already matches the live model → no-op.
 *   - Mismatch → runs reembedAll() once, before any search locks the index.
 *
 * The live model dimension is probed with a single tiny embedding call so we
 * never trigger a needless full re-embed. If that probe fails (e.g. both
 * providers are down at boot) we skip migration rather than risk wiping a
 * good corpus — search will keep working if the dimension actually matches,
 * and a real mismatch will be retried on the next boot.
 *
 * Concurrent callers share one in-flight run via `migrationPromise`.
 */
export function ensureEmbeddingsMigrated(): Promise<void> {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
        try {
            if (autoReembedDisabled()) {
                console.log('[Reembed] AUTO_REEMBED disabled; skipping automatic dimension check.');
                return;
            }

            const storedDim = currentCorpusDimension();
            if (storedDim === null) {
                // Empty corpus: nothing stored yet. The first ingestion embeds
                // and locks the index at the live model's dimension, so no
                // migration is needed or possible.
                return;
            }

            // A corpus that is ALREADY mixed needs rebuilding whatever the live
            // probe reports, so this check comes first. The minority-dimension rows
            // are invisible to vector_full_scan and cannot be fixed in place, and
            // comparing one arbitrary row against the live model can't detect them:
            // if the probe happens to match the majority dimension we would return
            // "no migration needed" and leave those rows permanently unsearchable.
            const mixed = mixedDimensionTables();
            if (mixed.length > 0) {
                console.warn(
                    `[Reembed] Mixed embedding dimensions detected — ` +
                    mixed.map(m => `${m.table}: ${m.dimensions.join('/')}`).join(', ') +
                    `. This is the signature of an embedding provider fallback (LiteLLM → Gemini) ` +
                    `having written into an existing corpus. Rows at the minority dimension are ` +
                    `silently skipped by vector search and cannot be repaired in place, so the ` +
                    `corpus is being re-embedded in full.`
                );
                const repair = await reembedAll();
                console.log(
                    `[Reembed] Mixed-dimension repair complete: ${repair.chunks} chunks, ${repair.topics} topics, ` +
                    `${repair.claims} claims, ${repair.communityReports} community reports at dimension ${repair.dimension}.`
                );
                return;
            }

            // Probe the live embedding model's output dimension with a minimal
            // call. This routes through the same provider stack (LiteLLM primary
            // → Gemini fallback) as real queries, so the probed dimension is
            // exactly what queries will produce.
            let liveDim: number;
            try {
                // `cache: false` is load-bearing. This is a constant string sent
                // as RETRIEVAL_QUERY, making it the single most cache-hittable
                // text in the codebase — and its entire purpose is to observe
                // what the LIVE provider returns right now. A remembered value
                // would compare the stored corpus dimension against a stale
                // number and either skip a needed reembedAll (vector search then
                // returns nothing, forever, silently) or trigger a pointless
                // full-corpus re-embed. It must also never be written to the
                // cache: a probe that ran while LiteLLM was down would seed a
                // Gemini-dimension vector under a highly-hittable constant key.
                const probe = await getEmbedding('dimension probe', 'RETRIEVAL_QUERY', undefined, { cache: false });
                liveDim = probe.length;
            } catch (e) {
                console.warn('[Reembed] Could not probe live embedding dimension; skipping auto-migration this boot:', (e as Error).message);
                return;
            }

            if (liveDim === storedDim) {
                // Dimensions match — corpus is usable as-is.
                return;
            }

            console.warn(
                `[Reembed] Embedding dimension mismatch detected: stored corpus is ${storedDim}-dim ` +
                `but the configured embedding model now returns ${liveDim}-dim vectors. ` +
                `Vector search would silently return nothing. Re-embedding the entire corpus automatically...`
            );
            const result = await reembedAll();
            console.log(
                `[Reembed] Automatic migration complete: ${result.chunks} chunks, ${result.topics} topics, ` +
                `${result.claims} claims, ${result.communityReports} community reports re-embedded at dimension ${result.dimension}.`
            );
        } catch (e) {
            // Never let a migration failure crash server boot. Log loudly; a
            // persistent mismatch will surface as empty search results and can
            // be fixed by `npm run reembed`. Reset the guard so a later trigger
            // (or next boot) can retry.
            console.error('[Reembed] Automatic embedding migration failed:', e);
            // The guard is reset here so a later trigger can retry, which means a
            // second probe in the same process is a real code path — flush so the
            // retry cannot observe anything produced by the aborted run.
            clearEmbeddingCache();
            migrationPromise = null;
        }
    })();
    return migrationPromise;
}

export async function searchChunks(query: string, limit = 5) {
    await ensureVectorInit();
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");
    
    // Build the FTS5 MATCH expression via the shared helper (see ./fts-query for
    // why it must not fold diacritics — the FTS5 tokenizer already does, on both
    // sides). This replaced an inline sanitizer built on the ASCII-only `\w`
    // class, which replaced every accented letter with a space and so shredded
    // Czech query words before SQLite ever saw them: "řízení projektů" became
    // ["zen", "projekt"], and measured against the real index `MATCH '"zen"*'`
    // returns 0 rows while `MATCH '"řízení"*'` returns 48.
    const ftsQuery = buildFtsMatchQuery(query, { prefix: true });

    // Hybrid Search using Reciprocal Rank Fusion (RRF)
    // We fetch more results initially to allow for better reranking
    let results: { content: string, filename: string, path: string | null, score: number }[] = [];
    try {
        if (ftsQuery === null) {
            // No token survived tokenisation (e.g. a query of only very short
            // words). Run vector-only rather than emitting a degenerate MATCH:
            // the previous code fell back to the literal '"*"', which is NOT a
            // match-all — it was measured returning 0 rows — so the FTS half of
            // the fusion contributed nothing while still looking like it ran.
            // Logged because a silently vector-only search is exactly the kind of
            // quiet degradation that hid the original bug.
            console.log(`[searchChunks] No FTS token survived for "${query.slice(0, 60)}" — running vector-only.`);
            results = runVectorScan(
                'chunks',
                scan => `
                WITH vector_results AS (
                    SELECT rowid, row_number() OVER (ORDER BY distance ASC) as rank
                    FROM ${scan}('chunks', 'embedding', vector_as_f32(?), 50)
                )
                SELECT c.content,
                       d.filename,
                       d.path,
                       (1.0 / (60 + v.rank)) as score
                FROM chunks c
                JOIN documents d ON c.doc_id = d.id
                JOIN vector_results v ON c.id = v.rowid
                ORDER BY score DESC
                LIMIT 20
            `,
                sql => db.prepare(sql).all(JSON.stringify(queryEmbedding))
            ) as { content: string, filename: string, path: string | null, score: number }[];
        } else {
            results = runVectorScan(
                'chunks',
                scan => `
                WITH vector_results AS (
                    SELECT rowid, row_number() OVER (ORDER BY distance ASC) as rank
                    FROM ${scan}('chunks', 'embedding', vector_as_f32(?), 50)
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
            `,
                sql => db.prepare(sql).all(JSON.stringify(queryEmbedding), ftsQuery)
            ) as { content: string, filename: string, path: string | null, score: number }[];
        }
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
    const failed: { docId: number; filename: string; reason: string }[] = [];
    for (const doc of docs) {
        // Contain failures per document. Previously any throw in here aborted the
        // whole reprocess — leaving the knowledge tables wiped (with `wipeAll`) but
        // only partially rebuilt, which is a strictly worse state than either the
        // before or the after.
        try {
            let chunkRows: { id: number; content: string }[];
            if (options.rechunk) {
                // Re-embed via the regular pipeline. `documents.content` holds the
                // CLEANED text (see addDocument), so re-chunking it matches how the
                // document was originally indexed — no separate cleaning pass needed
                // here, and none is done so we don't re-translate/re-rewrite content
                // that is already clean.
                //
                // `replaceExisting` makes the swap atomic. The DELETE used to happen
                // here, before the await: a failure part-way through embedding then
                // left the document with NO chunks at all — unsearchable, and with
                // its text still present so nothing flagged it as missing.
                await embedAndStoreChunks(doc.id, doc.filename, doc.content, undefined, { replaceExisting: true });
            }
            chunkRows = db.prepare('SELECT id, content FROM chunks WHERE doc_id = ?').all(doc.id) as { id: number; content: string }[];

            if (chunkRows.length === 0) {
                console.warn(`Doc ${doc.id} (${doc.filename}) has no chunks; skipping knowledge processing.`);
                continue;
            }

            await processDocumentKnowledge(doc.id, chunkRows, doc.summary ?? undefined);
            processed++;
        } catch (err) {
            const reason = (err as Error)?.message ?? String(err);
            failed.push({ docId: doc.id, filename: doc.filename, reason });
            console.error(`[Reprocess] Doc ${doc.id} (${doc.filename}) failed, continuing with the rest:`, reason);
        }
    }

    if (failed.length > 0) {
        console.warn(
            `[Reprocess] ${failed.length} of ${docs.length} document(s) failed: ` +
            failed.map(f => `${f.filename} (${f.reason})`).join('; ')
        );
    }

    // Reprocessing rewrites the topic set wholesale (and with `wipeAll` deletes
    // every topic first), so the community partition it was clustered from no
    // longer describes anything. Recompute it, which also prunes community
    // reports whose member topics are gone — otherwise the thematic retrieval
    // path would keep matching summaries of topics that no longer exist.
    try {
        await recomputeCommunities();
    } catch (err) {
        console.error('[Reprocess] Community recompute failed:', err);
    }

    const topicsAfter = (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;
    const claimsAfter = (db.prepare('SELECT COUNT(*) AS c FROM knowledge_claims').get() as { c: number }).c;

    return { processed, topicsBefore, topicsAfter, claimsBefore, claimsAfter };
}

/**
 * Internal helper that performs the chunking + embedding portion of ingestion,
 * extracted so `reprocessKnowledge` can re-chunk on demand without duplicating
 * the LLM-with-fallback logic.
 *
 * NOTE: `content` is expected to be already-cleaned text (the initial ingestion
 * chunks `cleanedContent`, and `documents.content` now stores the cleaned
 * version). This function deliberately does NOT run `cleanDocument` again — the
 * text it receives is the same text that was originally indexed.
 */
async function embedAndStoreChunks(
    docId: number | bigint,
    filename: string,
    content: string,
    pathHint: string | undefined,
    options: { replaceExisting?: boolean } = {}
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

    // Same pre-write batch guard as addDocument's ingestion path.
    assertUniformEmbeddings('chunks', embeddings, `re-chunk of "${filename}"`);

    if (embeddings.length > 0) {
        try {
            db.prepare("SELECT vector_init('chunks', 'embedding', ?)").get(`dimension=${embeddings[0].length},distance=cosine`);
        } catch (e) {
            // already initialized
        }
    }

    // Replace-and-insert in ONE transaction, so a document is never left without
    // chunks. Everything above this point is network I/O and is deliberately done
    // before the transaction opens (holding a SQLite transaction across an await is
    // what the phased structure in addDocument exists to avoid).
    db.transaction(() => {
        if (options.replaceExisting) {
            db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
        }
        for (let i = 0; i < chunks.length; i++) {
            db.prepare('INSERT INTO chunks (doc_id, content, embedding) VALUES (?, ?, vector_as_f32(?))').run(
                docId,
                chunks[i],
                JSON.stringify(embeddings[i])
            );
        }
    })();

    markVectorIndexDirty('chunks');

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
// 45K chars per section on Gemini. Semantic chunking echoes the section back as
// a JSON array, so on the slow LiteLLM gateway a 45K section times out; when the
// gateway is primary, sectionMaxChars() returns a much smaller value.
const SEMANTIC_CHUNK_SECTION_SIZE = providers.sectionMaxChars(45000);
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
    // Compare non-whitespace character counts. semanticChunk now slices the
    // original text at LLM-chosen boundaries (rather than having the LLM echo
    // chunk text), so chunks are verbatim and coverage is ~100% by design; the
    // only losses are trimmed inter-chunk whitespace. Measuring against
    // non-whitespace chars makes the coverage guard immune to that trimming
    // while still catching a genuine failure (e.g. semanticChunk returned []).
    const sectionSignificant = section.replace(/\s/g, '').length;
    const coveredSignificant = semantic.reduce((n: number, c: string) => n + (c?.replace(/\s/g, '').length ?? 0), 0);
    if (semantic.length > 0 && coveredSignificant >= sectionSignificant * CHUNK_COVERAGE_THRESHOLD) {
        // Guard against an over-large semantic chunk (e.g. the LLM judged a big
        // span cohesive and returned few/no break points): sub-split any chunk
        // that exceeds the embedding-friendly size using the markdown-aware
        // chunker, so no single chunk is too large to embed/retrieve well.
        const MAX_CHUNK_CHARS = 4000;
        return semantic.flatMap(c => (c.length > MAX_CHUNK_CHARS ? chunkText(c, 1500, 200) : [c]));
    }
    if (semantic.length > 0) {
        console.warn(
            `Semantic chunking covered only ${Math.round((100 * coveredSignificant) / Math.max(1, sectionSignificant))}% of "${label}" (${semantic.length} chunks); falling back to markdown-aware chunker for this section.`
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
 * Words that mark a query as asking whether something is permitted/required, as
 * opposed to asking what something is. `buildKnowledgeContext` boosts
 * negation/condition/boundary claims when one is present, because those are the
 * claims that actually answer such a question.
 *
 * The list was English-only, which made the boost dead code on this corpus —
 * measured as producing no boost: "Kdo musí schválit bezpečnostní řízení?",
 * "Lze změnit řízení projektů?", "Může vedoucí zamítnout žádost?". The
 * consequence is the worst kind: the governing exception keeps its base score,
 * loses the ordering contest to plainly-worded assertions, falls outside the
 * maxClaims cut, and the model answers confidently from general assertions while
 * the rule that contradicts it sits unretrieved in the graph.
 *
 * Unicode lookarounds rather than `\b`, which is ASCII-only and places a false
 * boundary between an accented letter and an adjacent ASCII run — that is how
 * short alternatives like "is" or "may" could match *inside* an accented Czech
 * word and boost on a query that asks nothing. (Same mechanism that truncated
 * "ČSN" to "SN" in llm.ts's acronym extractor.)
 *
 * Exported so the eval harness can cover it; see scripts/eval/README.md.
 */
export const INTERROGATIVE_WORDS = [
    // English
    'does', 'can', 'is', 'should', 'will', 'could', 'would', 'may', 'might', 'must',
    // Czech modals and interrogatives
    'musí', 'může', 'lze', 'smí', 'má', 'mají', 'je', 'jsou',
    'kdo', 'kdy', 'jak', 'jaká', 'jaké', 'jaký', 'který', 'která', 'které',
    'nutné', 'povinné', 'zakázáno', 'povoleno'
];

const INTERROGATIVE_PATTERN = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${INTERROGATIVE_WORDS.join('|')})(?![\\p{L}\\p{N}])`,
    'iu'
);

/**
 * Relevance floor for community reports. Lower than the topic floor on purpose:
 * a report is 150-300 words covering a whole area, so its embedding sits further
 * from any single short query than a tight topic embedding does. Holding it to
 * MIN_TOPIC_RELEVANCE would mean the thematic path effectively never fires.
 *
 * Picked by reasoning about embedding geometry, not measured — it belongs in the
 * eval harness's threshold table (scripts/eval/README.md) as soon as the golden
 * set has cases that exercise broad thematic questions.
 */
const MIN_COMMUNITY_RELEVANCE = Number(process.env.MIN_COMMUNITY_RELEVANCE) || 0.35;

export interface CommunityMatch {
    id: number;
    communityId: number | null;
    title: string;
    summary: string;
    topicCount: number;
    score: number;
}

/**
 * Semantic search over community reports — the thematic ("global") retrieval
 * path.
 *
 * Entity-level search answers "what does the corpus say about X". This answers
 * "what areas does the corpus cover, and which one is this question in" — the
 * class of question where no single topic holds the answer because the answer is
 * the shape of a whole cluster. The clustering already existed (communities.ts)
 * but had no query-time consumer; the embedded reports are what make it
 * reachable from a question.
 */
export async function searchCommunities(
    query: string,
    limit = 2,
    minScore = MIN_COMMUNITY_RELEVANCE
): Promise<CommunityMatch[]> {
    await ensureEmbeddingsMigrated();

    // Cheap pre-check: skip the embedding call entirely on corpora that have no
    // reports yet (small graphs, or COMMUNITY_REPORTS_ENABLED=false).
    try {
        const available = (db.prepare(
            'SELECT COUNT(*) AS c FROM community_reports WHERE embedding IS NOT NULL AND community_id IS NOT NULL'
        ).get() as { c: number }).c;
        if (available === 0) return [];
    } catch (e) {
        return []; // table missing (pre-migration DB)
    }

    const queryEmbedding = await getEmbedding(query, 'RETRIEVAL_QUERY');

    try {
        const dimension = (() => {
            try {
                const row = db.prepare('SELECT LENGTH(embedding) AS len FROM community_reports WHERE embedding IS NOT NULL LIMIT 1')
                    .get() as { len: number } | undefined;
                return row ? row.len / 4 : EMBEDDING_DIMENSION;
            } catch {
                return EMBEDDING_DIMENSION;
            }
        })();
        db.prepare("SELECT vector_init('community_reports', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    try {
        const rows = runVectorScan(
            'community_reports',
            scan => `
            SELECT cr.id, cr.community_id, cr.title, cr.summary, cr.topic_count,
                   (1 - v.distance) as score
            FROM ${scan}('community_reports', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
            JOIN community_reports cr ON cr.id = v.rowid
            WHERE cr.embedding IS NOT NULL AND cr.community_id IS NOT NULL
            ORDER BY v.distance ASC
        `,
            sql => db.prepare(sql).all(JSON.stringify(queryEmbedding), Math.max(limit * 3, 6))
        ) as {
            id: number; community_id: number | null; title: string; summary: string; topic_count: number; score: number;
        }[];

        return rows
            .filter(r => r.score >= minScore)
            .slice(0, limit)
            .map(r => ({
                id: r.id,
                communityId: r.community_id,
                title: r.title,
                summary: r.summary,
                topicCount: r.topic_count,
                score: r.score
            }));
    } catch (e) {
        console.warn('searchCommunities failed (no reports or vector extension unavailable):', (e as Error).message);
        return [];
    }
}

// buildKeywordProbe / mergeByIdKeepingBestScore live in ./retrieval-probe so
// they can be unit-tested without importing this module (and with it the schema
// migration in ./db).

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
export async function searchTopics(
    query: string,
    limit = 10,
    minScore = MIN_TOPIC_RELEVANCE,
    useRerank = false,
    opts: { cache?: boolean } = {}
): Promise<{ id: number; name: string; description: string | null; category: string | null; score: number }[]> {
    await ensureEmbeddingsMigrated();
    // `opts.cache` exists for the ingestion-side caller: buildVocabularyHint runs
    // one searchTopics per chunk over a 1000-char chunk prefix, which is a
    // distinct, never-reused RETRIEVAL_QUERY text. Left cacheable, a large git
    // sync would roll thousands of those through the LRU and evict a concurrent
    // chat turn's query vectors — correctness-neutral, but it silently undoes the
    // cache's benefit exactly when the server is busiest.
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY", undefined, { cache: opts.cache });

    try {
        const dimension = detectStoredDimension('topics') ?? EMBEDDING_DIMENSION;
        db.prepare("SELECT vector_init('topics', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    try {
        const fetchLimit = useRerank ? Math.max(limit * 3, 15) : limit;
        const results = runVectorScan(
            'topics',
            scan => `
            SELECT t.id, t.name, t.description, t.category,
                   (1 - v.distance) as score
            FROM ${scan}('topics', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
            JOIN topics t ON t.id = v.rowid
            WHERE t.embedding IS NOT NULL
            ORDER BY v.distance ASC
        `,
            sql => db.prepare(sql).all(JSON.stringify(queryEmbedding), fetchLimit)
        ) as { id: number; name: string; description: string | null; category: string | null; score: number }[];

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
    await ensureEmbeddingsMigrated();
    const queryEmbedding = await getEmbedding(query, "RETRIEVAL_QUERY");

    try {
        const dimension = detectStoredDimension('knowledge_claims') ?? EMBEDDING_DIMENSION;
        db.prepare("SELECT vector_init('knowledge_claims', 'embedding', ?)").get(`dimension=${dimension},distance=cosine`);
    } catch (e) {
        // Already initialized
    }

    try {
        let buildSql: (scan: string) => string;
        let params: any[];
        const fetchLimit = useRerank ? Math.max(limit * 2, 20) : limit * 2;

        if (topicIds && topicIds.length > 0) {
            const placeholders = topicIds.map(() => '?').join(',');
            buildSql = scan => `
                SELECT kc.id, kc.claim_text, kc.topic_id, kc.doc_id, t.name as topic_name,
                       COALESCE(kc.claim_type, 'assertion') as claim_type,
                       COALESCE(d.filename, '') as filename, d.path,
                       (1 - v.distance) as score
                FROM ${scan}('knowledge_claims', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
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
            buildSql = scan => `
                SELECT kc.id, kc.claim_text, kc.topic_id, kc.doc_id, t.name as topic_name,
                       COALESCE(kc.claim_type, 'assertion') as claim_type,
                       COALESCE(d.filename, '') as filename, d.path,
                       (1 - v.distance) as score
                FROM ${scan}('knowledge_claims', 'embedding', vector_as_f32(?), CAST(? AS INTEGER)) v
                JOIN knowledge_claims kc ON kc.id = v.rowid
                JOIN topics t ON kc.topic_id = t.id
                LEFT JOIN documents d ON kc.doc_id = d.id
                WHERE kc.embedding IS NOT NULL
                  AND kc.status = 'active'
                ORDER BY v.distance ASC
            `;
            params = [JSON.stringify(queryEmbedding), fetchLimit];
        }

        const results = runVectorScan('knowledge_claims', buildSql, sql =>
            db.prepare(sql).all(...params)
        ) as { id: number; claim_text: string; topic_name: string; topic_id: number; doc_id: number; score: number; claim_type: string; filename: string; path: string | null }[];
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
    /** How many community reports the thematic path contributed. */
    communityCount: number;
    /** True when topics were seeded from a community because nothing else matched. */
    thematicFallbackUsed: boolean;
}

/**
 * Optional dual-level keyword sets from `analyzeAndCondenseQuery`.
 *
 * `lowLevel` (entities, identifiers, terms of art) probes the topic/claim
 * layer; `highLevel` (themes, domains) probes the community-report layer.
 * Both are optional — omit them and this degrades exactly to the previous
 * single-probe behaviour.
 */
export interface QueryKeywords {
    highLevel?: string[];
    lowLevel?: string[];
}

/** How many community reports may enter the context at once. */
const MAX_CONTEXT_COMMUNITIES = 2;

/**
 * Build structured knowledge context from the knowledge graph for a query.
 * This is the main function used by the chat endpoint to retrieve information.
 *
 * Returns metadata (topicCount/claimCount/hasConflicts) alongside the text so
 * callers can make cheap decisions — e.g. the chat endpoint skips the extra
 * `synthesizeContext` LLM pass entirely for simple single-topic queries that
 * are already well covered, instead of always paying for a reformatting pass.
 */
export async function buildKnowledgeContext(
    query: string,
    maxTopics = 5,
    maxClaims = 15,
    keywords?: QueryKeywords
): Promise<KnowledgeContextResult> {
    // Step 0: shape a probe per retrieval level. A single condensed query has to
    // serve two incompatible jobs — matching the specific topic a question names,
    // and matching the broad area it sits in. The keyword split lets each path
    // search on text shaped for it; when no keywords are supplied both probes are
    // null and this behaves exactly as it did before.
    const lowLevelProbe = buildKeywordProbe(query, keywords?.lowLevel);
    const highLevelProbe = buildKeywordProbe(query, keywords?.highLevel);

    // Step 1: Find most relevant topics, and the thematic areas the question
    // falls in, concurrently.
    //
    // The topic search pools candidates from the query AND the entity-keyword
    // probe, then reranks the pooled set ONCE. Reranking each search separately
    // would cost two LLM round trips and rank each list blind to the other; one
    // pass over the union is both cheaper and a better ordering.
    const topicPoolSize = Math.max(maxTopics * 3, 15);
    const [queryTopics, keywordTopics, communities] = await Promise.all([
        searchTopics(query, topicPoolSize, MIN_TOPIC_RELEVANCE, false),
        lowLevelProbe
            ? searchTopics(lowLevelProbe, topicPoolSize, MIN_TOPIC_RELEVANCE, false)
            : Promise.resolve([] as Awaited<ReturnType<typeof searchTopics>>),
        searchCommunities(highLevelProbe ?? query, MAX_CONTEXT_COMMUNITIES)
    ]);

    const pooledTopics = mergeByIdKeepingBestScore(queryTopics, keywordTopics);
    let relevantTopics = pooledTopics.slice(0, maxTopics);
    if (pooledTopics.length > maxTopics) {
        try {
            const rankedIndices = await rerank(
                query,
                pooledTopics.map(t => ({ content: `${t.name}: ${t.description ?? ''}` }))
            );
            const reranked = rankedIndices.map(i => pooledTopics[i]).filter(Boolean);
            if (reranked.length > 0) relevantTopics = reranked.slice(0, maxTopics);
        } catch (e) {
            console.warn('[KnowledgeContext] Topic rerank failed, using cosine order:', (e as Error).message);
        }
    }

    let thematicFallbackUsed = false;

    if (relevantTopics.length === 0) {
        // Keyword-based fallback: works even when no topic embeddings exist yet.
        // The extracted low-level keywords are searched alongside the raw query
        // words — they are the terms of art most likely to appear verbatim in a
        // topic name, which is exactly what a LIKE match needs.
        //
        // This path was doubly broken on a Czech corpus, and the second bug is the
        // one that makes a JS-only fix insufficient:
        //   (a) the raw query was split with the ASCII-only `\w` class, so
        //       "řízení" produced only the fragment "zen", which the length
        //       filter then discarded — the query contributed nothing at all.
        //   (b) SQLite's LOWER() is ASCII-only. Measured: LOWER('ŘÍZENÍ') returns
        //       'ŘÍzenÍ'. So `LOWER(name) LIKE '%řízení%'` matched nothing, and
        //       folding the *pattern* does not rescue it either —
        //       'Řízení projektů' LIKE '%rizeni%' is also 0 — because the stored
        //       column value stays accented. The COLUMN side has to be folded.
        // Every topic named Řízení / Školení / Žádosti / Údržba — most of them, in
        // Czech institutional prose — was unreachable through this last-resort path.
        const words = [
            ...tokenizeForFts(query),
            ...(keywords?.lowLevel ?? [])
        ].filter(w => [...w].length > 3);
        if (words.length > 0) {
            try {
                registerFoldFunction();
                // `canonical_key` is already lowercase, diacritic-folded ASCII
                // (written by normalizeTopicName) and carries a UNIQUE index, so
                // matching it makes both sides ASCII and plain LIKE suffices.
                // `description` has no folded equivalent, hence fold() — which
                // full-scans. Acceptable only because this is the rare
                // last-resort path before "No relevant knowledge found".
                const likeConditions = words
                    .map(() => "(canonical_key LIKE ? ESCAPE '\\' OR fold(COALESCE(description, '')) LIKE ? ESCAPE '\\')")
                    .join(' OR ');
                const likeParams = words.flatMap(w => {
                    const pattern = `%${escapeLikePattern(foldDiacritics(w.toLowerCase()))}%`;
                    return [pattern, pattern];
                });
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
        // Thematic fallback: nothing matched at the entity level, but a community
        // report did. This is the case the community layer exists for — broad
        // questions ("what does our governance cover?") whose answer is the shape
        // of a whole cluster, so no individual topic embedding sits close to them.
        // Seed the topic set from the matched community's members and let the
        // normal claim assembly below fill in the facts.
        if (relevantTopics.length === 0 && communities.length > 0) {
            for (const community of communities) {
                if (community.communityId === null) continue;
                for (const member of getCommunityReportTopics(community.communityId, maxTopics)) {
                    if (relevantTopics.some(t => t.id === member.id)) continue;
                    const row = db.prepare('SELECT id, name, description, category FROM topics WHERE id = ?').get(member.id) as
                        { id: number; name: string; description: string | null; category: string | null } | undefined;
                    if (row) relevantTopics.push({ ...row, score: 0.35 });
                }
            }
            if (relevantTopics.length > 0) {
                thematicFallbackUsed = true;
                console.log(
                    `[KnowledgeContext] No topic matched "${query.slice(0, 60)}" directly; ` +
                    `seeded ${relevantTopics.length} topic(s) from community report "${communities[0].title}".`
                );
            }
        }

        if (relevantTopics.length === 0) {
            console.log(`[KnowledgeContext] No topics found for: "${query.slice(0, 80)}"`);
            return {
                text: 'No relevant knowledge found for this query.',
                topicCount: 0,
                claimCount: 0,
                hasConflicts: false,
                communityCount: 0,
                thematicFallbackUsed: false
            };
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

    // Step 4: Semantic search for the most relevant claims. Same dual-level
    // pooling as the topic search: query probe + entity-keyword probe, merged,
    // then one rerank pass over the union.
    const claimPoolSize = Math.max(maxClaims * 2, 20);
    const [queryClaims, keywordClaims] = await Promise.all([
        searchClaims(query, null, claimPoolSize, MIN_CLAIM_RELEVANCE, false),
        lowLevelProbe
            ? searchClaims(lowLevelProbe, null, claimPoolSize, MIN_CLAIM_RELEVANCE, false)
            : Promise.resolve([] as Awaited<ReturnType<typeof searchClaims>>)
    ]);

    const pooledClaims = mergeByIdKeepingBestScore(queryClaims, keywordClaims);
    let semanticClaims = pooledClaims.slice(0, maxClaims);
    if (pooledClaims.length > maxClaims) {
        try {
            const rankedIndices = await rerank(
                query,
                pooledClaims.map(c => ({ content: `[${c.topic_name}] ${c.claim_text}` }))
            );
            const reranked = rankedIndices.map(i => pooledClaims[i]).filter(Boolean);
            if (reranked.length > 0) semanticClaims = reranked.slice(0, maxClaims);
        } catch (e) {
            console.warn('[KnowledgeContext] Claim rerank failed, using cosine order:', (e as Error).message);
        }
    }

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
    if (INTERROGATIVE_PATTERN.test(query)) {
        for (const [id, claim] of claimMap) {
            if (['negation', 'condition', 'boundary'].includes(claim.claim_type)) {
                claim.score *= 1.5;
            }
        }
    }

    const hasConflicts = Array.from(claimMap.values()).some(c => c.status === 'conflicting');
    console.log(
        `[KnowledgeContext] query="${query.slice(0, 60)}" topics=${relevantTopics.length} claims=${claimMap.size} ` +
        `communities=${communities.length}` +
        (lowLevelProbe ? ` lowLevel="${lowLevelProbe.slice(0, 50)}"` : '') +
        (highLevelProbe ? ` highLevel="${highLevelProbe.slice(0, 50)}"` : '') +
        (hasConflicts ? ' (includes conflicting claims)' : '') +
        (thematicFallbackUsed ? ' (thematic fallback)' : '')
    );

    // Step 6: Build structured context
    const lines: string[] = ['KNOWLEDGE CONTEXT:', ''];

    // Thematic overview first — it frames the specific facts that follow. Marked
    // explicitly as derived/orienting so the answering model treats it as
    // background rather than as a citable source: community summaries are LLM
    // -written over topics and claims, so they are one generation removed from
    // the documents and must never be quoted as if they were source text.
    if (communities.length > 0) {
        lines.push('THEMATIC OVERVIEW — corpus-level areas this question falls in.');
        lines.push('Derived summaries, NOT source text: use them for framing and orientation only. Never quote or cite them; the specific facts are in the topic sections below.');
        lines.push('');
        for (const community of communities) {
            lines.push(`#### ▣ ${community.title} (${community.topicCount} related topics)`);
            lines.push(community.summary);
            if (community.communityId !== null) {
                const members = getCommunityReportTopics(community.communityId, 8).map(m => m.name);
                if (members.length > 0) {
                    lines.push(`*Topics in this area: ${members.join(', ')}*`);
                }
            }
            lines.push('');
        }
        lines.push('---');
        lines.push('');
    }

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
        hasConflicts,
        communityCount: communities.length,
        thematicFallbackUsed
    };
}
