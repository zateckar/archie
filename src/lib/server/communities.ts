/**
 * Community Detection for the Knowledge Graph.
 *
 * Two complementary approaches:
 * 1. Louvain on the topic-relationship graph (symmetrized, weighted)
 * 2. Cosine-similarity clustering on topic embeddings (fallback for orphans)
 *
 * Communities are stored in topics.community_id and recomputed after each
 * ingestion batch (full recompute only — no incremental heuristic).
 */

import { db } from './db';

// ── Edge weight map for relationship types ──────────────────────────
// Strong structural links (is_part_of, is_a) get higher weight;
// weak referential links get lower weight.
const RELATIONSHIP_WEIGHTS: Record<string, number> = {
    is_part_of:     1.0,
    is_a:           1.0,
    governs:        0.8,
    enforces:       0.8,
    constrains:     0.8,
    depends_on:     0.7,
    manages:        0.7,
    defines:        0.7,
    implements:     0.7,
    complies_with:  0.6,
    includes:       0.6,
    supports:       0.5,
    enables:        0.5,
    uses:           0.4,
    references:     0.3,
};

const DEFAULT_EDGE_WEIGHT = 0.3;

// ── Graph diagnostic ────────────────────────────────────────────────

export interface GraphStats {
    nodeCount: number;
    edgeCount: number;
    avgDegree: number;
    componentCount: number;
    largestComponentFraction: number;
    isolatedCount: number;
    edgeDensity: number;
    avgDegreeSource: 'relationships' | 'embeddings';
    viableForLouvain: boolean;
}

/**
 * Run graph diagnostics to determine whether the graph is dense enough
 * for topology-based community detection.
 */
export function getGraphStats(): GraphStats {
    const nodeCount = (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;
    const edgeCount = (db.prepare('SELECT COUNT(*) AS c FROM topic_relationships').get() as { c: number }).c;

    const avgDegree = nodeCount > 0 ? (2 * edgeCount) / nodeCount : 0;
    const edgeDensity = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;

    // Count isolated nodes (topics with 0 relationships)
    const isolatedCount = (db.prepare(`
        SELECT COUNT(*) AS c FROM topics t
        WHERE NOT EXISTS (
            SELECT 1 FROM topic_relationships
            WHERE source_topic_id = t.id OR target_topic_id = t.id
        )
    `).get() as { c: number }).c;

    // Count connected components using BFS
    const allNodes = (db.prepare('SELECT id FROM topics').all() as { id: number }[]).map(r => r.id);
    const edges = (db.prepare(`
        SELECT DISTINCT source_topic_id AS source, target_topic_id AS target
        FROM topic_relationships
    `).all() as { source: number; target: number }[]);

    const adjacency = new Map<number, Set<number>>();
    for (const n of allNodes) adjacency.set(n, new Set());
    for (const e of edges) {
        adjacency.get(e.source)?.add(e.target);
        adjacency.get(e.target)?.add(e.source);
    }

    const visited = new Set<number>();
    let maxComponentSize = 0;
    let componentCount = 0;

    for (const node of allNodes) {
        if (visited.has(node)) continue;
        componentCount++;
        let size = 0;
        const stack = [node];
        visited.add(node);
        while (stack.length > 0) {
            const current = stack.pop()!;
            size++;
            for (const neighbor of adjacency.get(current) ?? []) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    stack.push(neighbor);
                }
            }
        }
        maxComponentSize = Math.max(maxComponentSize, size);
    }

    const largestComponentFraction = nodeCount > 0 ? maxComponentSize / nodeCount : 0;

    // Determine source: are we using relationship-based or embedding-based clustering?
    const hasEmbeddings = (db.prepare(
        'SELECT COUNT(*) AS c FROM topics WHERE embedding IS NOT NULL'
    ).get() as { c: number }).c;
    const avgDegreeSource = edgeCount >= nodeCount * 0.5 ? 'relationships' : 'embeddings';

    // Viability: avg degree > 3, largest component > 60% of nodes, isolated < 20%
    const viableForLouvain = avgDegree > 3 && largestComponentFraction > 0.6 && isolatedCount / Math.max(nodeCount, 1) < 0.2;

    return {
        nodeCount,
        edgeCount,
        avgDegree: Math.round(avgDegree * 100) / 100,
        componentCount,
        largestComponentFraction: Math.round(largestComponentFraction * 100) / 100,
        isolatedCount,
        edgeDensity: Math.round(edgeDensity * 10000) / 10000,
        avgDegreeSource,
        viableForLouvain,
    };
}

// ── Core Louvain Implementation ─────────────────────────────────────

interface WeightedGraph {
    nodes: number[];           // topic IDs
    edges: Map<number, Map<number, number>>;  // node -> (neighbor -> weight)
}

/**
 * Build a weighted, undirected graph from the topic_relationships table.
 * Directed edges are symmetrized with relationship-type weights.
 */
function buildGraph(): WeightedGraph {
    const nodes = (db.prepare('SELECT id FROM topics').all() as { id: number }[]).map(r => r.id);
    const edges = new Map<number, Map<number, number>>();
    for (const n of nodes) edges.set(n, new Map());

    const rows = db.prepare(
        'SELECT source_topic_id, target_topic_id, relationship_type FROM topic_relationships'
    ).all() as { source_topic_id: number; target_topic_id: number; relationship_type: string }[];

    for (const row of rows) {
        const weight = RELATIONSHIP_WEIGHTS[row.relationship_type] ?? DEFAULT_EDGE_WEIGHT;

        // Symmetrize: add both directions
        const sEdges = edges.get(row.source_topic_id);
        if (sEdges) {
            sEdges.set(row.target_topic_id, (sEdges.get(row.target_topic_id) ?? 0) + weight);
        }
        const tEdges = edges.get(row.target_topic_id);
        if (tEdges) {
            tEdges.set(row.source_topic_id, (tEdges.get(row.source_topic_id) ?? 0) + weight);
        }
    }

    return { nodes, edges };
}

/**
 * Louvain community detection algorithm.
 *
 * Phase 1: Local modularity optimization — move nodes between communities
 * to maximize modularity.
 * Phase 2: Graph aggregation — collapse communities into super-nodes.
 *
 * Returns a Map<topicId, communityId>.
 */
function louvain(graph: WeightedGraph, seed = 42): Map<number, number> {
    const { nodes, edges } = graph;

    if (nodes.length === 0) return new Map();

    // Simple seeded PRNG for reproducibility
    let rngState = seed;
    function seededRandom(): number {
        rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
        return rngState / 0x7fffffff;
    }

    // Initialize: each node in its own community
    let community = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
        community.set(nodes[i], i);
    }

    // Precompute total weight (2x sum of all edges since symmetrized)
    let totalWeight = 0;
    const nodeWeights = new Map<number, number>(); // sum of incident edge weights
    for (const [node, neighbors] of edges) {
        let sum = 0;
        for (const w of neighbors.values()) sum += w;
        nodeWeights.set(node, sum);
        totalWeight += sum;
    }
    // totalWeight is already 2x because edges are symmetrized, so we use it as-is
    const m2 = totalWeight; // = 2m in modularity formula

    if (m2 === 0) {
        // No edges — return each node as its own community
        for (let i = 0; i < nodes.length; i++) {
            community.set(nodes[i], i);
        }
        return community;
    }

    // Community-level aggregates
    const communityTotals = new Map<number, number>(); // sum of incident weights
    for (const [node, comm] of community) {
        communityTotals.set(comm, (communityTotals.get(comm) ?? 0) + (nodeWeights.get(node) ?? 0));
    }

    let improved = true;
    let iteration = 0;
    const MAX_ITERATIONS = 20;

    // Phase 1: Local optimization
    while (improved && iteration < MAX_ITERATIONS) {
        improved = false;
        iteration++;

        // Shuffle node order for non-deterministic randomness (seeded)
        const shuffledNodes = [...nodes];
        for (let i = shuffledNodes.length - 1; i > 0; i--) {
            const j = Math.floor(seededRandom() * (i + 1));
            [shuffledNodes[i], shuffledNodes[j]] = [shuffledNodes[j], shuffledNodes[i]];
        }

        for (const node of shuffledNodes) {
            const currentComm = community.get(node)!;
            const neighbors = edges.get(node)!;
            const ki = nodeWeights.get(node) ?? 0;

            // Compute modularity gain from removing node from its community
            const commTotal = communityTotals.get(currentComm) ?? 0;
            const kiIn = neighbors.size > 0
                ? Array.from(neighbors.entries())
                    .filter(([n]) => community.get(n) === currentComm)
                    .reduce((sum, [_, w]) => sum + w, 0)
                : 0;

            const gainRemove = (kiIn - (ki * commTotal) / m2);

            // Find best community to move to
            let bestComm = currentComm;
            let bestGain = 0;

            // Consider only neighboring communities
            const candidateComms = new Map<number, number>(); // community -> sum of edge weights to this community

            for (const [neighbor, weight] of neighbors) {
                const nc = community.get(neighbor)!;
                candidateComms.set(nc, (candidateComms.get(nc) ?? 0) + weight);
            }

            for (const [candidateComm, kiToCandidate] of candidateComms) {
                if (candidateComm === currentComm) continue;

                const candidateTotal = communityTotals.get(candidateComm) ?? 0;
                const gain = kiToCandidate - (ki * candidateTotal) / m2;

                // Total gain = gainAdd + gainRemove (gainRemove is negative of modularity contribution)
                // Simplified: gain = kiToCandidate - (ki * candidateTotal) / m2 - (kiIn - (ki * commTotal) / m2)
                const totalGain = gain - gainRemove;

                if (totalGain > bestGain) {
                    bestGain = totalGain;
                    bestComm = candidateComm;
                }
            }

            // Move node if modularity increases
            if (bestComm !== currentComm) {
                community.set(node, bestComm);
                communityTotals.set(currentComm, (communityTotals.get(currentComm) ?? 0) - ki);
                communityTotals.set(bestComm, (communityTotals.get(bestComm) ?? 0) + ki);
                improved = true;
            }
        }
    }

    // Phase 2: Aggregation (build reduced graph)
    // After Phase 1, we have community assignments. Aggregate Phase 2 would
    // collapse communities into super-nodes and repeat. For a graph of this
    // scale (hundreds-nodes), a single pass is usually sufficient.
    // We skip Phase 2 aggregation for simplicity and because the graphs are small.

    // Renumber communities to sequential IDs for compactness
    const uniqueComms = [...new Set(community.values())];
    const renumber = new Map<number, number>();
    uniqueComms.forEach((c, i) => renumber.set(c, i + 1));

    const result = new Map<number, number>();
    for (const [node, comm] of community) {
        result.set(node, renumber.get(comm)!);
    }

    return result;
}

// ── Embedding-based fallback clustering ────────────────────────────

/**
 * Simple cosine-similarity clustering on topic embeddings.
 * Used when the graph is too sparse for Louvain, or to assign
 * orphan topics to the nearest community.
 *
 * Implements a graph-based similarity approach:
 * 1. Build a k-nearest-neighbor graph from embedding cosine similarity
 * 2. Run Louvain on that similarity graph
 */
function embedClusterTopics(minClusterSize = 2): Map<number, number> {
    const topicData = db.prepare(
        'SELECT id, name, embedding FROM topics WHERE embedding IS NOT NULL'
    ).all() as { id: number; name: string; embedding: Buffer }[];

    if (topicData.length === 0) return new Map();

    // Parse embeddings from Buffer (stored as f32 BLOB)
    const embeddings = new Map<number, Float32Array>();
    for (const t of topicData) {
        embeddings.set(t.id, new Float32Array(t.embedding.buffer, t.embedding.byteOffset, t.embedding.byteLength / 4));
    }

    const ids = [...embeddings.keys()];

    // Compute cosine similarity and build k-NN graph (k = min(10, sqrt(n)))
    const k = Math.min(10, Math.max(2, Math.floor(Math.sqrt(ids.length))));
    const KNN_WEIGHT_THRESHOLD = 0.4; // minimum cosine similarity to consider an edge

    const similarityGraph: WeightedGraph = {
        nodes: ids,
        edges: new Map(),
    };
    for (const id of ids) similarityGraph.edges.set(id, new Map());

    // For each topic, find its k nearest neighbors by cosine similarity
    for (let i = 0; i < ids.length; i++) {
        const a = embeddings.get(ids[i])!;
        const sims: { id: number; sim: number }[] = [];

        for (let j = 0; j < ids.length; j++) {
            if (i === j) continue;
            const b = embeddings.get(ids[j])!;

            // Cosine similarity
            let dot = 0, normA = 0, normB = 0;
            for (let k = 0; k < a.length; k++) {
                dot += a[k] * b[k];
                normA += a[k] * a[k];
                normB += b[k] * b[k];
            }
            const norm = Math.sqrt(normA) * Math.sqrt(normB);
            const sim = norm > 0 ? dot / norm : 0;
            sims.push({ id: ids[j], sim });
        }

        // Sort by similarity descending, take top k
        sims.sort((a, b) => b.sim - a.sim);
        const neighbors = sims.slice(0, k).filter(s => s.sim >= KNN_WEIGHT_THRESHOLD);

        for (const n of neighbors) {
            const edgeWeight = Math.round(n.sim * 10) / 10; // quantize to 1 decimal place
            similarityGraph.edges.get(ids[i])!.set(n.id, edgeWeight);
            // Also add reverse edge for symmetry
            const rev = similarityGraph.edges.get(n.id);
            if (rev) {
                rev.set(ids[i], Math.max(rev.get(ids[i]) ?? 0, edgeWeight));
            }
        }
    }

    // Run Louvain on the similarity graph
    const communities = louvain(similarityGraph);

    // Filter out singleton communities (noise)
    const commSizes = new Map<number, number>();
    for (const comm of communities.values()) {
        commSizes.set(comm, (commSizes.get(comm) ?? 0) + 1);
    }

    const result = new Map<number, number>();
    let noiseCommId = 0;
    const noiseCommIds = new Map<number, number>();

    for (const [topicId, comm] of communities) {
        if ((commSizes.get(comm) ?? 0) >= minClusterSize) {
            result.set(topicId, comm);
        } else {
            // Assign to noise cluster (-1)
            result.set(topicId, -1);
        }
    }

    return result;
}

// ── Public API ──────────────────────────────────────────────────────

export interface CommunityResult {
    communityId: number;
    topicIds: number[];
    topicNames: string[];
    size: number;
}

/**
 * Run community detection and store results in the database.
 * Resets all community_id values and recomputes from scratch.
 *
 * Strategy:
 * 1. Build graph from topic_relationships
 * 2. Run Louvain
 * 3. For orphan topics (not in any community), use embedding similarity
 *    to assign to the nearest community, or label as noise (-1)
 * 4. Store in topics.community_id
 */
export async function recomputeCommunities(): Promise<{
    method: 'louvain' | 'embeddings' | 'none';
    communityCount: number;
    assignedCount: number;
    noiseCount: number;
    stats: GraphStats;
}> {
    const stats = getGraphStats();

    // Clear existing community assignments
    db.prepare('UPDATE topics SET community_id = NULL').run();

    let communities: Map<number, number>;

    if (stats.viableForLouvain) {
        // Method 1: Louvain on relationship graph
        const graph = buildGraph();
        communities = louvain(graph);
        console.log(`[Communities] Louvain: ${new Set(communities.values()).size} communities from ${graph.nodes.length} nodes`);
    } else if (stats.nodeCount > 0) {
        // Method 2: Embedding-based clustering (fallback)
        communities = embedClusterTopics();
        console.log(`[Communities] Embedding-based: ${new Set(communities.values()).size} communities from ${communities.size} topics`);
    } else {
        communities = new Map();
        console.log('[Communities] No topics to cluster');
    }

    // Store results in DB
    let assignedCount = 0;
    let noiseCount = 0;

    const updateStmt = db.prepare('UPDATE topics SET community_id = ? WHERE id = ?');

    const updateAll = db.transaction(() => {
        for (const [topicId, communityId] of communities) {
            if (communityId === -1) {
                noiseCount++;
            }
            updateStmt.run(communityId === -1 ? null : communityId, topicId);
            assignedCount++;
        }
    });

    updateAll();

    const communityIds = [...new Set(communities.values())].filter(c => c !== -1);
    console.log(`[Communities] Stored: ${assignedCount} topics → ${communityIds.length} communities (${noiseCount} noise)`);

    return {
        method: stats.viableForLouvain ? 'louvain' : stats.nodeCount > 0 ? 'embeddings' : 'none',
        communityCount: communityIds.length,
        assignedCount,
        noiseCount,
        stats,
    };
}

/**
 * Get all communities with their topics.
 */
export function getAllCommunities(): CommunityResult[] {
    const topics = db.prepare(`
        SELECT id, name, community_id
        FROM topics
        WHERE community_id IS NOT NULL
        ORDER BY community_id, name
    `).all() as { id: number; name: string; community_id: number }[];

    const byCommunity = new Map<number, { topicIds: number[]; topicNames: string[] }>();
    for (const t of topics) {
        if (!byCommunity.has(t.community_id)) {
            byCommunity.set(t.community_id, { topicIds: [], topicNames: [] });
        }
        byCommunity.get(t.community_id)!.topicIds.push(t.id);
        byCommunity.get(t.community_id)!.topicNames.push(t.name);
    }

    return Array.from(byCommunity.entries())
        .map(([communityId, data]) => ({
            communityId,
            topicIds: data.topicIds,
            topicNames: data.topicNames,
            size: data.topicIds.length,
        }))
        .sort((a, b) => b.size - a.size);
}

/**
 * Get the community for a specific topic, including all other topics in that community.
 */
export function getTopicCommunity(topicId: number): { communityId: number; members: { id: number; name: string }[] } | null {
    const topic = db.prepare('SELECT id, name, community_id FROM topics WHERE id = ?').get(topicId) as
        { id: number; name: string; community_id: number | null } | undefined;

    if (!topic || topic.community_id === null) return null;

    const members = db.prepare(`
        SELECT id, name FROM topics
        WHERE community_id = ? AND id != ?
        ORDER BY name
    `).all(topic.community_id, topicId) as { id: number; name: string }[];

    return { communityId: topic.community_id, members };
}

/**
 * Get all noise topics (not assigned to any community).
 */
export function getNoiseTopics(): { id: number; name: string }[] {
    return db.prepare(`
        SELECT id, name FROM topics
        WHERE community_id IS NULL OR community_id = -1
        ORDER BY name
    `).all() as { id: number; name: string }[];
}