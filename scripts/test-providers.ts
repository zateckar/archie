/**
 * Live integration test for the provider layer (src/lib/server/providers.ts).
 *
 * Exercises each primitive (text generation, JSON generation, chat streaming,
 * embeddings, native rerank) against the CONFIGURED provider — the LiteLLM
 * gateway when LLM_* is set, otherwise Gemini. Verifies the LiteLLM primary
 * path is fully functional and behaves the same as the Gemini path used to.
 *
 * Run: npx tsx scripts/test-providers.ts
 */
import 'dotenv/config';
import * as providers from '../src/lib/server/providers';

const GEMINI_FALLBACK = { model: process.env.TEXT_MODEL || 'gemini-3-flash-preview' };
const EMBED_FALLBACK = { model: process.env.EMBEDDING_MODEL || 'gemini-embedding-2' };

let passed = 0;
let failed = 0;

function ok(name: string, detail = '') {
    passed++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function bad(name: string, err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ${name} — ${msg}`);
}

function header(t: string) {
    console.log(`\n=== ${t} ===`);
}

async function main() {
    console.log('Provider configuration:');
    console.log(`  litellmConfigured = ${providers.litellmConfigured}`);
    console.log(`  LLM_BASE_URL      = ${process.env.LLM_BASE_URL || '(unset)'}`);
    console.log(`  LLM_TEXT_MODEL    = ${process.env.LLM_TEXT_MODEL || '(unset)'}`);
    console.log(`  LLM_EMBEDDING_MODEL = ${process.env.LLM_EMBEDDING_MODEL || '(unset)'}`);
    console.log(`  LLM_RERANK_MODEL  = ${process.env.LLM_RERANK_MODEL || '(unset)'}`);
    console.log(`  LLM_RERANK_ENABLED = ${process.env.LLM_RERANK_ENABLED || '(unset)'}`);

    // ── 1. Plain text generation ────────────────────────────────────────────
    header('1. generateContent (plain text)');
    try {
        const r = await providers.generateContent(
            'Reply with exactly the single word: PONG',
            GEMINI_FALLBACK,
            { temperature: 0 }
        );
        const text = r.response.text();
        if (text && text.trim().length > 0) ok('text generation', JSON.stringify(text.slice(0, 60)));
        else bad('text generation', 'empty response');
    } catch (e) {
        bad('text generation', e);
    }

    // ── 2. JSON-mode generation (the taxonomy/extraction path) ───────────────
    header('2. generateContent (JSON mode, response_format=json_object)');
    try {
        const r = await providers.generateContent(
            'Return ONLY a JSON object with an "items" array of the numbers 1, 2, 3: {"items":[1,2,3]}',
            GEMINI_FALLBACK,
            { temperature: 0.1, responseMimeType: 'application/json' }
        );
        const text = r.response.text();
        const parsed = JSON.parse(
            text.replace(/```json\n?/, '').replace(/\n?```/, '').trim()
        );
        ok('JSON generation', `parsed keys: ${Object.keys(parsed).join(',')}`);
        // Note whether gateway wrapped the array (informs parseJSON behaviour)
        const isBareArray = Array.isArray(parsed);
        console.log(`     → response is ${isBareArray ? 'a BARE ARRAY' : 'an OBJECT'} (JSON-mode gateways wrap arrays in objects)`);
    } catch (e) {
        bad('JSON generation', e);
    }

    // ── 3. Chat streaming ────────────────────────────────────────────────────
    header('3. startChatStream (streaming + history + system instruction)');
    try {
        const stream = await providers.startChatStream(
            'Count from 1 to 5 separated by spaces.',
            'You are a terse assistant. Answer with digits only.',
            [
                { role: 'user', content: 'Hi' },
                { role: 'model', content: 'Hello.' }
            ],
            GEMINI_FALLBACK,
            { temperature: 0 }
        );
        let full = '';
        let chunks = 0;
        for await (const chunk of stream) {
            full += chunk.text();
            chunks++;
        }
        if (full.trim().length > 0) ok('chat streaming', `${chunks} chunk(s), text: ${JSON.stringify(full.slice(0, 60))}`);
        else bad('chat streaming', 'no streamed text');
    } catch (e) {
        bad('chat streaming', e);
    }

    // ── 4. Embeddings (document + query task types) ──────────────────────────
    header('4. embedContent (document & query)');
    let docDim = 0;
    try {
        const r = await providers.embedContent(
            'Skoda vehicle diagnostics over CAN bus.',
            EMBED_FALLBACK,
            'RETRIEVAL_DOCUMENT',
            'Diagnostics'
        );
        const v = r.embedding.values;
        docDim = v.length;
        if (Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
            ok('document embedding', `dim=${v.length}`);
        } else {
            bad('document embedding', 'invalid vector');
        }
    } catch (e) {
        bad('document embedding', e);
    }
    try {
        const r = await providers.embedContent(
            'How do I read diagnostic codes?',
            EMBED_FALLBACK,
            'RETRIEVAL_QUERY'
        );
        const v = r.embedding.values;
        if (Array.isArray(v) && v.length > 0) {
            const dimMatch = docDim === 0 || v.length === docDim;
            if (dimMatch) ok('query embedding', `dim=${v.length} (matches document dim)`);
            else bad('query embedding', `dim=${v.length} != document dim=${docDim} — vector search would break!`);
        } else {
            bad('query embedding', 'invalid vector');
        }
    } catch (e) {
        bad('query embedding', e);
    }

    // ── 4b. Embedding semantic sanity (related > unrelated) ──────────────────
    header('4b. embedding semantic sanity (cosine similarity ordering)');
    try {
        const [a, b, c] = await Promise.all([
            providers.embedContent('The car engine would not start this morning.', EMBED_FALLBACK, 'RETRIEVAL_DOCUMENT'),
            providers.embedContent('My vehicle failed to turn over at dawn.', EMBED_FALLBACK, 'RETRIEVAL_DOCUMENT'),
            providers.embedContent('The recipe calls for two cups of flour.', EMBED_FALLBACK, 'RETRIEVAL_DOCUMENT')
        ]);
        const cos = (x: number[], y: number[]) => {
            let dot = 0, nx = 0, ny = 0;
            for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
            return dot / (Math.sqrt(nx) * Math.sqrt(ny) || 1);
        };
        const simRelated = cos(a.embedding.values, b.embedding.values);
        const simUnrelated = cos(a.embedding.values, c.embedding.values);
        if (simRelated > simUnrelated) ok('embedding semantics', `related=${simRelated.toFixed(3)} > unrelated=${simUnrelated.toFixed(3)}`);
        else bad('embedding semantics', `related=${simRelated.toFixed(3)} !> unrelated=${simUnrelated.toFixed(3)} — embeddings look wrong`);
    } catch (e) {
        bad('embedding semantics', e);
    }

    // ── 5. Native rerank (opt-in) ────────────────────────────────────────────
    header('5. rerankDocuments (native /rerank, opt-in)');
    try {
        const query = 'How to reset the engine control unit?';
        const docs = [
            'A recipe for chocolate chip cookies.',
            'Steps to reset the engine control unit (ECU) after a battery change.',
            'The history of the Roman Empire.'
        ];
        const ranked = await providers.rerankDocuments(query, docs);
        if (ranked === null) {
            ok('native rerank', 'returned null (disabled or unconfigured — falls back to LLM reranker, expected)');
        } else if (Array.isArray(ranked) && ranked.length > 0) {
            const top = ranked[0];
            if (top === 1) ok('native rerank', `order=[${ranked.join(',')}], top doc is the relevant one`);
            else bad('native rerank', `order=[${ranked.join(',')}], top=${top} is NOT the relevant doc (index 1) — reranker ordering is wrong`);
        } else {
            bad('native rerank', 'empty/invalid result');
        }
    } catch (e) {
        bad('native rerank', e);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    header('SUMMARY');
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
    console.error('Test harness crashed:', e);
    process.exitCode = 1;
});
