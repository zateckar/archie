/**
 * A claim text exists at most once corpus-wide (idx_knowledge_claims_hash), so a
 * fact asserted by several documents is stored as ONE row attributed to whichever
 * document was ingested first. `claim_documents` records the other assertions and
 * `reattributeSharedClaims` hands the row to a surviving supporter before the FK
 * cascade can take it.
 *
 * The invariant these tests protect: **a fact disappears only when the last
 * document asserting it does.** It is easy to break by adding a document-delete
 * path that forgets to call `reattributeSharedClaims` first, and the breakage is
 * silent — the claim is simply gone, with nothing logged and no way to tell it was
 * ever supported elsewhere. Hence the coverage.
 *
 * Runs against a real, throwaway SQLite file (not a mock) because the behaviour
 * under test IS the schema's cascade semantics.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDb = path.join(os.tmpdir(), `claim-attribution-${process.pid}-${Date.now()}.db`);

let db: import('better-sqlite3').Database;
let deleteDocument: (id: number) => unknown;
let reattributeSharedClaims: (docId: number) => number;

beforeAll(async () => {
    // Must be set before db.ts is evaluated — it opens the file at import time.
    process.env.DATABASE_PATH = tmpDb;
    const mod = await import('./db');
    db = mod.db as unknown as import('better-sqlite3').Database;
    deleteDocument = mod.deleteDocument;
    reattributeSharedClaims = mod.reattributeSharedClaims;
});

afterAll(() => {
    try { db?.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpDb + suffix); } catch { /* never created */ }
    }
});

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

let seq = 0;
function makeDoc(): { docId: number; chunkId: number } {
    const name = `doc-${++seq}.md`;
    const docId = (db.prepare(
        "INSERT INTO documents (filename, content, context, content_hash) VALUES (?, 'body', ?, ?) RETURNING id"
    ).get(name, `ctx-${name}`, hash(name)) as { id: number }).id;
    const chunkId = (db.prepare(
        "INSERT INTO chunks (doc_id, content) VALUES (?, 'chunk') RETURNING id"
    ).get(docId) as { id: number }).id;
    return { docId, chunkId };
}

function makeTopic(): number {
    const name = `topic-${++seq}`;
    return (db.prepare(
        'INSERT INTO topics (name, canonical_key) VALUES (?, ?) RETURNING id'
    ).get(name, name) as { id: number }).id;
}

/** Mirrors ingestion: first assertion creates the claim, later ones only link. */
function assertClaim(topicId: number, text: string, doc: { docId: number; chunkId: number }): number {
    const existing = db.prepare('SELECT id FROM knowledge_claims WHERE claim_hash = ?')
        .get(hash(text)) as { id: number } | undefined;
    const claimId = existing?.id ?? (db.prepare(
        `INSERT INTO knowledge_claims (topic_id, doc_id, chunk_id, claim_text, claim_hash, status)
         VALUES (?, ?, ?, ?, ?, 'active') RETURNING id`
    ).get(topicId, doc.docId, doc.chunkId, text, hash(text)) as { id: number }).id;

    db.prepare('INSERT OR IGNORE INTO claim_documents (claim_id, doc_id, chunk_id) VALUES (?, ?, ?)')
        .run(claimId, doc.docId, doc.chunkId);
    return claimId;
}

const claimExists = (id: number) =>
    !!db.prepare('SELECT id FROM knowledge_claims WHERE id = ?').get(id);
const ownerOf = (id: number) =>
    (db.prepare('SELECT doc_id FROM knowledge_claims WHERE id = ?').get(id) as { doc_id: number }).doc_id;
const supporters = (id: number) =>
    (db.prepare('SELECT COUNT(*) c FROM claim_documents WHERE claim_id = ?').get(id) as { c: number }).c;

describe('shared claim attribution', () => {
    it('keeps a shared claim when the document it is attributed to is deleted', () => {
        const topic = makeTopic();
        const a = makeDoc(), b = makeDoc();
        const claimId = assertClaim(topic, 'Firewall passage follows MP 1.808.', a);
        assertClaim(topic, 'Firewall passage follows MP 1.808.', b);

        expect(supporters(claimId)).toBe(2);
        expect(ownerOf(claimId)).toBe(a.docId);

        deleteDocument(a.docId);

        expect(claimExists(claimId)).toBe(true);
        expect(ownerOf(claimId)).toBe(b.docId);
        expect(supporters(claimId)).toBe(1);
    });

    it('deletes the claim once its last supporting document is gone', () => {
        const topic = makeTopic();
        const a = makeDoc(), b = makeDoc();
        const claimId = assertClaim(topic, 'Only these two documents say this.', a);
        assertClaim(topic, 'Only these two documents say this.', b);

        deleteDocument(a.docId);
        expect(claimExists(claimId)).toBe(true);

        deleteDocument(b.docId);
        expect(claimExists(claimId)).toBe(false);
        expect(supporters(claimId)).toBe(0);
    });

    it('deletes a single-document claim with its document', () => {
        const topic = makeTopic();
        const a = makeDoc();
        const claimId = assertClaim(topic, 'Nobody else asserts this.', a);

        expect(reattributeSharedClaims(a.docId)).toBe(0);
        deleteDocument(a.docId);
        expect(claimExists(claimId)).toBe(false);
    });

    it('moves lineage (chunk and content hash) to the new owner', () => {
        const topic = makeTopic();
        const a = makeDoc(), b = makeDoc();
        const claimId = assertClaim(topic, 'Lineage must follow attribution.', a);
        assertClaim(topic, 'Lineage must follow attribution.', b);

        deleteDocument(a.docId);

        const row = db.prepare('SELECT chunk_id, doc_content_hash FROM knowledge_claims WHERE id = ?')
            .get(claimId) as { chunk_id: number | null; doc_content_hash: string | null };
        const bHash = (db.prepare('SELECT content_hash FROM documents WHERE id = ?')
            .get(b.docId) as { content_hash: string }).content_hash;

        expect(row.chunk_id).toBe(b.chunkId);
        expect(row.doc_content_hash).toBe(bHash);
    });

    it('re-attributes only claims the deleted document actually shares', () => {
        const topic = makeTopic();
        const a = makeDoc(), b = makeDoc();
        const shared = assertClaim(topic, 'Shared between A and B.', a);
        assertClaim(topic, 'Shared between A and B.', b);
        const solo = assertClaim(topic, 'Asserted by A alone.', a);

        expect(reattributeSharedClaims(a.docId)).toBe(1);
        expect(ownerOf(shared)).toBe(b.docId);
        expect(ownerOf(solo)).toBe(a.docId);
    });

    it('leaves no assertion row pointing at a deleted document or claim', () => {
        const topic = makeTopic();
        const a = makeDoc(), b = makeDoc();
        assertClaim(topic, 'Dangling-row check.', a);
        assertClaim(topic, 'Dangling-row check.', b);

        deleteDocument(a.docId);
        deleteDocument(b.docId);

        const dangling = (db.prepare(`
            SELECT COUNT(*) c FROM claim_documents cd
            WHERE NOT EXISTS (SELECT 1 FROM knowledge_claims kc WHERE kc.id = cd.claim_id)
               OR NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = cd.doc_id)
        `).get() as { c: number }).c;
        expect(dangling).toBe(0);
    });
});
