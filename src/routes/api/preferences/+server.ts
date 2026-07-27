import { json } from '@sveltejs/kit';
import { setUserPreference } from '$lib/server/db';
import { SIDEBAR_WIDTH_KEY, clampSidebarWidth } from '$lib/prefs';

/**
 * Persists per-user UI preferences.
 *
 * Only known keys are accepted, and each one is validated here rather than
 * trusted from the client — this table is read straight into markup.
 */
export async function POST({ request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await request.json();
        const saved: Record<string, string> = {};

        if (SIDEBAR_WIDTH_KEY in (body ?? {})) {
            const width = clampSidebarWidth(Number(body[SIDEBAR_WIDTH_KEY]));
            setUserPreference(locals.user.id, SIDEBAR_WIDTH_KEY, String(width));
            saved[SIDEBAR_WIDTH_KEY] = String(width);
        }

        if (Object.keys(saved).length === 0) {
            return json({ error: 'No known preference keys in request' }, { status: 400 });
        }

        return json({ saved });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
