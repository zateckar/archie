/**
 * Subgraph extraction for the knowledge-graph visualization.
 *
 * ## What was wrong with the old view
 *
 * The canvas was fed by the same "entire graph" endpoint as everything else, and
 * the client picked which nodes to draw by ranking topics on
 * `relCount * 2 + claimCount` and slicing the top N. Two consequences, both
 * visible on screen:
 *
 *  1. **Floating circles.** Node selection ignored whether the *selected* nodes
 *     were connected to each other. A topic with 4 relationships scores well and
 *     gets drawn even when all 4 of its neighbours fall outside the cut, so it
 *     arrives with no visible edge at all. With `minClaims > 0` or a category
 *     filter, most of the canvas ended up in that state — and topics with no
 *     relationships whatsoever (1000+ of them in this corpus) were eligible for
 *     drawing too, purely on claim count.
 *
 *  2. **The hairball.** Everything that *was* connected got pulled into one
 *     undifferentiated ball, because the layout had a single global centre of
 *     gravity and no notion of the clustering the corpus already has.
 *
 * ## What this returns instead
 *
 * A subgraph with a guarantee: **every node it returns has at least one edge in
 * the same result.** Selection starts from relationships rather than from topics,
 * and any node left with no induced edge is dropped and counted rather than
 * drawn. Nodes also carry their community (the Louvain partition already stored
 * in `topics.community_id`, with titles from `community_reports`), which is what
 * lets the client lay clusters out separately instead of as one ball.
 *
 * Ranking is by degree *within the subgraph being built*, so a dense
 * neighbourhood survives filtering as a neighbourhood.
 */
import { db } from './db';

export interface GraphNodePayload {
    id: number;
    name: string;
    category: string | null;
    communityId: number | null;
    claimCount: number;
    /** Degree in the returned subgraph — what the client sizes nodes by. */
    degree: number;
    /** Total degree in the full graph, so the UI can say "12 of 30 shown". */
    totalDegree: number;
    /** Hops from the focused node; 0 for the focus itself, null when unfocused. */
    hop: number | null;
    /**
     * False for a node pulled in only to give a match its context (a search
     * neighbour or a bridge), so the client can foreground what was asked for.
     */
    matched: boolean;
}

export interface GraphEdgePayload {
    source: number;
    target: number;
    type: string;
}

export interface GraphCommunityPayload {
    id: number;
    title: string | null;
    nodeCount: number;
}

export interface KnowledgeGraphPayload {
    nodes: GraphNodePayload[];
    edges: GraphEdgePayload[];
    communities: GraphCommunityPayload[];
    meta: {
        totalTopics: number;
        totalEdges: number;
        connectedTopics: number;
        /** Topics with no relationship at all — never drawn, always counted. */
        isolatedTopics: number;
        /** Matched the filters but were cut by maxNodes. */
        omittedByLimit: number;
        /** Matched the filters but had no edge to any other visible node. */
        droppedUnconnected: number;
        focusTopicId: number | null;
        truncated: boolean;
    };
}

export interface GraphQuery {
    search?: string | null;
    category?: string | null;
    minClaims?: number | string | null;
    maxNodes?: number | string | null;
    focusTopicId?: number | string | null;
    /** Hops to expand around the focused topic (1–3). */
    depth?: number | string | null;
}

const DEFAULT_MAX_NODES = 90;
const MAX_MAX_NODES = 600;

interface Edge {
    source: number;
    target: number;
    type: string;
}

interface TopicMeta {
    id: number;
    name: string;
    category: string | null;
    communityId: number | null;
    claimCount: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * Loads the whole relationship list and topic metadata once.
 *
 * Deliberately not paged: the graph is 4170 edges and 1585 topics of small scalar
 * data (~200KB in SQLite), and traversal needs the adjacency structure to decide
 * what to return. What used to be shipped to the browser — descriptions, claim
 * text, every claim row — is not read at all, so this is far cheaper than the
 * payload it replaces while supporting real traversal.
 */
function loadGraph(): { topics: Map<number, TopicMeta>; edges: Edge[]; adjacency: Map<number, number[]> } {
    const topicRows = db
        .prepare(
            `
            WITH claim_counts AS (
                SELECT topic_id, COUNT(*) AS n FROM knowledge_claims WHERE status = 'active' GROUP BY topic_id
            )
            SELECT t.id, t.name, t.category, t.community_id AS communityId, COALESCE(cc.n, 0) AS claimCount
            FROM topics t
            LEFT JOIN claim_counts cc ON cc.topic_id = t.id
        `
        )
        .all() as TopicMeta[];

    const topics = new Map<number, TopicMeta>(topicRows.map(t => [t.id, t]));

    const edgeRows = db
        .prepare(
            `SELECT source_topic_id AS source, target_topic_id AS target, relationship_type AS type
             FROM topic_relationships`
        )
        .all() as Edge[];

    // Self-loops and dangling endpoints draw as artefacts (a circle with a line
    // to itself, or an edge to nothing) rather than as information.
    const edges = edgeRows.filter(e => e.source !== e.target && topics.has(e.source) && topics.has(e.target));

    const adjacency = new Map<number, number[]>();
    for (const e of edges) {
        if (!adjacency.has(e.source)) adjacency.set(e.source, []);
        if (!adjacency.has(e.target)) adjacency.set(e.target, []);
        adjacency.get(e.source)!.push(e.target);
        adjacency.get(e.target)!.push(e.source);
    }

    return { topics, edges, adjacency };
}

function matchesFilters(
    topic: TopicMeta,
    filters: { search: string; category: string | null; minClaims: number }
): boolean {
    if (filters.category && filters.category !== 'All' && topic.category !== filters.category) return false;
    if (topic.claimCount < filters.minClaims) return false;
    if (filters.search) {
        const haystack = `${topic.name} ${topic.category ?? ''}`.toLowerCase();
        if (!haystack.includes(filters.search)) return false;
    }
    return true;
}

export function buildKnowledgeGraph(query: GraphQuery): KnowledgeGraphPayload {
    const maxNodes = clampInt(query.maxNodes, DEFAULT_MAX_NODES, 10, MAX_MAX_NODES);
    const minClaims = clampInt(query.minClaims, 0, 0, 1000);
    const depth = clampInt(query.depth, 2, 1, 3);
    const focusRaw = Math.trunc(Number(query.focusTopicId));
    const focusTopicId = Number.isFinite(focusRaw) && focusRaw > 0 ? focusRaw : null;
    const search = (query.search ?? '').trim().toLowerCase();

    const { topics, edges, adjacency } = loadGraph();
    const connectedTopics = adjacency.size;
    const isolatedTopics = topics.size - connectedTopics;

    const filters = { search, category: query.category ?? null, minClaims };

    /** Degree in the full graph. */
    const totalDegree = (id: number) => adjacency.get(id)?.length ?? 0;

    let selected: Set<number>;
    const hops = new Map<number, number>();
    /** Nodes the query actually asked for, as opposed to context added around them. */
    const matched = new Set<number>();
    let omittedByLimit = 0;

    if (focusTopicId !== null && topics.has(focusTopicId)) {
        // ── Focus mode: an ego network, breadth-first, closest hops first ──
        // Filters are deliberately NOT applied here. When you ask what a topic is
        // connected to, hiding a neighbour because it sits in another category
        // answers a different question — and produces exactly the disconnected
        // fragments this view is meant to eliminate.
        selected = new Set<number>([focusTopicId]);
        hops.set(focusTopicId, 0);
        matched.add(focusTopicId);
        let frontier = [focusTopicId];
        for (let d = 1; d <= depth && selected.size < maxNodes; d++) {
            const next: number[] = [];
            // Within a hop, expand the best-connected neighbours first, so a cap
            // hit at depth 1 keeps the structurally important part of the ring.
            const candidates = frontier
                .flatMap(id => adjacency.get(id) ?? [])
                .filter(id => !selected.has(id));
            const unique = [...new Set(candidates)].sort((a, b) => totalDegree(b) - totalDegree(a));
            for (const id of unique) {
                if (selected.size >= maxNodes) {
                    omittedByLimit++;
                    continue;
                }
                selected.add(id);
                hops.set(id, d);
                next.push(id);
            }
            frontier = next;
            if (frontier.length === 0) break;
        }
    } else {
        // ── Overview mode ────────────────────────────────────────────────────
        // Start from topics that HAVE relationships and match the filters, ranked
        // by degree. Isolated topics are never candidates: a node with no edge
        // cannot show a relationship, which is the entire point of this view (they
        // remain reachable through the Topics tab, and are counted in `meta`).
        const candidates = [...adjacency.keys()]
            .map(id => topics.get(id)!)
            .filter(t => matchesFilters(t, filters))
            .sort((a, b) => totalDegree(b.id) - totalDegree(a.id) || b.claimCount - a.claimCount);

        selected = new Set<number>(candidates.slice(0, maxNodes).map(t => t.id));
        omittedByLimit = Math.max(0, candidates.length - selected.size);
        for (const id of selected) matched.add(id);

        // A search usually matches a handful of topics scattered across the graph,
        // and those rarely link directly to each other — shown alone they are a
        // row of disconnected pairs, or nothing at all. Their neighbours are what
        // make a match legible ("this norm governs those three processes"), so a
        // narrow result set is expanded by one hop; the expansion is marked
        // unmatched so the client can keep the hits visually distinct.
        if (search && selected.size > 0 && selected.size < maxNodes) {
            for (const id of [...selected]) {
                for (const neighbour of adjacency.get(id) ?? []) {
                    if (selected.size >= maxNodes) break;
                    selected.add(neighbour);
                }
            }
        }

        // Pull in one round of connective tissue: a neighbour that links two
        // already-selected nodes explains the structure better than the next
        // highest-degree node in isolation, so spare capacity goes to bridges
        // (this is what turns a scatter of pairs into a readable network).
        if (selected.size < maxNodes) {
            const bridgeScore = new Map<number, number>();
            for (const id of selected) {
                for (const neighbour of adjacency.get(id) ?? []) {
                    if (selected.has(neighbour)) continue;
                    bridgeScore.set(neighbour, (bridgeScore.get(neighbour) ?? 0) + 1);
                }
            }
            const bridges = [...bridgeScore.entries()]
                .filter(([, links]) => links >= 2)
                .sort((a, b) => b[1] - a[1]);
            for (const [id] of bridges) {
                if (selected.size >= maxNodes) break;
                selected.add(id);
            }
        }
    }

    // ── Induce edges, then drop anything left unconnected ────────────────────
    // This is the guarantee: a node survives only if an edge in this very result
    // touches it. Whatever the filters or caps did, the canvas cannot receive a
    // circle with nothing attached to it.
    const inducedEdges = edges.filter(e => selected.has(e.source) && selected.has(e.target));

    const degree = new Map<number, number>();
    for (const e of inducedEdges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const keptIds = [...selected].filter(id => (degree.get(id) ?? 0) > 0);
    const droppedUnconnected = selected.size - keptIds.length;

    const nodes: GraphNodePayload[] = keptIds.map(id => {
        const t = topics.get(id)!;
        return {
            id: t.id,
            name: t.name,
            category: t.category,
            communityId: t.communityId,
            claimCount: t.claimCount,
            degree: degree.get(id) ?? 0,
            totalDegree: totalDegree(id),
            hop: hops.has(id) ? hops.get(id)! : null,
            // With no search and no focus every node is a legitimate result, so
            // nothing is dimmed; `matched` only distinguishes hits from context.
            matched: !search && focusTopicId === null ? true : matched.has(id)
        };
    });

    // Communities present in the result, labelled from the LLM-written reports
    // where one exists. The client groups by this, so unlabelled clusters still
    // need an entry.
    const communityCounts = new Map<number, number>();
    for (const n of nodes) {
        if (n.communityId === null || n.communityId === undefined) continue;
        communityCounts.set(n.communityId, (communityCounts.get(n.communityId) ?? 0) + 1);
    }

    let titles = new Map<number, string>();
    if (communityCounts.size > 0) {
        try {
            const placeholders = [...communityCounts.keys()].map(() => '?').join(',');
            const rows = db
                .prepare(
                    `SELECT community_id AS id, title FROM community_reports
                     WHERE community_id IN (${placeholders})`
                )
                .all(...communityCounts.keys()) as { id: number; title: string }[];
            titles = new Map(rows.map(r => [r.id, r.title]));
        } catch {
            // Pre-migration DB with no community_reports table: clusters stay unlabelled.
        }
    }

    const communities: GraphCommunityPayload[] = [...communityCounts.entries()]
        .map(([id, nodeCount]) => ({ id, title: titles.get(id) ?? null, nodeCount }))
        .sort((a, b) => b.nodeCount - a.nodeCount);

    return {
        nodes,
        edges: inducedEdges,
        communities,
        meta: {
            totalTopics: topics.size,
            totalEdges: edges.length,
            connectedTopics,
            isolatedTopics,
            omittedByLimit,
            droppedUnconnected,
            focusTopicId: focusTopicId !== null && topics.has(focusTopicId) ? focusTopicId : null,
            truncated: omittedByLimit > 0
        }
    };
}
