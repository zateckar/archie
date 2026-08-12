import { json } from '@sveltejs/kit';
import { syncLeanix, leanixStatus } from '$lib/server/leanix';

/**
 * Admin-only (see `adminRoutes` in hooks.server.ts). Reading the portfolio does
 * not go through here — the /leanix page loads its data server-side from SQLite,
 * so viewing it costs neither a LeanIX request nor an admin role.
 */
export async function GET() {
    return json(leanixStatus());
}

/**
 * Triggers a sync. `force` skips the change probe and re-fetches every factsheet;
 * ingestion is still hash-gated, so forcing a fetch does not force LLM work on
 * factsheets whose content is identical.
 */
export async function POST({ request }) {
    let force = false;
    try {
        const body = await request.json();
        force = Boolean(body?.force);
    } catch {
        // No body is fine — a plain POST means an ordinary sync.
    }

    try {
        const result = await syncLeanix({ force });
        return json(result);
    } catch (err) {
        const reason = (err as Error)?.message ?? String(err);
        console.error('[LeanIX] Manual sync failed:', err);
        return json({ error: `LeanIX sync failed: ${reason}` }, { status: 500 });
    }
}
