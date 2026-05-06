import 'dotenv/config';

import Database from 'better-sqlite3';
import { platform, arch } from 'os';
import { join } from 'path';
import fs from 'fs';

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
