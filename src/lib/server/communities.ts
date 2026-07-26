/**
 * Community Detection for the Knowledge Graph.
 *
 * Two complementary approaches:
 * 1. Louvain on the topic-relationship graph (symmetrized, weighted), via
 *    `graphology-communities-louvain`
 * 2. Cosine-similarity clustering on topic embeddings (fallback for orphans)
 *
 * Communities are stored in topics.community_id and recomputed after each
 * ingestion batch (full recompute only — no incremental heuristic).
 */

import { db } from './db';
import Graph, { UndirectedGraph } from 'graphology';
import communitiesLouvain from 'graphology-communities-louvain';
import crypto from 'crypto';
import { summarizeCommunity, getEmbedding } from './llm';
import { assertStorableEmbedding } from './embedding-dimension';
import { markVectorIndexDirty } from './vector-index';
import { inCategory } from './usage';

// ── Edge weight map for relationship types ──────────────────────────
// Strong structural links (is_part_of, is_a) get higher weight;
// weak referential links get lower weight.
// Exported so retrieval-time topic expansion (rag.ts::getRelatedTopics /
// buildKnowledgeContext) can prioritise strong relationships over weak ones
// when a cap on the number of expanded topics is hit, instead of taking
// whatever order SQLite happens to return rows in.
export const RELATIONSHIP_WEIGHTS: Record<string, number> = {
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

export const DEFAULT_EDGE_WEIGHT = 0.3;

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
 * Convert the symmetrized adjacency map into an undirected graphology graph.
 *
 * `buildGraph` stores every edge in both directions with the same weight, so
 * each unordered pair is added once, from whichever direction is seen first.
 * Self-loops (a topic related to itself) are passed through — graphology's
 * Louvain applies the doubled-diagonal convention internally, which is the
 * same convention the previous hand-written implementation maintained by hand.
 */
function toGraphology(graph: WeightedGraph): Graph {
    const g = new UndirectedGraph();
    for (const n of graph.nodes) g.addNode(String(n));

    for (const [node, neighbors] of graph.edges) {
        for (const [neighbor, weight] of neighbors) {
            if (!g.hasNode(String(node)) || !g.hasNode(String(neighbor))) continue;
            if (node !== neighbor && g.hasEdge(String(node), String(neighbor))) continue;
            g.mergeUndirectedEdge(String(node), String(neighbor), { weight });
        }
    }
    return g;
}

/**
 * Louvain community detection over the weighted topic graph.
 *
 * Delegates the algorithm itself to `graphology-communities-louvain`, which
 * replaced ~220 lines of hand-written local-moving and super-node aggregation.
 * The surrounding policy is what is actually specific to this knowledge base
 * and stays here: `RELATIONSHIP_WEIGHTS`, `getGraphStats()`'s
 * `viableForLouvain` gate, and the embedding-similarity fallback for graphs too
 * sparse to cluster structurally.
 *
 * `seed` drives a seeded PRNG so repeated runs over an unchanged graph produce
 * the same partition — community IDs are written to `topics.community_id` and
 * shown in the UI, so churn between identical runs would read as real change.
 *
 * Returns a Map<topicId, communityId> over the ORIGINAL node IDs, numbered
 * sequentially from 1.
 */
function louvain(graph: WeightedGraph, seed = 42): Map<number, number> {
    if (graph.nodes.length === 0) return new Map();

    // Same LCG as the previous implementation, kept so that a given seed keeps
    // meaning the same thing across this change.
    let rngState = seed;
    const rng = () => {
        rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
        return rngState / 0x7fffffff;
    };

    const g = toGraphology(graph);

    // No edges: Louvain has nothing to optimise and every node is its own
    // community. Handled here because the callers (recomputeCommunities, and
    // embedClusterTopics on a corpus with no embeddings) can both hit it.
    if (g.size === 0) {
        const singletons = new Map<number, number>();
        graph.nodes.forEach((n, i) => singletons.set(n, i + 1));
        return singletons;
    }

    const assignment = communitiesLouvain(g, {
        getEdgeWeight: 'weight',
        rng
    }) as Record<string, number>;

    // Renumber to sequential IDs from 1 for compactness. Iteration follows
    // `graph.nodes` rather than the returned object so numbering depends only
    // on node order, not on key enumeration.
    const renumber = new Map<number, number>();
    const result = new Map<number, number>();
    for (const node of graph.nodes) {
        const raw = assignment[String(node)];
        if (raw === undefined) continue;
        if (!renumber.has(raw)) renumber.set(raw, renumber.size + 1);
        result.set(node, renumber.get(raw)!);
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
export const recomputeCommunities = inCategory('knowledge', recomputeCommunitiesImpl);

async function recomputeCommunitiesImpl(
    options: { refreshReports?: boolean } = {}
): Promise<{
    method: 'louvain' | 'embeddings' | 'none';
    communityCount: number;
    assignedCount: number;
    noiseCount: number;
    stats: GraphStats;
    reports: { generated: number; reused: number; skipped: number; pruned: number; deferred: number };
}> {
    // Partition recompute is cheap and pure SQL/CPU; report generation costs an
    // LLM call per changed community. Batch ingestion (git sync) therefore
    // recomputes the partition per document — community_id must never be stale —
    // but suppresses reports until the batch is done, because during a sync every
    // new document reshuffles membership and the member_hash cache would miss on
    // essentially every file.
    const refreshReports = options.refreshReports !== false;
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

    // Reports are refreshed in the same pass that rewrote community_id: the
    // partition has just been renumbered, so any report still pointing at an old
    // id is mislabelled until this runs. Contained — a failure here leaves the
    // partition itself correctly stored.
    //
    // When suppressed (batch ingestion), reports keep pointing at the previous
    // numbering until the batch's final refresh. `getCommunityReportTopics` reads
    // members by community_id, so a report can briefly list the wrong members —
    // acceptable for the duration of a sync, and the reason the batch caller must
    // finish with an unsuppressed recompute.
    let reports = { generated: 0, reused: 0, skipped: 0, pruned: 0, deferred: 0 };
    if (refreshReports) {
        try {
            reports = await refreshCommunityReports();
        } catch (err) {
            console.error('[Communities] Report refresh failed (partition itself was stored successfully):', err);
        }
    }

    return {
        method: stats.viableForLouvain ? 'louvain' : stats.nodeCount > 0 ? 'embeddings' : 'none',
        communityCount: communityIds.length,
        assignedCount,
        noiseCount,
        stats,
        reports,
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

// ── Community reports (thematic retrieval path) ─────────────────────
//
// Louvain output on its own is not retrievable — see the `community_reports`
// migration in db.ts. These functions turn each community into an embedded
// title+summary so `rag.ts::searchCommunities` can match a broad question
// against a whole area of the corpus instead of against individual topics.

/**
 * Communities smaller than this get no report. A 2-topic cluster's "theme" is
 * just the two topic names, which the entity-level retrieval path already
 * covers — generating a report for it costs an LLM call and adds a near-duplicate
 * competitor to the thematic vector search.
 */
const MIN_REPORT_COMMUNITY_SIZE = Number(process.env.COMMUNITY_REPORT_MIN_SIZE) || 3;

/**
 * Ceiling on how many *new* reports one refresh will generate. Cached reports
 * (unchanged membership) are always re-pointed for free and don't count against
 * this. Exists so the first run over a large corpus can't fan out into hundreds
 * of LLM calls inside an ingestion request; the remainder are picked up by
 * subsequent runs, largest-community-first.
 */
const MAX_REPORTS_PER_RUN = Number(process.env.COMMUNITY_REPORT_MAX_PER_RUN) || 25;

/** Concurrent report-generation calls. Modest — these are full LLM generations. */
const REPORT_CONCURRENCY = Number(process.env.COMMUNITY_REPORT_CONCURRENCY) || 3;

/** How many claims to feed one report. Enough to ground it, not enough to blow the context. */
const CLAIMS_PER_REPORT = 40;

function reportsEnabled(): boolean {
    return process.env.COMMUNITY_REPORTS_ENABLED !== 'false';
}

/**
 * Identity of a community *by content*, not by id.
 *
 * Louvain renumbers communities on every recompute, so `community_id` cannot
 * serve as a cache key — an unchanged cluster generally comes back under a
 * different number. The sorted member ids identify the cluster itself, and the
 * active-claim count is folded in so that a community whose topics stayed the
 * same but whose facts grew gets a fresh report rather than serving a stale one.
 */
function communityMemberHash(topicIds: number[], claimCount: number): string {
    const sorted = [...topicIds].sort((a, b) => a - b).join(',');
    return crypto.createHash('sha256').update(`${sorted}:${claimCount}`).digest('hex');
}

function countActiveClaims(topicIds: number[]): number {
    if (topicIds.length === 0) return 0;
    const placeholders = topicIds.map(() => '?').join(',');
    return (db.prepare(
        `SELECT COUNT(*) AS c FROM knowledge_claims WHERE status = 'active' AND topic_id IN (${placeholders})`
    ).get(...topicIds) as { c: number }).c;
}

/**
 * Gathers the grounding material for one community's report: the member topics,
 * the relationships that run *between* members (the edges that made Louvain
 * cluster them in the first place), and a sample of their active claims.
 */
function collectReportInputs(topicIds: number[]): {
    topics: { name: string; description: string | null; category: string | null }[];
    claims: string[];
    relationshipHints: string[];
} {
    const placeholders = topicIds.map(() => '?').join(',');

    const topics = db.prepare(
        `SELECT name, description, category FROM topics WHERE id IN (${placeholders}) ORDER BY name`
    ).all(...topicIds) as { name: string; description: string | null; category: string | null }[];

    // Spread the claim sample across topics rather than taking the first N rows,
    // so one claim-heavy topic can't crowd every other member out of the report.
    const perTopic = Math.max(1, Math.ceil(CLAIMS_PER_REPORT / topicIds.length));
    const claims: string[] = [];
    const claimStmt = db.prepare(
        `SELECT claim_text FROM knowledge_claims
         WHERE topic_id = ? AND status = 'active'
         ORDER BY created_at LIMIT ?`
    );
    for (const id of topicIds) {
        if (claims.length >= CLAIMS_PER_REPORT) break;
        const rows = claimStmt.all(id, perTopic) as { claim_text: string }[];
        for (const r of rows) claims.push(r.claim_text);
    }

    const relationshipHints = (db.prepare(
        `SELECT s.name AS source, r.relationship_type AS type, t.name AS target
         FROM topic_relationships r
         JOIN topics s ON s.id = r.source_topic_id
         JOIN topics t ON t.id = r.target_topic_id
         WHERE r.source_topic_id IN (${placeholders}) AND r.target_topic_id IN (${placeholders})
         LIMIT 30`
    ).all(...topicIds, ...topicIds) as { source: string; type: string; target: string }[])
        .map(r => `${r.source} —${r.type}→ ${r.target}`);

    return { topics, claims: claims.slice(0, CLAIMS_PER_REPORT), relationshipHints };
}

async function embedCommunityReport(reportId: number, title: string, summary: string): Promise<void> {
    const embedding = await getEmbedding(`${title}\n\n${summary}`, 'RETRIEVAL_DOCUMENT', title);
    // Refuse a wrong-dimension write rather than storing a report that
    // searchCommunities will silently skip forever — see assertStorableEmbedding.
    // Report refreshes are already contained per community by the caller, so this
    // throw costs one report and is retried on the next run.
    assertStorableEmbedding('community_reports', embedding, `community report "${title}"`);

    try {
        db.prepare("SELECT vector_init('community_reports', 'embedding', ?)").get(
            `dimension=${embedding.length},distance=cosine`
        );
    } catch (e) {
        // Already initialized
    }

    db.prepare(
        'UPDATE community_reports SET embedding = vector_as_f32(?), embedding_updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(JSON.stringify(embedding), reportId);

    // A refreshed report re-uses its row, so the row count the quantized index
    // was built from is unchanged — searchCommunities would keep matching the
    // previous summary's vector until the structure is rebuilt. See ./vector-index.
    markVectorIndexDirty('community_reports');
}

/**
 * Bring `community_reports` in line with the current partition in
 * `topics.community_id`.
 *
 * Unchanged communities cost nothing (cache hit on member_hash, id re-pointed);
 * changed or new ones are summarised and embedded; communities that no longer
 * exist have their reports deleted so the thematic vector search never matches
 * a partition that is gone.
 *
 * Failures are contained per community — one bad LLM response leaves that
 * community without a report rather than aborting the refresh, and the next run
 * retries it (its hash is still absent from the table).
 */
export const refreshCommunityReports = inCategory('knowledge', refreshCommunityReportsImpl);

async function refreshCommunityReportsImpl(): Promise<{
    generated: number;
    reused: number;
    skipped: number;
    pruned: number;
    deferred: number;
}> {
    if (!reportsEnabled()) {
        return { generated: 0, reused: 0, skipped: 0, pruned: 0, deferred: 0 };
    }

    const communities = getAllCommunities(); // already sorted largest-first
    const currentHashes = new Set<string>();
    let generated = 0;
    let reused = 0;
    let skipped = 0;
    let deferred = 0;

    // Pass 1: resolve every community to a hash, reusing cached reports.
    const toGenerate: { communityId: number; topicIds: number[]; hash: string; claimCount: number }[] = [];

    for (const community of communities) {
        if (community.size < MIN_REPORT_COMMUNITY_SIZE) {
            skipped++;
            continue;
        }

        const claimCount = countActiveClaims(community.topicIds);
        const hash = communityMemberHash(community.topicIds, claimCount);
        currentHashes.add(hash);

        const existing = db.prepare('SELECT id FROM community_reports WHERE member_hash = ?').get(hash) as
            | { id: number }
            | undefined;

        if (existing) {
            db.prepare(
                'UPDATE community_reports SET community_id = ?, topic_count = ?, claim_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(community.communityId, community.size, claimCount, existing.id);
            reused++;
        } else {
            toGenerate.push({ communityId: community.communityId, topicIds: community.topicIds, hash, claimCount });
        }
    }

    // Pass 2: generate the missing ones, largest-community-first, up to the cap.
    if (toGenerate.length > MAX_REPORTS_PER_RUN) {
        deferred = toGenerate.length - MAX_REPORTS_PER_RUN;
        // Drop the deferred hashes from the "current" set so the prune below
        // doesn't treat them as live; they simply have no report yet and will be
        // picked up by the next refresh.
        for (const c of toGenerate.slice(MAX_REPORTS_PER_RUN)) currentHashes.delete(c.hash);
        toGenerate.length = MAX_REPORTS_PER_RUN;
        console.warn(
            `[Communities] Report generation capped at ${MAX_REPORTS_PER_RUN} this run; ` +
            `${deferred} community report(s) DEFERRED to the next refresh (raise COMMUNITY_REPORT_MAX_PER_RUN to change).`
        );
    }

    let cursor = 0;
    const worker = async () => {
        while (true) {
            const i = cursor++;
            if (i >= toGenerate.length) return;
            const target = toGenerate[i];

            try {
                const inputs = collectReportInputs(target.topicIds);
                const report = await summarizeCommunity(inputs.topics, inputs.claims, inputs.relationshipHints);
                if (!report) {
                    currentHashes.delete(target.hash);
                    continue;
                }

                const inserted = db.prepare(
                    `INSERT INTO community_reports (member_hash, community_id, title, summary, topic_count, claim_count)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(member_hash) DO UPDATE SET
                        community_id = excluded.community_id,
                        title = excluded.title,
                        summary = excluded.summary,
                        topic_count = excluded.topic_count,
                        claim_count = excluded.claim_count,
                        updated_at = CURRENT_TIMESTAMP
                     RETURNING id`
                ).get(
                    target.hash,
                    target.communityId,
                    report.title,
                    report.summary,
                    target.topicIds.length,
                    target.claimCount
                ) as { id: number } | undefined;

                if (!inserted) {
                    currentHashes.delete(target.hash);
                    continue;
                }

                await embedCommunityReport(inserted.id, report.title, report.summary);
                generated++;
            } catch (err) {
                // Leave this community without a report; the next refresh retries
                // it because its hash is still missing from the table.
                currentHashes.delete(target.hash);
                console.error(`[Communities] Report failed for community ${target.communityId}:`, (err as Error).message);
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(REPORT_CONCURRENCY, toGenerate.length)) }, () => worker())
    );

    // Pass 3: prune reports for partitions that no longer exist.
    const allHashes = (db.prepare('SELECT id, member_hash FROM community_reports').all() as
        { id: number; member_hash: string }[]);
    const stale = allHashes.filter(r => !currentHashes.has(r.member_hash));
    let pruned = 0;
    if (stale.length > 0) {
        const del = db.prepare('DELETE FROM community_reports WHERE id = ?');
        const delAll = db.transaction(() => {
            for (const r of stale) {
                del.run(r.id);
                pruned++;
            }
        });
        delAll();
    }

    console.log(
        `[Communities] Reports: ${generated} generated, ${reused} reused, ${skipped} community/-ies too small, ` +
        `${pruned} pruned${deferred > 0 ? `, ${deferred} deferred` : ''}`
    );

    return { generated, reused, skipped, pruned, deferred };
}

export interface CommunityReportRow {
    id: number;
    communityId: number | null;
    title: string;
    summary: string;
    topicCount: number;
    claimCount: number;
    updatedAt: string;
}

/** All current community reports, largest community first. */
export function getCommunityReports(): CommunityReportRow[] {
    return (db.prepare(
        `SELECT id, community_id, title, summary, topic_count, claim_count, updated_at
         FROM community_reports
         WHERE community_id IS NOT NULL
         ORDER BY topic_count DESC, id ASC`
    ).all() as {
        id: number;
        community_id: number | null;
        title: string;
        summary: string;
        topic_count: number;
        claim_count: number;
        updated_at: string;
    }[]).map(r => ({
        id: r.id,
        communityId: r.community_id,
        title: r.title,
        summary: r.summary,
        topicCount: r.topic_count,
        claimCount: r.claim_count,
        updatedAt: r.updated_at
    }));
}

/** Member topics of the community a report describes, for citation/expansion. */
export function getCommunityReportTopics(communityId: number, limit = 12): { id: number; name: string }[] {
    return db.prepare(
        `SELECT t.id, t.name,
                COUNT(kc.id) AS claim_count
         FROM topics t
         LEFT JOIN knowledge_claims kc ON kc.topic_id = t.id AND kc.status = 'active'
         WHERE t.community_id = ?
         GROUP BY t.id
         ORDER BY claim_count DESC, t.name ASC
         LIMIT ?`
    ).all(communityId, limit) as { id: number; name: string }[];
}
