import { json } from '@sveltejs/kit';
import { buildKnowledgeGraph } from '$lib/server/knowledge-graph';
import type { RequestHandler } from './$types';

/**
 * Connected subgraph for the graph visualization.
 *
 * Query params: `search`, `category`, `minClaims`, `maxNodes` (default 150, max
 * 600), `focusTopicId`, `depth` (1–3 hops around the focus).
 *
 * Every node in the response is guaranteed to have at least one edge in the same
 * response — see lib/server/knowledge-graph.ts for why the old client-side
 * selection could not make that promise.
 */
export const GET: RequestHandler = async ({ url }) => {
    return json(
        buildKnowledgeGraph({
            search: url.searchParams.get('search'),
            category: url.searchParams.get('category'),
            minClaims: url.searchParams.get('minClaims'),
            maxNodes: url.searchParams.get('maxNodes'),
            focusTopicId: url.searchParams.get('focusTopicId'),
            depth: url.searchParams.get('depth')
        })
    );
};
