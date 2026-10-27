/**
 * Restores claim → chunk provenance for claims that have none.
 *
 * `chunk_id` was added to knowledge_claims after the first full extraction, so
 * every claim created before that migration has none — 74% of the production
 * graph at the time of writing. Without it, retrieval cannot show the passage a
 * fact came from, and an answer has only the extractor's paraphrase to go on.
 *
 * The link is recovered without any model call: for each (claim, document)
 * assertion with no chunk, the claim's stored embedding is compared with the
 * stored embeddings of THAT document's chunks, and the nearest one wins if it
 * clears --min-score. Restricting to the asserting document is what makes this
 * safe: the answer is always a chunk of a document that states the fact.
 *
 * Dry run by default (prints the score distribution); --apply writes.
 *
 * Usage (from the project root, against the DB in DATABASE_PATH):
 *   npx tsx scripts/backfill-claim-chunks.ts
 *   npx tsx scripts/backfill-claim-chunks.ts --validate      # measure matcher accuracy
 *   npx tsx scripts/backfill-claim-chunks.ts --apply
 */
import 'dotenv/config';
import { db } from '../src/lib/server/db';
import { blobToVector, nearest } from '../src/lib/server/claim-similarity';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const minArg = args.indexOf('--min-score');
// Default from --validate on the production copy (2026-10-27): the nearest chunk
// was the recorded one 74-78% of the time below 0.8 and 90% at 0.8 and above.
// Below the floor a link is more likely than not to be merely plausible.
const minScore = minArg >= 0 ? Number(args[minArg + 1]) : 0.8;

interface Assertion {
    claim_id: number;
    doc_id: number;
    claim_doc_id: number | null;
    embedding: Buffer | null;
}

// --validate: run the same matcher over assertions whose chunk IS known and
// report how often it picks the right one, per score bucket. That accuracy is
// what --min-score should be chosen from.
if (args.includes('--validate')) {
    const known = db.prepare(`
        SELECT cd.doc_id, cd.chunk_id, kc.embedding
        FROM claim_documents cd JOIN knowledge_claims kc ON kc.id = cd.claim_id
        WHERE cd.chunk_id IS NOT NULL
        ORDER BY cd.doc_id
    `).all() as { doc_id: number; chunk_id: number; embedding: Buffer | null }[];
    const chunksOfDoc = db.prepare('SELECT id, embedding FROM chunks WHERE doc_id = ?');
    const byBucket = new Map<string, { n: number; right: number }>();
    let doc = -1;
    let chunks: { id: number; embedding: Float32Array | null }[] = [];
    for (const k of known) {
        if (k.doc_id !== doc) {
            doc = k.doc_id;
            chunks = (chunksOfDoc.all(doc) as { id: number; embedding: Buffer | null }[])
                .map(c => ({ id: c.id, embedding: blobToVector(c.embedding) }));
        }
        const v = blobToVector(k.embedding);
        const best = v ? nearest(v, chunks) : null;
        if (!best) continue;
        const bucket = (Math.floor(best.score * 10) / 10).toFixed(1);
        const s = byBucket.get(bucket) ?? { n: 0, right: 0 };
        s.n++;
        if (best.item.id === k.chunk_id) s.right++;
        byBucket.set(bucket, s);
    }
    console.log(`Validation over ${known.length} assertions with a known chunk:`);
    for (const [bucket, s] of [...byBucket.entries()].sort()) {
        console.log(`  ${bucket}–: ${s.n} assertions, nearest chunk correct ${Math.round((100 * s.right) / s.n)}%`);
    }
    process.exit(0);
}

const assertions = db.prepare(`
    SELECT cd.claim_id, cd.doc_id, kc.doc_id AS claim_doc_id, kc.embedding
    FROM claim_documents cd
    JOIN knowledge_claims kc ON kc.id = cd.claim_id
    WHERE cd.chunk_id IS NULL
    ORDER BY cd.doc_id
`).all() as Assertion[];

const chunksOf = db.prepare('SELECT id, embedding FROM chunks WHERE doc_id = ?');
const setAssertion = db.prepare('UPDATE claim_documents SET chunk_id = ? WHERE claim_id = ? AND doc_id = ? AND chunk_id IS NULL');
const setClaim = db.prepare('UPDATE knowledge_claims SET chunk_id = ? WHERE id = ? AND doc_id = ? AND chunk_id IS NULL');

const histogram = new Map<string, number>();
let matched = 0, belowFloor = 0, noVectors = 0;
let currentDoc = -1;
let docChunks: { id: number; embedding: Float32Array | null }[] = [];
const updates: { chunkId: number; a: Assertion }[] = [];

for (const a of assertions) {
    if (a.doc_id !== currentDoc) {
        currentDoc = a.doc_id;
        docChunks = (chunksOf.all(a.doc_id) as { id: number; embedding: Buffer | null }[])
            .map(c => ({ id: c.id, embedding: blobToVector(c.embedding) }));
    }
    const vector = blobToVector(a.embedding);
    const best = vector ? nearest(vector, docChunks) : null;
    if (!best) { noVectors++; continue; }

    const bucket = (Math.floor(best.score * 10) / 10).toFixed(1);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);

    if (best.score < minScore) { belowFloor++; continue; }
    matched++;
    updates.push({ chunkId: best.item.id, a });
}

if (apply) {
    db.transaction(() => {
        for (const { chunkId, a } of updates) {
            setAssertion.run(chunkId, a.claim_id, a.doc_id);
            if (a.claim_doc_id === a.doc_id) setClaim.run(chunkId, a.claim_id, a.doc_id);
        }
    })();
}

console.log(`Assertions without a chunk: ${assertions.length}`);
console.log('Nearest-chunk similarity distribution:');
for (const [bucket, n] of [...histogram.entries()].sort()) console.log(`  ${bucket}–: ${n}`);
console.log(`Matched (>= ${minScore}): ${matched}; below floor: ${belowFloor}; no vectors: ${noVectors}.`);
console.log(apply ? 'Written.' : 'Dry run — re-run with --apply to write.');
process.exit(0);
