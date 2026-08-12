import { json } from '@sveltejs/kit';
import { runMarketResearch, marketResearchStatus } from '$lib/server/market-research';

/**
 * Admin-only — it inherits the `/api/leanix` guard in hooks.server.ts, which
 * matches on path segments and so covers everything beneath it.
 *
 * The gate matters more here than for the sync next door: this endpoint spends
 * money per factsheet, once on a billed web search and again on tokens. Reading
 * the results costs nothing and needs no role — the /leanix page loads them
 * server-side from SQLite.
 */
export async function GET() {
    return json(marketResearchStatus());
}

/**
 * Triggers a research run.
 *
 * `force` ignores the TTL and re-researches everything due-or-not; `limit`
 * overrides the per-run batch cap. Both are deliberately exposed: the first is
 * how you refresh after news breaks, and the second is how you try the feature
 * on three factsheets before committing to seventy-eight.
 */
export async function POST({ request }) {
    let force = false;
    let limit: number | undefined;
    try {
        const body = await request.json();
        force = Boolean(body?.force);
        const raw = Number(body?.limit);
        if (Number.isFinite(raw) && raw > 0) limit = Math.floor(raw);
    } catch {
        // No body is fine — a plain POST means an ordinary run.
    }

    try {
        const result = await runMarketResearch({ force, limit });
        return json(result);
    } catch (err) {
        const reason = (err as Error)?.message ?? String(err);
        console.error('[Market] Manual run failed:', err);
        return json({ error: `Market research failed: ${reason}` }, { status: 500 });
    }
}
