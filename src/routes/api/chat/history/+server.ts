import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

function safeParseSources(raw: string): any[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Fills in `repo_id` for sources stored before it was recorded, so the chips in
 * an old conversation link to the wiki just like a fresh answer's do.
 *
 * Resolved from `documents` by path (falling back to filename for sources saved
 * without one), in a single query for the whole conversation rather than one per
 * chip. A source whose document has since been deleted, or which never belonged
 * to a repository, simply stays unlinked — that is the honest answer, and the UI
 * renders it as plain text.
 */
function withRepoIds(messages: { sources: any[] }[]): void {
    const keys = new Set<string>();
    for (const m of messages) {
        for (const s of m.sources) {
            if (s && s.repo_id == null) {
                const key = s.path || s.filename;
                if (typeof key === 'string' && key) keys.add(key);
            }
        }
    }
    if (keys.size === 0) return;

    const placeholders = Array.from(keys, () => '?').join(',');
    const rows = db.prepare(`
        SELECT path, filename, repo_id FROM documents
        WHERE repo_id IS NOT NULL AND (path IN (${placeholders}) OR filename IN (${placeholders}))
    `).all(...keys, ...keys) as { path: string | null; filename: string; repo_id: number }[];

    const byKey = new Map<string, { repo_id: number; path: string | null }>();
    for (const r of rows) {
        // Path first: it is what the wiki route needs, and two repos can hold the
        // same filename.
        if (r.path) byKey.set(r.path, { repo_id: r.repo_id, path: r.path });
        if (!byKey.has(r.filename)) byKey.set(r.filename, { repo_id: r.repo_id, path: r.path });
    }

    for (const m of messages) {
        for (const s of m.sources) {
            if (!s || s.repo_id != null) continue;
            const hit = byKey.get(s.path || s.filename);
            if (!hit) continue;
            s.repo_id = hit.repo_id;
            if (!s.path) s.path = hit.path;
        }
    }
}

export async function GET({ url, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) {
        return json({ error: 'Missing conversationId' }, { status: 400 });
    }

    try {
        const rows = db.prepare(`
            SELECT role, content, sources
            FROM chat_history 
            WHERE user_id = ? AND conversation_id = ? 
            ORDER BY created_at ASC
        `).all(locals.user.id, conversationId) as Array<{ role: string; content: string; sources: string | null }>;

        // Parse the stored sources JSON back into an array for each message.
        const history = rows.map((r) => ({
            role: r.role,
            content: r.content,
            sources: r.sources ? safeParseSources(r.sources) : []
        }));
        withRepoIds(history);
        return json(history);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
export async function DELETE({ locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        db.prepare('DELETE FROM chat_history WHERE user_id = ?').run(locals.user.id);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
