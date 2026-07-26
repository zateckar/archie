/**
 * Generate DRAFT golden-set cases. Every case it writes is `reviewed: false`
 * and the runner skips those — a draft is a starting point for a human, not a
 * label. Nothing here knows what the right answer is; it only knows what is in
 * the corpus.
 *
 *   npm run eval:seed              # merge drafts into golden-set.json
 *   npm run eval:seed -- --count 30
 *
 * Two sources:
 *
 *  1. `response_feedback` — thumbs-down rows are the highest-value cases,
 *     because a human already said the answer was wrong. This table is written
 *     by the chat UI but currently has no rows, so this source yields nothing
 *     until real feedback accumulates.
 *
 *  2. The knowledge graph — for well-populated topics, emit "what is X" style
 *     probes with the topic itself as the expected result and one of its own
 *     claims as an expected substring. These are weak by construction (they
 *     mostly test that a topic can retrieve itself) and exist to give the set
 *     shape; the real value comes from editing them into questions people
 *     actually ask, with the topics that *should* answer them.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../../src/lib/server/db.ts';
import type { GoldenSet, GoldenCase } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SET_PATH = path.join(HERE, 'golden-set.json');

const argv = process.argv.slice(2);
const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
const COUNT = Number(value('count') ?? 20);

const existing: GoldenSet = fs.existsSync(SET_PATH)
    ? JSON.parse(fs.readFileSync(SET_PATH, 'utf-8'))
    : { version: 1, cases: [] };

const seenIds = new Set(existing.cases.map((c) => c.id));
const seenQueries = new Set(existing.cases.map((c) => c.query.trim().toLowerCase()));
const drafts: GoldenCase[] = [];

// ── Source 1: negative feedback ────────────────────────────────────────────
const feedback = db.prepare(`
    SELECT id, query_text, topic_ids, rating
    FROM response_feedback
    WHERE rating = -1 AND query_text IS NOT NULL AND TRIM(query_text) != ''
    ORDER BY created_at DESC
    LIMIT ?
`).all(COUNT) as { id: number; query_text: string; topic_ids: string | null }[];

for (const f of feedback) {
    const id = `fb-${f.id}`;
    if (seenIds.has(id) || seenQueries.has(f.query_text.trim().toLowerCase())) continue;

    // topic_ids records what retrieval *did* return, which is precisely what a
    // human judged unsatisfactory — so it seeds the field as a prompt to
    // correct, never as the expected answer.
    let retrieved: string[] = [];
    try {
        const ids = JSON.parse(f.topic_ids ?? '[]') as number[];
        if (ids.length) {
            const ph = ids.map(() => '?').join(',');
            retrieved = (db.prepare(`SELECT name FROM topics WHERE id IN (${ph})`).all(...ids) as { name: string }[])
                .map((r) => r.name);
        }
    } catch { /* malformed topic_ids — leave empty */ }

    drafts.push({
        id,
        query: f.query_text.trim(),
        expectedTopics: retrieved,
        reviewed: false,
        note:
            'From a thumbs-down response. expectedTopics currently lists what retrieval RETURNED ' +
            '(which the user rejected) — replace with what it SHOULD have returned.'
    });
    seenIds.add(id);
}

// ── Source 2: corpus probes ────────────────────────────────────────────────
const remaining = Math.max(0, COUNT - drafts.length);
if (remaining > 0) {
    const topics = db.prepare(`
        SELECT t.id, t.name, t.description, COUNT(kc.id) AS claim_count
        FROM topics t
        JOIN knowledge_claims kc ON kc.topic_id = t.id AND kc.status = 'active'
        GROUP BY t.id
        HAVING claim_count >= 3
        ORDER BY claim_count DESC
        LIMIT ?
    `).all(remaining * 2) as { id: number; name: string; description: string | null; claim_count: number }[];

    for (const t of topics) {
        if (drafts.length >= COUNT) break;
        const id = `topic-${t.id}`;
        const query = `Co je ${t.name}?`;
        if (seenIds.has(id) || seenQueries.has(query.toLowerCase())) continue;

        const claim = db.prepare(
            "SELECT claim_text FROM knowledge_claims WHERE topic_id = ? AND status = 'active' ORDER BY LENGTH(claim_text) DESC LIMIT 1"
        ).get(t.id) as { claim_text: string } | undefined;

        // A distinctive fragment, not the whole sentence: full-sentence matching
        // breaks the moment the claim is re-extracted with different wording.
        const fragment = claim?.claim_text.split(/\s+/).slice(0, 8).join(' ');

        drafts.push({
            id,
            query,
            expectedTopics: [t.name],
            expectedClaimSubstrings: fragment ? [fragment] : undefined,
            reviewed: false,
            note: `Auto-generated probe (${t.claim_count} active claims). Rewrite as a question a person would ask, and set the topics that should genuinely answer it.`
        });
        seenIds.add(id);
    }
}

if (drafts.length === 0) {
    console.log('No new drafts to add.');
    if (feedback.length === 0) {
        console.log('response_feedback has no negative ratings yet — the highest-value source is empty.');
    }
    process.exit(0);
}

const docCount = (db.prepare('SELECT COUNT(*) AS c FROM documents').get() as { c: number }).c;
const topicCount = (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;

const merged: GoldenSet = {
    version: existing.version ?? 1,
    // Always restamped: it describes the corpus the set was last seeded
    // against, which is exactly what changes when you re-seed.
    corpus: `${docCount} documents, ${topicCount} topics`,
    cases: [...existing.cases, ...drafts]
};

fs.writeFileSync(SET_PATH, JSON.stringify(merged, null, 2) + '\n');

const reviewed = merged.cases.filter((c) => c.reviewed).length;
console.log(`Added ${drafts.length} draft case(s) (${feedback.length} from feedback, ${drafts.length - feedback.length} corpus probes).`);
console.log(`${SET_PATH} now has ${merged.cases.length} case(s): ${reviewed} reviewed, ${merged.cases.length - reviewed} awaiting review.`);
console.log(`\nEdit the drafts, set "reviewed": true, then run \`npm run eval\`.`);
