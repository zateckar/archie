/**
 * Re-embed the entire corpus with the currently-configured embedding provider.
 *
 * Run this once after switching the embedding model to one with a different
 * vector dimension (e.g. Gemini 3072-dim → LiteLLM 4096-dim). Query and stored
 * vectors must share a model/dimension, so all previously stored embeddings are
 * stale until rebuilt — until then, vector search silently returns nothing.
 *
 * Usage (from the project root):
 *   npx tsx scripts/reembed.ts
 *   # or, if added to package.json scripts:
 *   npm run reembed
 *
 * Reads the same .env the app uses (DATABASE_PATH, GEMINI_*, LLM_*). Runs in a
 * fresh process so the sqlite-vector index isn't already pinned to the old
 * dimension.
 */
import 'dotenv/config';
import { reembedAll } from '../src/lib/server/rag';

async function main() {
    const start = Date.now();
    const result = await reembedAll();
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
        `\n✅ Re-embedding complete in ${secs}s: ` +
        `${result.chunks} chunks, ${result.topics} topics, ${result.claims} claims ` +
        `at dimension ${result.dimension}.`
    );
    process.exit(0);
}

main().catch((err) => {
    console.error('\n❌ Re-embedding failed:', err);
    process.exit(1);
});
