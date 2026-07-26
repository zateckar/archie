/**
 * Retrieval evaluation runner.
 *
 *   npm run eval                 # reviewed cases only
 *   npm run eval -- --all        # include unreviewed drafts
 *   npm run eval -- --json out.json
 *   npm run eval -- --case <id>  # run a single case
 *
 * Scores the retrieval layer only — no answer generation. That keeps a run
 * cheap and comparable between commits: the same query against the same corpus
 * should retrieve the same things, so a score that moves is the pipeline
 * changing, not the chat model's mood. Embedding calls still hit the provider.
 *
 * Compare two runs by keeping the JSON output:
 *   npm run eval -- --json before.json    # then make your change
 *   npm run eval -- --json after.json
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GoldenSet, GoldenCase, CaseResult } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SET = path.join(HERE, 'golden-set.json');

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};

const setPath = value('set') ?? DEFAULT_SET;
const includeUnreviewed = flag('all');
const onlyCase = value('case');
const jsonOut = value('json');
/** How many topics to ask for. Precision is measured against this cutoff. */
const TOP_K = Number(value('k') ?? 5);

if (!fs.existsSync(setPath)) {
    console.error(`Golden set not found: ${setPath}\nRun \`npm run eval:seed\` to generate a draft.`);
    process.exit(1);
}

const goldenSet = JSON.parse(fs.readFileSync(setPath, 'utf-8')) as GoldenSet;

let cases = goldenSet.cases;
if (onlyCase) cases = cases.filter((c) => c.id === onlyCase);
else if (!includeUnreviewed) cases = cases.filter((c) => c.reviewed);

const skipped = goldenSet.cases.length - cases.length;

if (cases.length === 0) {
    console.error(
        `No cases to run (${goldenSet.cases.length} in the set, ${skipped} skipped).\n` +
        `Unreviewed drafts are skipped by default — review them and set "reviewed": true, or pass --all.`
    );
    process.exit(1);
}

// Imported after argv handling so `--help`-style misuse doesn't open the DB.
const { searchTopics, buildKnowledgeContext } = await import('../../src/lib/server/rag.ts');

const norm = (s: string) => s.trim().toLowerCase();

async function runCase(c: GoldenCase): Promise<CaseResult> {
    const started = Date.now();
    const base: CaseResult = {
        id: c.id,
        query: c.query,
        topicRecall: 0,
        topicPrecision: 0,
        mrr: 0,
        retrievedTopics: [],
        missingTopics: [...c.expectedTopics],
        claimHits: 0,
        claimTotal: c.expectedClaimSubstrings?.length ?? 0,
        missingClaims: [...(c.expectedClaimSubstrings ?? [])],
        leaked: [],
        contextChars: 0,
        elapsedMs: 0
    };

    try {
        // Layer A — ranked topics. Reranking on, matching what a chat turn does.
        const topics = await searchTopics(c.query, TOP_K, undefined, true);
        const retrieved = topics.map((t) => t.name);
        const retrievedNorm = retrieved.map(norm);
        const expectedNorm = c.expectedTopics.map(norm);

        const found = expectedNorm.filter((e) => retrievedNorm.includes(e));
        base.retrievedTopics = retrieved;
        base.missingTopics = c.expectedTopics.filter((e) => !retrievedNorm.includes(norm(e)));
        base.topicRecall = expectedNorm.length ? found.length / expectedNorm.length : 1;
        base.topicPrecision = retrievedNorm.length ? found.length / retrievedNorm.length : 0;

        const firstHit = retrievedNorm.findIndex((r) => expectedNorm.includes(r));
        base.mrr = firstHit >= 0 ? 1 / (firstHit + 1) : 0;

        // Layer B — the assembled context the chat model actually sees.
        const ctx = await buildKnowledgeContext(c.query);
        const haystack = norm(ctx.text);
        base.contextChars = ctx.text.length;

        base.missingClaims = (c.expectedClaimSubstrings ?? []).filter((s) => !haystack.includes(norm(s)));
        base.claimHits = base.claimTotal - base.missingClaims.length;
        base.leaked = (c.mustNotRetrieve ?? []).filter((s) => haystack.includes(norm(s)));
    } catch (e) {
        base.error = (e as Error).message;
    }

    base.elapsedMs = Date.now() - started;
    return base;
}

console.log(`Running ${cases.length} case(s) from ${path.basename(setPath)}${skipped ? ` (${skipped} skipped)` : ''}, k=${TOP_K}\n`);

const results: CaseResult[] = [];
for (const c of cases) {
    // Sequential on purpose: parallel runs contend on the same embedding
    // provider and make per-case timings meaningless.
    const r = await runCase(c);
    results.push(r);

    const pass = !r.error && r.topicRecall === 1 && r.missingClaims.length === 0 && r.leaked.length === 0;
    const mark = r.error ? 'ERR ' : pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.id}  recall=${r.topicRecall.toFixed(2)} prec=${r.topicPrecision.toFixed(2)} mrr=${r.mrr.toFixed(2)}  ${r.elapsedMs}ms`);
    if (r.error) console.log(`      error: ${r.error}`);
    if (r.missingTopics.length) console.log(`      missing topics: ${r.missingTopics.join(', ')}`);
    if (r.missingClaims.length) console.log(`      missing claims: ${r.missingClaims.map((s) => `"${s}"`).join(', ')}`);
    if (r.leaked.length) console.log(`      LEAKED: ${r.leaked.map((s) => `"${s}"`).join(', ')}`);
}

const ran = results.filter((r) => !r.error);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const passed = results.filter(
    (r) => !r.error && r.topicRecall === 1 && r.missingClaims.length === 0 && r.leaked.length === 0
).length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`cases           ${results.length}  (${passed} pass, ${results.length - passed} fail/error)`);
console.log(`topic recall    ${mean(ran.map((r) => r.topicRecall)).toFixed(3)}`);
console.log(`topic precision ${mean(ran.map((r) => r.topicPrecision)).toFixed(3)}`);
console.log(`MRR             ${mean(ran.map((r) => r.mrr)).toFixed(3)}`);
const claimTotal = ran.reduce((a, r) => a + r.claimTotal, 0);
if (claimTotal > 0) {
    console.log(`claim hit rate  ${(ran.reduce((a, r) => a + r.claimHits, 0) / claimTotal).toFixed(3)}  (${ran.reduce((a, r) => a + r.claimHits, 0)}/${claimTotal})`);
}
const leaks = ran.reduce((a, r) => a + r.leaked.length, 0);
if (leaks > 0) console.log(`LEAKS           ${leaks}`);
console.log(`median latency  ${[...ran.map((r) => r.elapsedMs)].sort((a, b) => a - b)[Math.floor(ran.length / 2)] ?? 0}ms`);

if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ setPath, topK: TOP_K, results }, null, 2));
    console.log(`\nWrote ${jsonOut}`);
}

// Non-zero exit only on hard errors: a low score is information, not a build
// break. Wire a threshold in CI once the set is big enough to mean something.
process.exit(results.some((r) => r.error) ? 1 : 0);
