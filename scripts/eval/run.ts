/**
 * Retrieval (and optionally answer) evaluation runner.
 *
 *   npm run eval                 # reviewed cases only
 *   npm run eval -- --all        # include unreviewed drafts
 *   npm run eval -- --json out.json
 *   npm run eval -- --case <id>  # run a single case
 *   npm run eval -- --area application-integration
 *   npm run eval -- --raw        # skip query analysis (pre-2026-10 behaviour)
 *   npm run eval -- --answers    # also generate and judge answers
 *
 * By default retrieval is scored the way a chat turn runs it: the query goes
 * through `analyzeAndCondenseQuery` first and its keyword sets drive
 * `buildKnowledgeContext`. Without that, the harness measured a code path no
 * user ever hits. Verbatim chunks are scored too (`expectedSources`).
 *
 * `--answers` builds the full answer context (`buildAnswerContext`), generates
 * the answer, and has an LLM judge check it against the case's expert-written
 * `expectedFacts` and against the context (unsupported statements). It is the
 * only mode that measures whether answers are right, and the only way to choose
 * CHAT_SYNTHESIS / CHAT_VERBATIM_CHUNKS on evidence. Costly: several model calls
 * per case. Nothing is written to conversations.
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
const area = value('area');
const raw = flag('raw');
const withAnswers = flag('answers');
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
if (area) cases = cases.filter((c) => c.area === area);

const skipped = goldenSet.cases.length - cases.length;

if (cases.length === 0) {
    console.error(
        `No cases to run (${goldenSet.cases.length} in the set, ${skipped} skipped).\n` +
        `Unreviewed drafts are skipped by default — review them and set "reviewed": true, or pass --all.`
    );
    process.exit(1);
}

// Imported after argv handling so `--help`-style misuse doesn't open the DB.
const { searchTopics, buildKnowledgeContext, searchChunks } = await import('../../src/lib/server/rag.ts');
const { analyzeAndCondenseQuery, chat } = await import('../../src/lib/server/llm.ts');
const { buildAnswerContext } = await import('../../src/lib/server/chat-pipeline.ts');
const { judgeAnswer } = await import('./judge.ts');
const { db } = await import('../../src/lib/server/db.ts');

const norm = (s: string) => s.trim().toLowerCase();

// Topic names drift whenever the graph is re-extracted. A case expecting a
// topic that no longer exists can only fail, and it fails as "retrieval
// missed it", which is the wrong conclusion — so say so before running.
{
    const exists = db.prepare(`
        SELECT 1 FROM topics WHERE name = ? COLLATE NOCASE
        UNION SELECT 1 FROM topic_aliases WHERE alias = ? COLLATE NOCASE
        LIMIT 1
    `);
    for (const c of cases) {
        const stale = c.expectedTopics.filter((t) => !exists.get(t, t));
        if (stale.length) console.warn(`STALE ${c.id}: no topic named ${stale.map((s) => `"${s}"`).join(', ')} in this database`);
    }
}

/** Same verbatim-chunk count as the chat pipeline's primary pass. */
const VERBATIM_CHUNKS = (() => {
    const n = Number(process.env.CHAT_VERBATIM_CHUNKS);
    return Number.isInteger(n) && n > 0 && n <= 20 ? n : 3;
})();

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
        sourceRecall: 1,
        missingSources: [...(c.expectedSources ?? [])],
        elapsedMs: 0
    };

    try {
        // Query analysis, as a chat turn does it (unless --raw).
        let searchQuery = c.query;
        let keywords: { highLevel?: string[]; lowLevel?: string[] } | undefined;
        if (!raw) {
            const analysis = await analyzeAndCondenseQuery(c.query, []);
            searchQuery = analysis.searchableQuery;
            keywords = { highLevel: analysis.highLevelKeywords, lowLevel: analysis.lowLevelKeywords };
        }

        // Layer A — ranked topics. Reranking on, matching what a chat turn does.
        const topics = await searchTopics(searchQuery, TOP_K, undefined, true);
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
        const [ctx, chunks] = await Promise.all([
            buildKnowledgeContext(searchQuery, 5, 15, keywords),
            searchChunks(searchQuery, VERBATIM_CHUNKS)
        ]);
        const haystack = norm(ctx.text + '\n' + chunks.map((ch) => ch.content).join('\n'));
        base.contextChars = ctx.text.length;

        base.missingClaims = (c.expectedClaimSubstrings ?? []).filter((s) => !haystack.includes(norm(s)));
        base.claimHits = base.claimTotal - base.missingClaims.length;
        base.leaked = (c.mustNotRetrieve ?? []).filter((s) => haystack.includes(norm(s)));

        // Layer C — verbatim sources.
        const chunkLabels = chunks.map((ch) => norm(ch.path || ch.filename));
        const expectedSources = c.expectedSources ?? [];
        base.missingSources = expectedSources.filter((s) => !chunkLabels.some((l) => l.includes(norm(s))));
        base.sourceRecall = expectedSources.length
            ? (expectedSources.length - base.missingSources.length) / expectedSources.length
            : 1;

        // Layer D — the answer itself.
        if (withAnswers) {
            const { answerContext } = await buildAnswerContext(searchQuery, keywords, []);
            const text = await chat(c.query, answerContext, []);
            const judged = await judgeAnswer(c.query, text, answerContext, c.expectedFacts ?? []);
            base.answer = { text, ...judged };
        }
    } catch (e) {
        base.error = (e as Error).message;
    }

    base.elapsedMs = Date.now() - started;
    return base;
}

console.log(
    `Running ${cases.length} case(s) from ${path.basename(setPath)}${skipped ? ` (${skipped} skipped)` : ''}, k=${TOP_K}` +
    `${raw ? ', raw query' : ', chat-like query analysis'}${withAnswers ? `, answers (synthesis=${process.env.CHAT_SYNTHESIS || 'off'})` : ''}\n`
);

const isPass = (r: CaseResult) =>
    !r.error && r.topicRecall === 1 && r.missingClaims.length === 0 && r.leaked.length === 0 &&
    r.missingSources.length === 0 &&
    (!r.answer || (r.answer.missingFacts.length === 0 && r.answer.unsupported.length === 0 && !r.answer.offTopic));

const results: CaseResult[] = [];
for (const c of cases) {
    // Sequential on purpose: parallel runs contend on the same embedding
    // provider and make per-case timings meaningless.
    const r = await runCase(c);
    results.push(r);

    const mark = r.error ? 'ERR ' : isPass(r) ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.id}  recall=${r.topicRecall.toFixed(2)} prec=${r.topicPrecision.toFixed(2)} mrr=${r.mrr.toFixed(2)} src=${r.sourceRecall.toFixed(2)}  ${r.elapsedMs}ms`);
    if (r.error) console.log(`      error: ${r.error}`);
    if (r.missingTopics.length) console.log(`      missing topics: ${r.missingTopics.join(', ')}`);
    if (r.missingClaims.length) console.log(`      missing claims: ${r.missingClaims.map((s) => `"${s}"`).join(', ')}`);
    if (r.missingSources.length) console.log(`      missing sources: ${r.missingSources.join(', ')}`);
    if (r.leaked.length) console.log(`      LEAKED: ${r.leaked.map((s) => `"${s}"`).join(', ')}`);
    if (r.answer) {
        console.log(`      answer: facts ${r.answer.factHits}/${r.answer.factTotal}, unsupported ${r.answer.unsupported.length}, cited ${(100 * r.answer.citedRatio).toFixed(0)}%`);
        for (const f of r.answer.missingFacts) console.log(`        missing fact: ${f}`);
        for (const u of r.answer.unsupported) console.log(`        UNSUPPORTED: ${u}`);
        if (r.answer.offTopic) console.log(`        OFF-TOPIC: ${r.answer.offTopic}`);
    }
}

const ran = results.filter((r) => !r.error);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const passed = results.filter(isPass).length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`cases           ${results.length}  (${passed} pass, ${results.length - passed} fail/error)`);
// Topic metrics only over cases that name topics: a case with no expectations
// would score recall 1 and precision/MRR 0, which says nothing either way.
const withTopics = ran.filter((r) => (cases.find((c) => c.id === r.id)?.expectedTopics.length ?? 0) > 0);
if (withTopics.length > 0) {
    console.log(`topic recall    ${mean(withTopics.map((r) => r.topicRecall)).toFixed(3)}  (${withTopics.length} case(s))`);
    console.log(`topic precision ${mean(withTopics.map((r) => r.topicPrecision)).toFixed(3)}`);
    console.log(`MRR             ${mean(withTopics.map((r) => r.mrr)).toFixed(3)}`);
}
const claimTotal = ran.reduce((a, r) => a + r.claimTotal, 0);
if (claimTotal > 0) {
    console.log(`claim hit rate  ${(ran.reduce((a, r) => a + r.claimHits, 0) / claimTotal).toFixed(3)}  (${ran.reduce((a, r) => a + r.claimHits, 0)}/${claimTotal})`);
}
const withSources = ran.filter((r) => (cases.find((c) => c.id === r.id)?.expectedSources?.length ?? 0) > 0);
if (withSources.length > 0) {
    console.log(`source recall   ${mean(withSources.map((r) => r.sourceRecall)).toFixed(3)}  (${withSources.length} case(s))`);
}
const answered = ran.filter((r) => r.answer);
if (answered.length > 0) {
    const factTotal = answered.reduce((a, r) => a + r.answer!.factTotal, 0);
    const factHits = answered.reduce((a, r) => a + r.answer!.factHits, 0);
    if (factTotal > 0) console.log(`answer facts    ${(factHits / factTotal).toFixed(3)}  (${factHits}/${factTotal})`);
    console.log(`unsupported     ${answered.reduce((a, r) => a + r.answer!.unsupported.length, 0)} statement(s) in ${answered.length} answer(s)`);
    console.log(`cited           ${mean(answered.map((r) => r.answer!.citedRatio)).toFixed(3)}`);
    console.log(`off-topic       ${answered.filter((r) => r.answer!.offTopic).length} answer(s)`);
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
