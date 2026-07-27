import { json } from '@sveltejs/kit';
import { taxonomyScheduleStatus, setFullRebuildIntervalMs } from '$lib/server/knowledge';
import { validateFullRebuildInterval } from '$lib/server/taxonomy-schedule';
import type { RequestHandler } from './$types';

/**
 * The automatic taxonomy rebuild schedule: read it, and change how often it runs.
 *
 * A separate route rather than another action on /api/knowledge because this one
 * needs a GET, and that file deliberately has none (see the comment there — its
 * GET used to return the entire graph and was removed on purpose).
 *
 * Admin-only on both verbs. The interval is the app's largest single lever on
 * token spend, so reading it is as much an admin concern as setting it.
 */
export const GET: RequestHandler = async ({ locals }) => {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }
    return json(taxonomyScheduleStatus());
};

/**
 * PUT { intervalMs: number } — 0 disables automatic rebuilds, otherwise at least
 * one hour (see MIN_FULL_REBUILD_INTERVAL_MS for why there is a floor).
 *
 * Returns the resulting status rather than just an ack, so the client renders what
 * the server actually stored instead of what it hoped it stored — the two differ
 * whenever validation rounds a value.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
        return json({ error: 'Expected a JSON body with an intervalMs field' }, { status: 400 });
    }

    const validated = validateFullRebuildInterval((body as { intervalMs?: unknown }).intervalMs);
    if (!validated.ok) {
        return json({ error: validated.error }, { status: 400 });
    }

    try {
        setFullRebuildIntervalMs(validated.intervalMs);
    } catch (err) {
        console.error('[Taxonomy] Failed to persist rebuild interval:', err);
        return json({ error: 'Failed to save the interval' }, { status: 500 });
    }

    return json(taxonomyScheduleStatus());
};
