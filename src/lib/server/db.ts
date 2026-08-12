import 'dotenv/config';

import Database from 'better-sqlite3';
import { platform, arch } from 'os';
import path, { join } from 'path';
import fs from 'fs';
import { normalizeTopicName } from './topic-normalize';
import { buildFtsMatchQuery } from './fts-query';

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

// Ensure the containing directory exists.
//
// This used to be `join(process.cwd(), <dir part>)` unconditionally, which broke
// any ABSOLUTE DATABASE_PATH — the common shape for a container deployment with a
// mounted volume. On Windows it produced a nonsense path
// ("D:\app\C:\data\rag.db") and failed loudly; on Linux `/data/rag.db` silently
// became `<cwd>/data/rag.db`, so the process quietly created a second, empty
// database inside the image instead of using the mounted volume — the corpus
// would look empty with nothing explaining why.
//
// `path.dirname` also replaces the manual '/'-splitting, which missed backslash
// separators on Windows entirely.
const dbDir = path.dirname(path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath));
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
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
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
        -- The omitted tokenize= is DELIBERATE. Do not "fix" it.
        --
        -- No tokenize= selects FTS5's default, "unicode61 remove_diacritics 1",
        -- which classifies token characters by Unicode category and already folds
        -- Czech diacritics on BOTH sides — at insert, and inside MATCH, because
        -- the query text runs through the same tokenizer. Measured on the live
        -- corpus: 7196 indexed terms, ZERO containing an accented character
        -- ("řízení" is indexed as "rizeni"), and MATCH '"rizeni"' and
        -- MATCH '"řízení"' each return the same 48 rows. This diacritic
        -- insensitivity is exactly what a Czech corpus wants.
        --
        -- remove_diacritics 0 was measured to drop MATCH '"rizeni"*' to 0 rows
        -- against "Bezpečnostní řízení projektů" — i.e. setting it explicitly to
        -- the wrong value destroys matching this corpus depends on. (remove_diacritics 2
        -- is a no-op for Czech; it only adds multi-combining-mark Latin like ǖ/ǭ.)
        --
        -- All Czech FTS breakage was upstream in JS, in the query sanitizers that
        -- shredded accented words before SQLite saw them. Fixed in ./fts-query.
        --
        -- If the tokenizer ever genuinely must change: CREATE VIRTUAL TABLE IF NOT
        -- EXISTS will NOT alter an existing table's tokenizer, so editing this line
        -- alone is a silent no-op on every deployed database while the source claims
        -- otherwise. It requires a schema_migrations-guarded DROP + CREATE +
        -- INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild'), all inside ONE
        -- transaction — the chunks_ai/chunks_ad/chunks_au triggers below reference
        -- chunks_fts by name, so a crash between DROP and CREATE makes every write
        -- to the chunks table fail with "no such table" and break ingestion for good.
        -- Omitting the 'rebuild' leaves a valid but EMPTY index, which both callers
        -- swallow into an empty result set with no error.
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

// Migration: pinned conversations. Pinned rows are listed in their own section
// above the rest and are refused by DELETE until they are unpinned.
try {
    db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
} catch (e) {}
try {
    // The sidebar's only ordering: pinned first, most recently touched first.
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_conversations_user_pinned_updated ON conversations(user_id, pinned DESC, updated_at DESC)'
    );
} catch (e) {}
try {
    // Sidebar search scans a user's own messages by conversation.
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_history_conversation ON chat_history(conversation_id)');
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

// ── Migration: community reports (thematic / "global" retrieval) ────────────
// Louvain assigns every topic a `community_id`, but a bare cluster of topic IDs
// is not retrievable — you cannot embed "community 7" and match it against a
// query. A *report* (LLM-written title + summary over the community's topics and
// claims) can be embedded, which is what turns the clustering into a retrieval
// path for broad, thematic questions ("what areas does the corpus cover?",
// "summarise our security posture") that no single topic answers well.
//
// Keyed on `member_hash` rather than `community_id` because Louvain renumbers
// communities on every recompute: a cluster whose membership is unchanged
// generally comes back under a different id. Hashing the sorted member topic ids
// (plus their active-claim count, so a report refreshes when the underlying
// facts materially change) lets an unchanged cluster reuse its cached report for
// free and re-point `community_id` at it, instead of paying for an LLM call per
// community on every single ingestion.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS community_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_hash TEXT NOT NULL UNIQUE,
            community_id INTEGER,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            topic_count INTEGER NOT NULL DEFAULT 0,
            claim_count INTEGER NOT NULL DEFAULT 0,
            embedding BLOB,
            embedding_updated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
} catch (e) {}
try {
    // Reports whose community_id is NULL are orphans from a partition that no
    // longer exists; the thematic search path filters on this column.
    db.exec('CREATE INDEX IF NOT EXISTS idx_community_reports_community_id ON community_reports(community_id) WHERE community_id IS NOT NULL');
} catch (e) {}

// Migration: Add chunk_id to knowledge_claims for source lineage
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL');
} catch (e) {}

// Migration: Add claim_type to knowledge_claims for expanded claim types
try {
    db.exec("ALTER TABLE knowledge_claims ADD COLUMN claim_type TEXT DEFAULT 'assertion'");
} catch (e) {}

// ── Migration: claim supersession ───────────────────────────────────────────
// `checkConsistencyBatch` classifies each new claim against the topic's
// existing ones as unique/duplicate/conflict/update, but the `update` verdict —
// "this is a more recent or more specific version of an existing claim" — was
// mapped to plain `active` and thrown away. Both the stale claim and its
// replacement then stayed active forever, so retrieval kept serving superseded
// facts alongside current ones with nothing to tell them apart.
//
// `superseded_by` points at the claim that replaced this one, and
// `superseded_at` records when. Together with the existing `created_at` these
// give claims a transaction-time history: what the knowledge base believed, and
// when it stopped believing it. Retirement is a status change, never a delete,
// so the trail stays auditable and a bad supersession can be undone.
//
// Note this is transaction time only. Real bi-temporal modelling would also
// carry valid-time (when the fact holds in the world, independent of when we
// learned it), but nothing in the extraction pipeline produces those dates
// today, so there is no honest value to put in such a column.
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN superseded_by INTEGER REFERENCES knowledge_claims(id) ON DELETE SET NULL');
} catch (e) {}
try {
    db.exec('ALTER TABLE knowledge_claims ADD COLUMN superseded_at DATETIME');
} catch (e) {}
try {
    // Supports the "what did this claim replace / what replaced it" lookups
    // behind the admin history view.
    db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_claims_superseded_by ON knowledge_claims(superseded_by) WHERE superseded_by IS NOT NULL');
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

// ── Migration: recompute canonical_key after the unicode-folding fix ────────
// `normalizeTopicName` used to strip every non-ASCII character when building
// the key, so on a Czech corpus "Řízení" keyed as "zen" and "Řešení" as "een".
// Two consequences, both silent: the same concept typed with and without
// diacritics ("Řízení projektů" / "Rizeni projektu") produced *different* keys
// and was never merged, and unrelated accented topics could be squashed onto
// the same mangled key. `foldDiacritics` now folds to the ASCII base letter
// instead.
//
// The backfill above only touches rows where canonical_key IS NULL, so every
// topic that already carries a mangled key would keep it forever. This runs
// once to recompute the whole column under the new algorithm.
//
// Unlike the try/catch ALTER TABLE blocks around it, this one is guarded by a
// `schema_migrations` row: it is not idempotent-by-accident (re-running it
// would re-null keys an admin may have merged by hand since), so it needs a
// real applied/not-applied record.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
} catch (e) {
    console.error('[Migration] Failed to create schema_migrations table:', e);
}

const RECOMPUTE_KEYS_MIGRATION = 'recompute-canonical-key-unicode-fold';
try {
    const alreadyApplied = db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(RECOMPUTE_KEYS_MIGRATION);

    if (!alreadyApplied) {
        const rows = db
            .prepare('SELECT id, name FROM topics ORDER BY id ASC')
            .all() as { id: number; name: string }[];

        // Oldest row per key wins, matching the backfill above and the app's
        // ON CONFLICT upsert. Losers are left NULL rather than deleted: a
        // collision here means two topics the old algorithm kept apart are in
        // fact the same concept, and merging their claims is a judgement call
        // for an admin, not something a startup migration should do silently.
        const seen = new Map<string, { id: number; name: string }>();
        const collisions: { kept: string; dropped: string; key: string }[] = [];
        const assignments: { id: number; key: string | null }[] = [];

        for (const row of rows) {
            const { key } = normalizeTopicName(row.name);
            if (!key) {
                assignments.push({ id: row.id, key: null });
                continue;
            }
            const winner = seen.get(key);
            if (winner) {
                collisions.push({ kept: winner.name, dropped: row.name, key });
                assignments.push({ id: row.id, key: null });
                continue;
            }
            seen.set(key, row);
            assignments.push({ id: row.id, key });
        }

        // The unique index must go before the rewrite: intermediate states
        // during the UPDATE pass would otherwise violate it even though the
        // final state is conflict-free.
        const rewriteTx = db.transaction(() => {
            db.exec('DROP INDEX IF EXISTS idx_topics_canonical_key');
            const update = db.prepare('UPDATE topics SET canonical_key = ? WHERE id = ?');
            for (const a of assignments) {
                update.run(a.key, a.id);
            }
            db.exec(
                "CREATE UNIQUE INDEX idx_topics_canonical_key ON topics(canonical_key) WHERE canonical_key IS NOT NULL AND canonical_key != ''"
            );
            db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(RECOMPUTE_KEYS_MIGRATION);
        });
        rewriteTx();

        console.log(
            `[Migration] Recomputed canonical_key for ${rows.length} topic(s) using unicode folding.`
        );
        if (collisions.length > 0) {
            // Loud on purpose: these are duplicate topics the old ASCII-strip
            // hid, and they stay split until someone merges them in the
            // knowledge admin UI.
            console.warn(
                `[Migration] ${collisions.length} topic(s) now collide with an existing topic and were left unkeyed for manual merge:`
            );
            for (const c of collisions) {
                console.warn(`[Migration]   "${c.dropped}" -> "${c.kept}" (key: ${c.key})`);
            }
        }
    }
} catch (e) {
    console.error(`[Migration] Failed to recompute topics.canonical_key:`, e);
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

// ── Migration: claim_documents — which documents assert each claim ──────────
// `idx_knowledge_claims_hash` makes a claim text exist at most ONCE corpus-wide,
// and ingestion skips a claim whose hash is already present. That dedup is worth
// keeping (it is what stops the same sentence being stored dozens of times), but
// on its own it loses information: when document B re-asserts a fact document A
// already stated, B's assertion was silently dropped, so the only record of that
// fact was a single row owned by A. Deleting or editing A then removed a fact
// that B still asserts — and B would not re-assert it until B was itself
// reprocessed. Worse, nothing could even detect the situation: "is this the last
// document making this claim?" was unanswerable, because B's support was never
// written down anywhere.
//
// This table is that record: one row per (claim, document) assertion. It makes
// the dedup non-destructive — the claim row stays single, and the extra
// supporters are remembered — which is what lets `reattributeSharedClaims` hand
// a shared claim to a surviving document instead of letting the FK cascade take
// it (see that function).
//
// `chunk_id` keeps per-document lineage: two documents asserting the same fact
// each point at their own chunk, so "where does this come from in *that*
// document" survives too. ON DELETE SET NULL matches knowledge_claims.chunk_id —
// re-chunking must not destroy the assertion record.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS claim_documents (
            claim_id INTEGER NOT NULL,
            doc_id INTEGER NOT NULL,
            chunk_id INTEGER,
            doc_content_hash TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (claim_id, doc_id),
            FOREIGN KEY (claim_id) REFERENCES knowledge_claims(id) ON DELETE CASCADE,
            FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
            FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE SET NULL
        );
    `);
    // "Which documents support claim X" is covered by the PK's leading column;
    // this index serves the other direction ("this document's assertions"),
    // which every delete/reprocess path uses.
    db.exec('CREATE INDEX IF NOT EXISTS idx_claim_documents_doc_id ON claim_documents(doc_id)');

    // Backfill: every existing claim is supported by (at least) the document it
    // is attributed to. Assertions that were dropped by the old dedup are NOT
    // recoverable here — they were never written down — so a corpus ingested
    // before this migration under-reports shared support until those documents
    // are reprocessed. One row per existing claim is still the correct floor:
    // it makes "no supporting documents" mean genuinely unsupported.
    const backfilled = db.prepare(`
        INSERT OR IGNORE INTO claim_documents (claim_id, doc_id, chunk_id, doc_content_hash)
        SELECT id, doc_id, chunk_id, doc_content_hash FROM knowledge_claims WHERE doc_id IS NOT NULL
    `).run();
    if (backfilled.changes > 0) {
        console.log(`[Migration] Recorded ${backfilled.changes} claim-document assertion(s) in claim_documents.`);
    }
} catch (e) {
    console.error('[Migration] Failed to create/backfill claim_documents:', e);
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
try {
    // The paged claim list (lib/server/knowledge-queries.ts) filters on status for
    // every page and every COUNT — the explorer on 'active', the admin review tabs
    // on 'conflicting' / 'flagged' / 'superseded'. Without this, each page view is
    // two full scans of the largest table in the schema.
    db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_claims_status ON knowledge_claims(status)');
} catch (e) {}
try {
    // Category is the primary filter on the paged topic list and the graph view.
    db.exec('CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category)');
} catch (e) {}
try {
    // Topic list sorted by name (the 'name' sort and the hierarchy view's ORDER BY)
    // built a temporary B-tree over every topic on each request.
    db.exec('CREATE INDEX IF NOT EXISTS idx_topics_name ON topics(name)');
} catch (e) {}
try {
    // The hierarchy view resolves children by parent; also the orphan-topic count.
    db.exec('CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_topic_id) WHERE parent_topic_id IS NOT NULL');
} catch (e) {}

// ── Per-user access paths ────────────────────────────────────────────────────
// These three queries run on the hottest paths in the app and every one of them
// was a full table scan (verified with EXPLAIN QUERY PLAN); the two with an
// ORDER BY also built a temporary B-tree to sort. Small tables today, but
// chat_history gains a row per message and is never pruned, so this is the set
// that degrades as the app is actually used.
try {
    // `SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC`
    // — the sidebar, on every page load. Including updated_at lets the index
    // satisfy the sort as well as the filter, removing the temp B-tree.
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
} catch (e) {}
try {
    // `SELECT ... FROM chat_history WHERE user_id = ? AND conversation_id = ?
    //  ORDER BY created_at ASC` — every time a conversation is opened. Covers
    // filter and sort in one index.
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_history_user_conv_created ON chat_history(user_id, conversation_id, created_at)');
} catch (e) {}
try {
    // Needed by the ON DELETE CASCADE from users, and by the expired-session
    // purge in auth.ts. Without it, deleting a user scans the whole table.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
} catch (e) {}
try {
    // The daily purge filters on expires_at alone.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)');
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

// ── Migration: token_usage — per-call LLM token accounting ──────────────────
// Every model call in this app funnels through ./providers, and until now none
// of it was measured: there was no way to answer "how much of our spend is
// answering user questions vs. ingesting documents vs. building and maintaining
// the knowledge graph?" — which matters here because the three are wildly
// asymmetric (one chat turn is a dozen-plus calls, but one document ingest is a
// clean + summarize + chunk pass plus an extraction and consistency check for
// EVERY chunk).
//
// One row per provider call, written by ./usage. Deliberately raw rather than
// pre-aggregated: rollup tables would have to commit up front to a bucket size,
// and the dashboard needs hourly resolution for a 1-day span and daily for 30
// days off the same data. Aggregation is done in SQL at read time instead.
//
// `category` is the coarse bucket the dashboard charts (chat | documents |
// knowledge | other) and comes from the AsyncLocalStorage context that ./usage
// sets at each pipeline entry point; `operation` is the fine-grained label of
// the specific LLM task (clean_document, extract_knowledge, chat_answer, …).
//
// `estimated` marks rows whose token counts were derived from character length
// because the provider reported no usage numbers (Gemini's embedding endpoint
// returns none, and a gateway that ignores stream_options gives none for a
// streamed answer). Kept as a column rather than silently mixing the two, so
// the dashboard can say how much of a total is measured vs. approximated.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            category TEXT NOT NULL,
            operation TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            kind TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            estimated INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER,
            failed INTEGER NOT NULL DEFAULT 0
        );
    `);
} catch (e) {
    console.error('[Migration] Failed to create token_usage:', e);
}
try {
    // Every dashboard query is a range scan over created_at; the composite index
    // also covers the per-category GROUP BY that builds the stacked series.
    db.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at)');
} catch (e) {}
try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_category_created ON token_usage(category, created_at)');
} catch (e) {}

// ── app_state ───────────────────────────────────────────────────────────────
//
// Scalar bookkeeping the app needs to survive a restart but that belongs to no
// entity table: "when did the periodic taxonomy rebuild last run", and whatever
// joins it later. A generic key/value table rather than a column bolted onto an
// unrelated row, because the alternative on offer was `git_repos` — and the
// rebuild is corpus-wide, so hanging its timestamp off one repo would make the
// answer depend on which repo happened to sync first.
//
// Values are TEXT and callers own the encoding (see appStateNumber for the
// epoch-ms case). Distinct from `schema_migrations`, which records one-shot
// applied/not-applied facts about the schema and must never be rewritten.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
} catch (e) {
    console.error('[Migration] Failed to create app_state:', e);
}

/** Reads an app_state value, or null when the key was never written. */
export function getAppState(key: string): string | null {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
        | { value: string | null }
        | undefined;
    return row?.value ?? null;
}

/** Writes (or overwrites) an app_state value and stamps updated_at. */
export function setAppState(key: string, value: string): void {
    db.prepare(`
        INSERT INTO app_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
}

/**
 * An app_state value read as a finite number, or null.
 *
 * Returns null rather than NaN or 0 for a missing/garbled value, because callers
 * use it for "have we ever done this?" checks where NaN comparisons silently
 * answer "no" and 0 answers "yes, in 1970" — two different wrong answers.
 */
export function getAppStateNumber(key: string): number | null {
    const raw = getAppState(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

// ── user_preferences ────────────────────────────────────────────────────────
//
// Per-user UI state that must survive a browser change, so localStorage is not
// enough: currently just the recents panel width. Keyed like app_state — TEXT
// values, callers own the encoding — but scoped to a user and cascading with
// them, which is why it is a separate table rather than namespaced keys in
// app_state.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, key),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
} catch (e) {
    console.error('[Migration] Failed to create user_preferences:', e);
}

/** Reads one user's preference, or null when they never set it. */
export function getUserPreference(userId: number, key: string): string | null {
    const row = db
        .prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?')
        .get(userId, key) as { value: string | null } | undefined;
    return row?.value ?? null;
}

/** Writes (or overwrites) one user's preference and stamps updated_at. */
export function setUserPreference(userId: number, key: string, value: string): void {
    db.prepare(`
        INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(userId, key, value);
}

// ── api_tokens: removed ─────────────────────────────────────────────────────
//
// A short-lived experiment in bespoke personal access tokens for the MCP server,
// replaced before release by standard OAuth 2.1: /api/mcp is now a resource
// server that validates access tokens issued by the configured OIDC provider
// (see ./oauth-token), so there is no app-issued credential to store. Dropped
// rather than left behind so nothing can quietly keep authenticating with one.
try {
    db.exec('DROP TABLE IF EXISTS api_tokens');
} catch (e) {
    console.error('[Migration] Failed to drop api_tokens:', e);
}

export function getDocuments() {
    return db.prepare(`
        SELECT d.id, d.filename, d.context, d.created_at, d.path, r.url as repo_url 
        FROM documents d
        LEFT JOIN git_repos r ON d.repo_id = r.id
        ORDER BY d.created_at DESC
    `).all();
}

/**
 * Hands every claim currently attributed to `docId` that ANOTHER document also
 * asserts over to one of those other documents, and reports how many moved.
 *
 * This is the "is this the last document making this claim?" check, done at the
 * only moment it can be done: `knowledge_claims.doc_id` cascades on document
 * delete, so once the document row is gone the claim is gone with it and there is
 * nothing left to inspect. Run this FIRST and the cascade then removes exactly
 * the claims that really were solely supported by `docId`, while shared facts
 * survive under a document that still asserts them.
 *
 * MUST be called before any path that deletes a document row or bulk-deletes a
 * document's claims. There are four such paths (re-ingest, git file removal,
 * deleteDocument, single-document reprocess); a fifth that forgets to call this
 * silently reintroduces the data loss this exists to prevent.
 *
 * `chunk_id` and `doc_content_hash` move with the attribution — the claim's
 * lineage must point into the document it is now credited to, not into chunks
 * that are about to be deleted.
 *
 * Returns the number of claims re-attributed (0 is the common case).
 */
export function reattributeSharedClaims(docId: number): number {
    const result = db.prepare(`
        UPDATE knowledge_claims AS kc
        SET doc_id = (
                SELECT cd.doc_id FROM claim_documents cd
                WHERE cd.claim_id = kc.id AND cd.doc_id != ? ORDER BY cd.doc_id LIMIT 1
            ),
            chunk_id = (
                SELECT cd.chunk_id FROM claim_documents cd
                WHERE cd.claim_id = kc.id AND cd.doc_id != ? ORDER BY cd.doc_id LIMIT 1
            ),
            doc_content_hash = (
                SELECT d.content_hash FROM claim_documents cd
                JOIN documents d ON d.id = cd.doc_id
                WHERE cd.claim_id = kc.id AND cd.doc_id != ? ORDER BY cd.doc_id LIMIT 1
            )
        WHERE kc.doc_id = ?
          AND EXISTS (
                SELECT 1 FROM claim_documents cd
                WHERE cd.claim_id = kc.id AND cd.doc_id != ?
            )
    `).run(docId, docId, docId, docId, docId);

    if (result.changes > 0) {
        console.log(
            `[KnowledgeGC] Re-attributed ${result.changes} claim(s) away from document ${docId} — ` +
            `other documents still assert them, so they are kept.`
        );
    }
    return result.changes;
}

export function deleteDocument(id: number) {
    // Keep facts other documents also assert (see reattributeSharedClaims). Must
    // happen before the delete below, while claim_documents still has this
    // document's rows to compare against.
    reattributeSharedClaims(id);
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
    // Built by the shared helper in ./fts-query, which `searchChunks` in rag.ts
    // also uses — previously each had its own copy of the sanitizer with a
    // comment claiming they mirrored each other, and they had silently drifted
    // (one emitted prefix matches, the other exact).
    //
    // Both copies were broken the same way: the ASCII-only `\w` class replaced
    // every accented letter with a space, so a Czech selection shattered into
    // fragments. Measured against an index holding "Bezpečnostní řízení projektů
    // vyžaduje schválení": the fragments it produced ("bezpe", "nostn", "zen",
    // "schv", "len") returned 0 rows individually AND as an OR chain, while the
    // correct tokens returned 1 each. So "Find sources" came back empty for
    // essentially every Czech selection, and the UI blamed the user's selection
    // rather than the query builder.
    //
    // `prefix: true` where this used to demand exact tokens: Czech is heavily
    // inflected, so the surface form the user selected ("řízení") routinely
    // differs from the form indexed in another chunk ("řízeními"). Exact-token
    // matching costs real recall even now that the folding bug is gone.
    const ftsQuery = buildFtsMatchQuery(rawText || '', { prefix: true });

    if (ftsQuery === null) return [];

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
