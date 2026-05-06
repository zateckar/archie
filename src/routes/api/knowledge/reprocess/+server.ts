import { json } from '@sveltejs/kit';
import { reprocessKnowledge } from '$lib/server/rag';

/**
 * Admin endpoint that re-runs the knowledge-extraction pipeline against
 * documents already in the DB. Useful after fixing bugs in the extractor
 * without having to re-sync from git or re-embed every chunk.
 *
 * Body (all optional):
 *   { docId?: number, wipeAll?: boolean, rechunk?: boolean }
 *
 * Examples:
 *   POST {}                              -> reprocess every document, keep existing topics/claims, append
 *   POST { "wipeAll": true }             -> wipe knowledge tables and reprocess every document
 *   POST { "docId": 32, "rechunk": true }-> re-chunk + re-embed + reprocess one document
 */
export async function POST({ request, locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: { docId?: number; wipeAll?: boolean; rechunk?: boolean } = {};
    try {
        body = await request.json();
    } catch {
        body = {};
    }

    try {
        const result = await reprocessKnowledge(body);
        return json({ ok: true, ...result });
    } catch (err: any) {
        console.error('reprocessKnowledge failed:', err);
        return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
    }
}
