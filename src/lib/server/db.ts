import 'dotenv/config';

import Database from 'better-sqlite3';
import { platform, arch } from 'os';
import { join } from 'path';
import fs from 'fs';
import { normalizeTopicName } from './topic-normalize';

const isWindows = platform() === 'win32';

// For vector extension, find the correct platform-specific binary.
// @sqliteai/sqlite-vector installs the right arch package as an optionalDependency.
let VECTOR_EXTENSION_PATH = '';
if (isWindows) {
    VECTOR_EXTENSION_PATH = join(process.cwd(), 'node_modules/@sqliteai/sqlite-vector-win32-x86_64/vector.dll');
} else {
    const cpuArch = arch(); // 'x64', 'arm64', etc.
    const candidates: string[] = [];
    if (cpuArch === 'x64') {
        candidates.push(
            join(process.cwd(), 'node_modules/@sqliteai/sqlite-vector-linux-x86_64/vector.so'),
            join(process.cwd(), 'node_modules/@sqliteai/sqlite-vector-linux-x86_64-musl/vector.so'),
        );
    } else if (cpuArch === 'arm64') {
        candidates.push(
            join(process.cwd(), 'node_modules/@sqliteai/sqlite-vector-linux-arm64/vector.so'),
            join(process.cwd(), 'node_modules/@sqliteai/sqlite-vector-linux-arm64-musl/vector.so'),
        );
    }
    VECTOR_EXTENSION_PATH = candidates.find(p => fs.existsSync(p)) ?? '';
}

// Note: sqlite-memory extension is no longer used as we handle chunking and storage manually in TypeScript.

const dbPath = process.env.DATABASE_PATH || 'data/rag.db';

// Ensure directory exists
const dbDir = join(process.cwd(), dbPath.includes('/') ? dbPath.split('/').slice(0, -1).join('/') : '');
if (dbDir && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
export const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Enable WAL (Write-Ahead Logging) for better concurrency performance
db.pragma('journal_mode = WAL');

// Load extensions
// Load vector extension
if (VECTOR_EXTENSION_PATH && fs.existsSync(VECTOR_EXTENSION_PATH)) {
    try {
        db.loadExtension(VECTOR_EXTENSION_PATH);
        // console.log('Loaded vector extension');
    } catch (err) {
        console.error(`Failed to load vector extension from ${VECTOR_EXTENSION_PATH}:`, err);
    }
} else {
    console.warn(`Vector extension not found at ${VECTOR_EXTENSION_PATH}. Vector search will not work.`);
}

// Initialize tables if not using sqlite-memory's automatic setup
// sqlite-memory usually sets up its own tables on first use or when calling its functions.
// But we'll also want a table for managing documents (original files)
db.exec(`
    CREATE TABLE IF NOT EXISTS git_repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        pat TEXT,
        last_commit TEXT,
        local_path TEXT NOT NULL UNIQUE
,
        sync_interval INTEGER DEFAULT 3600000,
        last_sync_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        path TEXT,
        repo_id INTEGER,
        content TEXT NOT NULL,
        context TEXT,
        content_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(repo_id) REFERENCES git_repos(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        provider TEXT DEFAULT 'local',
        provider_id TEXT UNIQUE,
        display_name TEXT,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        conversation_id TEXT,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        category TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS topic_relationships (
        source_topic_id INTEGER,
        target_topic_id INTEGER,
        relationship_type TEXT,
        PRIMARY KEY (source_topic_id, target_topic_id, relationship_type),
        FOREIGN KEY (source_topic_id) REFERENCES topics(id) ON DELETE CASCADE,
        FOREIGN KEY (target_topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knowledge_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER,
        doc_id INTEGER,
        claim_text TEXT NOT NULL,
        claim_hash TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_topics (
        doc_id INTEGER,
        topic_id INTEGER,
        PRIMARY KEY (doc_id, topic_id),
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );
`);

// Chunks table is initialised here (not lazily in addDocument) so that
// searchChunks works even before any document has been uploaded.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            content TEXT,
            embedding BLOB,
            FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            content='chunks',
            content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
    `);
} catch (e) {
    // chunks_fts may already exist on databases migrated from older schema versions
}


// Migration: Add columns if they don't exist (for existing databases)
try {
    db.exec('ALTER TABLE documents ADD COLUMN path TEXT');
} catch (e) {}
try {
    db.exec('ALTER TABLE documents ADD COLUMN repo_id INTEGER');
} catch (e) {}
try {
    db.exec('ALTER TABLE documents ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
} catch (e) {}
try {
    db.exec('ALTER TABLE documents ADD COLUMN content_hash TEXT');
} catch (e) {}

try {
    db.exec('ALTER TABLE git_repos ADD COLUMN sync_interval INTEGER DEFAULT 3600000');
} catch (e) {}
try {
    db.exec('ALTER TABLE git_repos ADD COLUMN last_sync_at DATETIME');
} catch (e) {}

// Update default sync interval to 1h if it was 24h
try {
    db.prepare('UPDATE git_repos SET sync_interval = 3600000 WHERE sync_interval = 86400000').run();
} catch (e) {}

try {
    db.exec('ALTER TABLE chat_history ADD COLUMN conversation_id TEXT');
} catch (e) {}

// Migration: Add doc_content_hash to knowledge_claims for version attribution
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN doc_content_hash TEXT');
} catch (e) {}

// Migration: Add parent_topic_id for topic hierarchy support
try {
    db.exec('ALTER TABLE topics ADD COLUMN parent_topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL');
} catch (e) {}

// Now create the index
try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_repo_path ON documents(repo_id, path) WHERE repo_id IS NOT NULL');
} catch (e) {}

// Migration: Add embedding columns to topics for semantic search
try {
    db.exec('ALTER TABLE topics ADD COLUMN embedding BLOB');
} catch (e) {}
try {
    db.exec('ALTER TABLE topics ADD COLUMN embedding_updated_at DATETIME');
} catch (e) {}

// Migration: Add embedding columns to knowledge_claims for semantic search
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN embedding BLOB');
} catch (e) {}
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN embedding_updated_at DATETIME');
} catch (e) {}

// Migration: Add summary column for LLM-generated document summaries
try {
    db.exec('ALTER TABLE documents ADD COLUMN summary TEXT');
} catch (e) {}

// Migration: Add wiki_documents table
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS wiki_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            filename TEXT NOT NULL,
            content TEXT,
            content_hash TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(repo_id, path),
            FOREIGN KEY(repo_id) REFERENCES git_repos(id) ON DELETE CASCADE
        );
    `);
} catch (e) {}

// Migration: Add community_id for community detection
try {
    db.exec('ALTER TABLE topics ADD COLUMN community_id INTEGER');
} catch (e) {}
try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_topics_community_id ON topics(community_id)');
} catch (e) {}

// Migration: Add chunk_id to knowledge_claims for source lineage
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL');
} catch (e) {}

// Migration: Add claim_type to knowledge_claims for expanded claim types
try {
    db.exec("ALTER TABLE knowledge_claims ADD COLUMN claim_type TEXT DEFAULT 'assertion'");
} catch (e) {}

// Migration: Add extraction_failed to chunks so a failed knowledge-extraction
// pass (LLM error or unparseable JSON, as opposed to a chunk that genuinely
// has nothing to extract) is visible and queryable instead of only appearing
// as a transient console.error during ingestion. Set by processDocumentKnowledge.
try {
    db.exec('ALTER TABLE chunks ADD COLUMN extraction_failed INTEGER DEFAULT 0');
} catch (e) {}
try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_extraction_failed ON chunks(extraction_failed) WHERE extraction_failed = 1');
} catch (e) {}

// ── Migration: canonical_key for robust topic de-duplication ────────────────
// `topics.name UNIQUE` only prevents byte-for-byte duplicate names. Two chunks
// processed concurrently (e.g. two /api/documents uploads in flight at once)
// can each independently decide "IT-PEP" and "IT PEP" are new topics, since
// they don't share the in-memory dedup map that `processDocumentKnowledge`
// seeds per-call. `canonical_key` stores the normalised dedup key from
// `normalizeTopicName` with its own UNIQUE index, so the database itself
// rejects/merges near-duplicate names regardless of which process/request
// created them first.
try {
    db.exec('ALTER TABLE topics ADD COLUMN canonical_key TEXT');
} catch (e) {}

try {
    const rows = db
        // Oldest row per key wins (matches the dedup step below and the app's
        // ON CONFLICT upsert, which keep the earliest-inserted topic).
        .prepare('SELECT id, name FROM topics WHERE canonical_key IS NULL ORDER BY id ASC')
        .all() as { id: number; name: string }[];
    if (rows.length > 0) {
        // Seed with keys already present so we never re-assign a key that a prior
        // (possibly partial) migration run or the app's own inserts already own.
        const seen = new Set<string>(
            (db.prepare("SELECT canonical_key FROM topics WHERE canonical_key IS NOT NULL AND canonical_key != ''").all() as { canonical_key: string }[])
                .map((r) => r.canonical_key)
        );
        const update = db.prepare('UPDATE topics SET canonical_key = ? WHERE id = ?');
        let assigned = 0;
        let skipped = 0;
        const backfillTx = db.transaction(() => {
            for (const row of rows) {
                const { key } = normalizeTopicName(row.name);
                // Only the first row for a given key gets it; duplicates stay NULL
                // (they'll be surfaced for manual merge below). This keeps the
                // backfill collision-free whether or not the UNIQUE index already
                // exists, so it can no longer roll back and leave every topic
                // un-backfilled on each restart.
                if (!key || seen.has(key)) {
                    skipped++;
                    continue;
                }
                seen.add(key);
                update.run(key, row.id);
                assigned++;
            }
        });
        backfillTx();
        console.log(
            `[Migration] Backfilled canonical_key for ${assigned} topic(s)` +
            (skipped > 0 ? `; left ${skipped} near-duplicate/empty-key topic(s) unset for manual merge.` : '.')
        );
    }
} catch (e) {
    console.error('[Migration] Failed to backfill topics.canonical_key:', e);
}

try {
    // Legacy databases may already contain duplicate topics whose names differ
    // but whose canonical_key now collides (that's the whole point of this
    // migration — surfacing exactly those). Creating a UNIQUE index would fail
    // on such data, so we keep the oldest row's key and null out the rest,
    // leaving them as regular (unindexed) topics that an admin can merge via
    // the knowledge admin UI rather than crashing the app on startup.
    const dupes = db.prepare(`
        SELECT canonical_key, COUNT(*) AS c FROM topics
        WHERE canonical_key IS NOT NULL AND canonical_key != ''
        GROUP BY canonical_key HAVING c > 1
    `).all() as { canonical_key: string; c: number }[];

    if (dupes.length > 0) {
        console.warn(`[Migration] Found ${dupes.length} legacy duplicate-topic group(s) by canonical_key; keeping the oldest row per group and clearing the key on the rest so they can be merged manually.`);
        const nullOutExtras = db.prepare(`
            UPDATE topics SET canonical_key = NULL
            WHERE canonical_key = ? AND id NOT IN (
                SELECT MIN(id) FROM topics WHERE canonical_key = ?
            )
        `);
        for (const d of dupes) {
            nullOutExtras.run(d.canonical_key, d.canonical_key);
        }
    }

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_canonical_key ON topics(canonical_key) WHERE canonical_key IS NOT NULL AND canonical_key != \'\'');
} catch (e) {
    console.error('[Migration] Failed to create topics.canonical_key unique index:', e);
}

// ── Migration: enforce claim_hash uniqueness at the DB level ────────────────
// Ingestion already checks `SELECT ... WHERE claim_hash = ?` before inserting,
// but that check-then-insert is not atomic: two concurrent ingestion runs can
// both pass the check for the same claim text before either commits. A
// partial unique index closes that race and makes the invariant durable.
try {
    const dupeHashes = db.prepare(`
        SELECT claim_hash, COUNT(*) AS c FROM knowledge_claims
        WHERE claim_hash IS NOT NULL
        GROUP BY claim_hash HAVING c > 1
    `).all() as { claim_hash: string; c: number }[];

    if (dupeHashes.length > 0) {
        console.warn(`[Migration] Found ${dupeHashes.length} legacy duplicate-claim group(s) by claim_hash; clearing the hash on all but the oldest row per group so they are preserved but no longer block the unique index.`);
        const nullOutExtras = db.prepare(`
            UPDATE knowledge_claims SET claim_hash = NULL
            WHERE claim_hash = ? AND id NOT IN (
                SELECT MIN(id) FROM knowledge_claims WHERE claim_hash = ?
            )
        `);
        for (const d of dupeHashes) {
            nullOutExtras.run(d.claim_hash, d.claim_hash);
        }
    }

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_claims_hash ON knowledge_claims(claim_hash) WHERE claim_hash IS NOT NULL');
} catch (e) {
    console.error('[Migration] Failed to create knowledge_claims.claim_hash unique index:', e);
}

// ── Missing hot-path indexes ─────────────────────────────────────────────
// These four columns are queried constantly (every chat turn and every
// ingestion chunk) but had no supporting index, forcing full table scans
// that grow linearly with the size of the two biggest tables in the schema
// (knowledge_claims, topic_relationships). None of these change behavior —
// purely additive, zero-risk performance fixes.
try {
    // getTopicClaims / getTopicClaimsWithConflicts (every chat query) and the
    // per-topic "existing active claims" lookup inside checkConsistencyBatch
    // (every chunk during ingestion) both filter on topic_id.
    db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_claims_topic_id ON knowledge_claims(topic_id)');
} catch (e) {}
try {
    // Bulk cleanup during document deletion/reprocessing.
    db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_claims_doc_id ON knowledge_claims(doc_id)');
} catch (e) {}
try {
    // getRelatedTopics()'s `WHERE source_topic_id = ? OR target_topic_id = ?`
    // is only covered on the source side by the (source,target,type) PRIMARY
    // KEY — the target side requires a full table scan without this index.
    // Called on every chat turn via buildKnowledgeContext's topic expansion.
    db.exec('CREATE INDEX IF NOT EXISTS idx_topic_relationships_target ON topic_relationships(target_topic_id)');
} catch (e) {}
try {
    // getCanonicalTopicNames() (called once per chunk during ingestion via
    // buildVocabularyHint) joins document_topics on topic_id and groups by it.
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_topics_topic_id ON document_topics(topic_id)');
} catch (e) {}
try {
    // Chunk lookups/cleanup by document (reprocessing, deletion).
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id)');
} catch (e) {}

// Migration: Response feedback table for user ratings
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS response_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            message_index INTEGER NOT NULL,
            rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
            query_text TEXT,
            response_text TEXT,
            context_used TEXT,
            search_query TEXT,
            topic_ids TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
    `);
} catch (e) {}

// ── Migration: document cleaning audit log ──────────────────────────────────
// cleanDocument() now removes noise aggressively but records every removed span
// (and why) plus the verification verdict, so removals are inspectable rather
// than a black box. One row per document ingest attempt. `removals` is a JSON
// array of {text, reason, category}; `verdict` is 'cleaned' | 'cleaned_flagged'
// | 'fell_back' so an admin can find documents where cleaning was rejected or
// looked risky. Kept in a side table (not a documents column) so re-ingesting a
// document appends a new audit record instead of clobbering history.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS document_clean_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            filename TEXT,
            original_chars INTEGER,
            cleaned_chars INTEGER,
            removed_chars INTEGER,
            verdict TEXT,
            preserved_ratio REAL,
            removals TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE
        );
    `);
} catch (e) {}
try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_clean_log_doc_id ON document_clean_log(doc_id)');
} catch (e) {}
try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_clean_log_verdict ON document_clean_log(verdict)');
} catch (e) {}

// Migration: Store OIDC "display_name" (name) and "email" claims so the admin
// users table can show more than just the preferred_username. Only populated
// for OIDC users; local users leave these NULL.
try {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
} catch (e) {}
try {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
} catch (e) {}

// Migration: persist the source documents used for each assistant answer, so
// past conversations can trace an answer back to its sources (the "Find
// sources" feature). Stored as a JSON array of { filename, path }.
try {
    db.exec('ALTER TABLE chat_history ADD COLUMN sources TEXT');
} catch (e) {}


export function getDocuments() {
    return db.prepare(`
        SELECT d.id, d.filename, d.context, d.created_at, d.path, r.url as repo_url 
        FROM documents d
        LEFT JOIN git_repos r ON d.repo_id = r.id
        ORDER BY d.created_at DESC
    `).all();
}

export function deleteDocument(id: number) {
    // Delete from chunks first (cascading normally handled by FK, but let's be explicit)
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
    return db.prepare('DELETE FROM documents WHERE id = ?').run(id);
}

export interface SourceDocumentMatch {
    doc_id: number;
    filename: string;
    path: string | null;
    repo_id: number | null;
    matches: number;
    snippet: string;
}

/**
 * Full-text search the `chunks` FTS5 index for the given free text (typically a
 * user's selection from a chat answer) and return the source DOCUMENTS that
 * contain it, most relevant first. Each result carries a `snippet` — the
 * matching text with the hit wrapped in [[HL]]...[[/HL]] markers so the client
 * can render sentence-level highlights, plus the identifiers needed to deep-link
 * into the editable wiki (`repo_id` + `path`).
 *
 * When `restrictTo` is provided (the path/filename identifiers of the documents
 * actually used in the chat answer), the search is scoped to only those
 * documents — so a selection is traced back strictly to the answer's real
 * sources, never to unrelated documents that merely share keywords.
 */
export function searchSourceDocuments(
    rawText: string,
    limit = 20,
    restrictTo?: string[]
): SourceDocumentMatch[] {
    // Build a safe FTS5 MATCH query: keep alphanumeric words (>2 chars), OR them
    // together. Mirrors the sanitizer used by searchChunks in rag.ts.
    const words = (rawText || '')
        .replace(/[^\w\s]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(w => w.length > 2 && /^[a-zA-Z0-9_]+$/.test(w));

    if (words.length === 0) return [];

    const ftsQuery = words.map(w => `"${w.replace(/"/g, '""')}"`).join(' OR ');

    // Optional scoping to the documents actually used in the answer. Sources
    // carry either a `path` or a `filename`, so match on both columns.
    const identifiers = (restrictTo ?? [])
        .map(s => (s ?? '').trim())
        .filter(s => s.length > 0);
    // An empty restriction list means "no documents to search" — the answer had
    // no sources, so there is nothing to trace to.
    if (restrictTo !== undefined && identifiers.length === 0) return [];

    let restrictClause = '';
    const restrictParams: string[] = [];
    if (identifiers.length > 0) {
        const placeholders = identifiers.map(() => '?').join(', ');
        restrictClause = ` AND (d.path IN (${placeholders}) OR d.filename IN (${placeholders}))`;
        restrictParams.push(...identifiers, ...identifiers);
    }

    try {
        // FTS5's snippet()/bm25() cannot be combined with GROUP BY, so fetch the
        // best-ranked matching chunk rows first (one row per chunk, with a
        // highlighted snippet), then collapse to one entry per document in JS.
        // snippet(table, colIndex, open, close, ellipsis, tokens); col 0 = content.
        const rows = db.prepare(`
            SELECT
                d.id       AS doc_id,
                d.filename AS filename,
                d.path     AS path,
                d.repo_id  AS repo_id,
                snippet(chunks_fts, 0, '[[HL]]', '[[/HL]]', ' … ', 24) AS snippet,
                bm25(chunks_fts) AS relevance
            FROM chunks_fts
            JOIN chunks c    ON c.id = chunks_fts.rowid
            JOIN documents d ON d.id = c.doc_id
            WHERE chunks_fts MATCH ?${restrictClause}
            ORDER BY relevance ASC
            LIMIT 200
        `).all(ftsQuery, ...restrictParams) as Array<{
            doc_id: number; filename: string; path: string | null;
            repo_id: number | null; snippet: string; relevance: number;
        }>;

        const byDoc = new Map<number, SourceDocumentMatch>();
        for (const r of rows) {
            const existing = byDoc.get(r.doc_id);
            if (existing) {
                existing.matches += 1;
            } else {
                byDoc.set(r.doc_id, {
                    doc_id: r.doc_id,
                    filename: r.filename,
                    path: r.path,
                    repo_id: r.repo_id,
                    matches: 1,
                    // rows are pre-sorted by relevance, so the first snippet per
                    // doc is the best-matching one.
                    snippet: r.snippet
                });
            }
        }

        return Array.from(byDoc.values())
            .sort((a, b) => b.matches - a.matches)
            .slice(0, limit);
    } catch (e) {
        console.warn('searchSourceDocuments failed:', (e as Error).message);
        return [];
    }
}

export interface CleanLogEntry {
    docId: number | bigint | null;
    filename: string;
    originalChars: number;
    cleanedChars: number;
    verdict: 'cleaned' | 'cleaned_flagged' | 'fell_back';
    preservedRatio: number;
    removals: { text: string; reason?: string; category?: string }[];
    notes?: string;
}

/**
 * Records the outcome of a cleanDocument() pass so aggressive noise removal
 * stays auditable: what was removed, why, and whether the result was accepted,
 * flagged, or rejected in favour of the original text.
 */
export function recordCleanLog(entry: CleanLogEntry) {
    try {
        db.prepare(
            `INSERT INTO document_clean_log
                (doc_id, filename, original_chars, cleaned_chars, removed_chars, verdict, preserved_ratio, removals, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            entry.docId === null ? null : Number(entry.docId),
            entry.filename,
            entry.originalChars,
            entry.cleanedChars,
            Math.max(0, entry.originalChars - entry.cleanedChars),
            entry.verdict,
            entry.preservedRatio,
            JSON.stringify(entry.removals ?? []),
            entry.notes ?? null
        );
    } catch (e) {
        console.error('[CleanLog] Failed to record cleaning audit entry:', e);
    }
}
