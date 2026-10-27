/**
 * Re-judges every `conflicting` claim under the scope-aware conflict rules.
 *
 * Most conflicts in the production corpus were written before the consistency
 * checker saw provenance or had to name the claim a conflict is with. In a
 * sample of ten, nearly all were scope differences between documents filed
 * under a generic topic, not contradictions. Each one is guaranteed a ⚠ slot
 * in the chat context for its topic, so a false one tells users the
 * documentation contradicts itself when it does not.
 *
 * For each conflicting claim, this asks the checker again — with sources and
 * the strict rules — against the active claims on the same topic nearest to it:
 *   - still a conflict with a named counterpart → keep, record `conflicts_with`
 *   - anything else → set back to `active`
 *
 * Dry run by default; nothing is written without --apply. Costs one LLM call per
 * conflicting claim and no embedding calls (stored vectors are used).
 *
 * Usage (from the project root, against the DB in DATABASE_PATH):
 *   npx tsx scripts/recheck-conflicts.ts                 # dry run, all
 *   npx tsx scripts/recheck-conflicts.ts --limit 20      # dry run, first 20
 *   npx tsx scripts/recheck-conflicts.ts --apply         # write verdicts
 */
import 'dotenv/config';
import { db } from '../src/lib/server/db';
import { checkConsistencyBatch } from '../src/lib/server/llm';
import { blobToVector, pickComparableClaims } from '../src/lib/server/claim-similarity';
import { withUsageCategory } from '../src/lib/server/usage';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

const MAX_COMPARABLE = 40;

interface ClaimRow {
    id: number;
    topic_id: number;
    claim_text: string;
    embedding: Buffer | null;
    source: string | null;
}

async function main() {
    const conflicting = db.prepare(`
        SELECT kc.id, kc.topic_id, kc.claim_text, kc.embedding, COALESCE(d.path, d.filename) AS source
        FROM knowledge_claims kc
        LEFT JOIN documents d ON d.id = kc.doc_id
        WHERE kc.status = 'conflicting'
        ORDER BY kc.id
    `).all() as ClaimRow[];

    const todo = conflicting.slice(0, Number.isFinite(limit) ? limit : undefined);
    console.log(`${conflicting.length} conflicting claim(s); checking ${todo.length}${apply ? '' : ' (dry run)'}.`);

    const activeOnTopic = db.prepare(`
        SELECT kc.id, kc.topic_id, kc.claim_text, kc.embedding, COALESCE(d.path, d.filename) AS source
        FROM knowledge_claims kc
        LEFT JOIN documents d ON d.id = kc.doc_id
        WHERE kc.topic_id = ? AND kc.status = 'active' AND kc.id != ?
        ORDER BY kc.id
    `);
    const keep = db.prepare('UPDATE knowledge_claims SET conflicts_with = ? WHERE id = ?');
    const release = db.prepare("UPDATE knowledge_claims SET status = 'active', conflicts_with = NULL WHERE id = ? AND status = 'conflicting'");

    let kept = 0, released = 0, failed = 0;
    for (const claim of todo) {
        try {
            const vector = blobToVector(claim.embedding);
            const candidates = (activeOnTopic.all(claim.topic_id, claim.id) as ClaimRow[])
                .map(c => ({ ...c, embedding: blobToVector(c.embedding) }));
            const existing = vector ? pickComparableClaims(candidates, [vector], MAX_COMPARABLE) : candidates.slice(0, MAX_COMPARABLE);

            const [verdict] = await checkConsistencyBatch(
                [claim.claim_text],
                existing.map(c => ({ text: c.claim_text, source: c.source })),
                claim.source,
                // A failed call must surface as FAILED, never as "no conflict".
                { throwOnError: true }
            );
            const target = verdict?.status === 'conflict' && verdict.conflictsWithIndex !== undefined
                ? existing[verdict.conflictsWithIndex]
                : undefined;

            if (target) {
                kept++;
                console.log(`KEEP    #${claim.id} "${claim.claim_text.slice(0, 90)}"\n        vs #${target.id} "${target.claim_text.slice(0, 90)}" — ${verdict.reason ?? ''}`);
                if (apply) keep.run(target.id, claim.id);
            } else {
                released++;
                console.log(`RELEASE #${claim.id} "${claim.claim_text.slice(0, 90)}" — ${verdict?.status ?? 'no verdict'}: ${verdict?.reason ?? ''}`);
                if (apply) release.run(claim.id);
            }
        } catch (err) {
            failed++;
            console.error(`FAILED  #${claim.id}:`, (err as Error).message);
        }
    }

    console.log(`\nKept ${kept}, released ${released}, failed ${failed}.${apply ? '' : ' Dry run — re-run with --apply to write.'}`);
}

withUsageCategory('knowledge', main)
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
