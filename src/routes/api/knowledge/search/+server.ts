import { json } from '@sveltejs/kit';
import { searchTopics, searchClaims } from '$lib/server/rag';

export async function GET({ url, locals }) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const query = url.searchParams.get('q');
    const type = url.searchParams.get('type') || 'all'; // topics, claims, or all
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 10;

    if (!query) {
        return json({ error: 'Missing query parameter "q"' }, { status: 400 });
    }

    if (!['topics', 'claims', 'all'].includes(type)) {
        return json({ error: 'Invalid type. Must be "topics", "claims", or "all"' }, { status: 400 });
    }

    try {
        let results: { topics?: any[]; claims?: any[] } = {};

        if (type === 'topics' || type === 'all') {
            results.topics = await searchTopics(query, limit);
        }

        if (type === 'claims' || type === 'all') {
            results.claims = await searchClaims(query, null, limit);
        }

        return json(results);
    } catch (error) {
        console.error('Knowledge search error:', error);
        return json({ error: 'Search failed' }, { status: 500 });
    }
}
