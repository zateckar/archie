import { json } from '@sveltejs/kit';
import { listClaims } from '$lib/server/knowledge-queries';
import type { RequestHandler } from './$types';

/**
 * Paged claim list.
 *
 * Query params: `page`, `pageSize` (default 20, max 200), `search`, `topicId`,
 * `topicName`, `category`, `status`, `sort` (recent | topic | retired).
 *
 * `status` defaults to `active`. Superseded claims are retired history — showing
 * one as current is a correctness problem, not a cosmetic one — so any status
 * other than `active` requires an admin, and a non-admin asking for one gets the
 * active list rather than a silent empty page.
 */
const ADMIN_ONLY_STATUSES = new Set(['superseded', 'flagged', 'conflicting', 'all']);

export const GET: RequestHandler = async ({ url, locals }) => {
    const requested = (url.searchParams.get('status') ?? 'active').toLowerCase();
    const isAdmin = locals.user?.role === 'admin';
    const status = ADMIN_ONLY_STATUSES.has(requested) && !isAdmin ? 'active' : requested;

    const result = listClaims({
        search: url.searchParams.get('search'),
        topicId: url.searchParams.get('topicId'),
        topicName: url.searchParams.get('topicName'),
        category: url.searchParams.get('category'),
        status,
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
        sort: url.searchParams.get('sort')
    });

    return json({
        claims: result.items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
        status
    });
};
