import { json } from '@sveltejs/kit';
import { getRelatedTopics } from '$lib/server/rag';

export async function GET({ params, url, locals }) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const topicId = parseInt(params.id, 10);
    if (isNaN(topicId)) {
        return json({ error: 'Invalid topic ID' }, { status: 400 });
    }

    const depthParam = url.searchParams.get('depth');
    const depth = depthParam ? parseInt(depthParam, 10) : 2;

    if (depth < 1 || depth > 3) {
        return json({ error: 'Invalid depth. Must be between 1 and 3' }, { status: 400 });
    }

    try {
        const relatedTopics = getRelatedTopics(topicId, depth);

        return json({
            topic_id: topicId,
            depth,
            related: relatedTopics
        });
    } catch (error) {
        console.error('Related topics fetch error:', error);
        return json({ error: 'Failed to fetch related topics' }, { status: 500 });
    }
}
