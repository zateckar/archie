import { json } from '@sveltejs/kit';
import {
    getGraphStats,
    getAllCommunities,
    getNoiseTopics,
    recomputeCommunities,
    getCommunityReports
} from '$lib/server/communities';

/** GET: return graph diagnostics, all communities, and their reports */
export async function GET({ locals }: any) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const stats = getGraphStats();
    const communities = getAllCommunities();
    const noise = getNoiseTopics();
    // Reports are what the thematic retrieval path actually matches against, so
    // they need to be inspectable: a bad or stale summary shows up in chat
    // context, and there is otherwise no way to see what got generated.
    const reports = getCommunityReports();

    return json({
        stats,
        communities,
        noise,
        reports,
        total_topics: stats.nodeCount,
        total_communities: communities.length,
        noise_count: noise.length,
        reports_count: reports.length,
    });
}

/** POST: trigger community recomputation */
export async function POST({ locals }: any) {
    const user = locals.user;
    if (!user || user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await recomputeCommunities();
        return json({ success: true, ...result });
    } catch (err) {
        console.error('Community recompute failed:', err);
        return json({ error: 'Community recompute failed' }, { status: 500 });
    }
}
