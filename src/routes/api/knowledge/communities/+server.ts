import { json } from '@sveltejs/kit';
import { getGraphStats, getAllCommunities, getNoiseTopics, recomputeCommunities } from '$lib/server/communities';

/** GET: return graph diagnostics and all communities */
export async function GET({ locals }: any) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const stats = getGraphStats();
    const communities = getAllCommunities();
    const noise = getNoiseTopics();

    return json({
        stats,
        communities,
        noise,
        total_topics: stats.nodeCount,
        total_communities: communities.length,
        noise_count: noise.length,
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
