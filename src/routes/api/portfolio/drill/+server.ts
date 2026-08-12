import { json } from '@sveltejs/kit';
import { drill } from '$lib/server/leanix-drill';

/**
 * Which factsheets are behind one number on the portfolio page.
 *
 * Deliberately NOT under `/api/leanix`: that prefix is admin-only in
 * hooks.server.ts because everything beneath it triggers an operator action that
 * spends budget (a sync, a research run). This is the read side of a page any
 * signed-in user can already open, and every row it returns is data that page
 * has effectively shown them. It still requires a session — the guard in
 * hooks.server.ts is deny-by-default, so a route is authenticated by existing.
 *
 * On demand rather than precomputed with the page: the relation table holds
 * ~5200 edges, and shipping every possible drill would weigh down a page load
 * to answer a question most visitors never ask.
 */
export function GET({ url }) {
    const dimension = url.searchParams.get('dim') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const key2 = url.searchParams.get('key2') ?? '';

    if (!dimension) {
        return json({ error: 'Missing dim parameter' }, { status: 400 });
    }

    try {
        const result = drill(dimension, key, key2);
        // Null means the dimension (or its key) is unknown. Answering 404 rather
        // than an empty list matters: "no factsheets match" and "that is not a
        // question this endpoint answers" would otherwise render identically.
        if (!result) {
            return json({ error: `Unknown drill-down: ${dimension}` }, { status: 404 });
        }
        return json(result);
    } catch (err) {
        console.error('[Portfolio] Drill-down failed:', err);
        return json({ error: 'Drill-down failed' }, { status: 500 });
    }
}
