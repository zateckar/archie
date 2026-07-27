import { redirect } from '@sveltejs/kit';
import { db, getUserPreference } from '$lib/server/db';
import { SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from '$lib/prefs';

export const load = async ({ locals }) => {
    if (!locals.user) {
        throw redirect(302, '/login');
    }

    const conversations = db.prepare(`
        SELECT id, title, pinned, created_at, updated_at
        FROM conversations
        WHERE user_id = ?
        ORDER BY pinned DESC, updated_at DESC
    `).all(locals.user.id);

    // Resolved server-side so the panel renders at its saved width on the first
    // paint instead of snapping from the default once the client hydrates.
    const savedWidth = getUserPreference(locals.user.id, SIDEBAR_WIDTH_KEY);
    const sidebarWidth = savedWidth === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(savedWidth));

    return {
        conversations,
        sidebarWidth
    };
};
