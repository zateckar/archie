import { json } from '@sveltejs/kit';
import { buildUsageReport } from '$lib/server/usage';
import type { RequestHandler } from './$types';

/**
 * Token-usage report for the admin dashboard.
 *
 * Admin-only: the operation and model breakdowns describe the internals of the
 * RAG pipeline and its per-task spend, which is not something a regular user
 * should be able to enumerate.
 *
 * Query parameters:
 *   - `span`: '1d' | '7d' | '30d' (default '7d'). Also selects the chart's
 *     bucket resolution — hourly, 6-hourly, daily — so ~24-30 points are
 *     returned whichever span is asked for.
 *   - `tz`: minutes to ADD to UTC to reach the viewer's local time (e.g. 120 for
 *     CEST). Buckets are floored in local time so a "day" is the viewer's day.
 *
 * The whole report — series, window totals, and all-time cumulative figures — is
 * returned in one response, because the page renders all three together and
 * splitting them across requests would let the headline numbers disagree with
 * the chart while one was still loading.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const report = buildUsageReport(url.searchParams.get('span'), url.searchParams.get('tz'));

    return json(report, {
        // Usage accrues continuously; a cached response would show a chart that
        // silently stops updating.
        headers: { 'Cache-Control': 'no-store' }
    });
};
