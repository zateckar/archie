import { json } from '@sveltejs/kit';
import { searchSourceDocuments } from '$lib/server/db';

/**
 * Full-text search source documents for a snippet of text (typically the user's
 * selection from a chat answer), scoped to the documents actually used in that
 * answer. Returns the matching documents, most relevant first, each with a
 * highlighted snippet and the identifiers needed to deep-link into the editable
 * wiki.
 *
 * POST /api/search-sources
 * body: { q: string, sources: string[], limit?: number }
 *   - q:       the selected text
 *   - sources: path/filename identifiers of the documents used in the answer
 *              (from the streamed `sources` event). The search is restricted to
 *              these. If omitted/empty, no results are returned.
 */
export async function POST({ request, locals }) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: { q?: string; sources?: string[]; limit?: number };
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const query = (body.q ?? '').trim();
    if (!query) {
        return json({ error: 'Missing "q"' }, { status: 400 });
    }

    const limit = body.limit
        ? Math.min(Math.max(Number(body.limit) || 20, 1), 50)
        : 20;

    // Scope strictly to the answer's sources. An empty list => no results.
    const sources = Array.isArray(body.sources) ? body.sources : [];

    try {
        const results = searchSourceDocuments(query, limit, sources);
        return json({ query, results });
    } catch (error) {
        console.error('search-sources error:', error);
        return json({ error: 'Search failed' }, { status: 500 });
    }
}
