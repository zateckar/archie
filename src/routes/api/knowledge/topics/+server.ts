import { json } from '@sveltejs/kit';
import { listTopics, listCategories, topicTree } from '$lib/server/knowledge-queries';
import type { RequestHandler } from './$types';

/**
 * Paged topic list.
 *
 * Replaces the topic half of `GET /api/knowledge`, which returned every topic in
 * the corpus with its full description so the browser could filter and count
 * client-side. See lib/server/knowledge-queries.ts for what that cost.
 *
 * Query params: `page`, `pageSize` (default 20, max 200), `search`, `category`,
 * `sort` (connections | claims | name | recent).
 *
 * `view=tree` returns slim rows for ALL topics — the admin hierarchy view needs
 * every parent/child link to build its tree, and without descriptions or
 * embeddings that is ~60 bytes per topic.
 *
 * Authentication is enforced for the whole `/api` surface in hooks.server.ts.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
    if (url.searchParams.get('view') === 'tree') {
        return json({ topics: topicTree(), categories: listCategories() });
    }

    // Non-active claims are only counted for admins, matching the claim list:
    // a claim count that includes flagged/conflicting rows would not agree with
    // the claims the explorer will actually show a regular user.
    const includeInactiveClaims =
        url.searchParams.get('includeInactiveClaims') === '1' && locals.user?.role === 'admin';

    const result = listTopics({
        search: url.searchParams.get('search'),
        category: url.searchParams.get('category'),
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
        sort: url.searchParams.get('sort'),
        includeInactiveClaims
    });

    return json({
        topics: result.items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
        categories: listCategories()
    });
};
