<script lang="ts">
    /**
     * Knowledge-graph canvas.
     *
     * ## What this replaces, and why it looked the way it did
     *
     * The previous version drew "a lot of floating circles not connected to
     * anything and a spaghetti ball in the middle". Both were structural, not
     * cosmetic:
     *
     *  - **Floating circles.** Node selection ranked topics by
     *    `relCount * 2 + claimCount` and sliced the top N, with no regard for
     *    whether the chosen nodes were connected *to each other*. A topic whose
     *    neighbours all fell outside the cut arrived with no edge at all, and
     *    topics with zero relationships were eligible purely on claim count.
     *    Selection now happens server-side, starting from relationships, and
     *    every node in the payload is guaranteed to have an edge in the same
     *    payload (see lib/server/knowledge-graph.ts).
     *
     *  - **The spaghetti ball.** One global centre of gravity pulled everything
     *    into a single mass, and the corpus's own clustering — the Louvain
     *    partition already stored in `topics.community_id` — was not used at all.
     *    The layout here is two-level: cluster centroids are laid out first, then
     *    nodes are laid out inside their cluster with the centroid as their
     *    gravity well. Clusters end up as visually separate, labelled regions with
     *    the edges *between* them readable as edges.
     *
     * ## Encoding choices
     *
     * Cluster identity is carried by **position and a label**, not by hue: with a
     * dozen-plus communities on screen simultaneously, no categorical palette can
     * keep every pair distinguishable (including under colour-vision deficiency),
     * and a graph is the all-pairs case — any node can end up beside any other.
     * Hue is therefore left to the four `--cat-*` category tokens this app
     * already uses for the tags in the markup, and category is always available as
     * text (hover card, detail panel), so colour never carries meaning alone.
     *
     * Marks follow the same rules as the app's charts: a surface-coloured ring on
     * every node so overlapping circles stay countable, thin recessive edges,
     * arrowheads only where they are being read, and labels on hubs and hovered
     * nodes rather than on all of them.
     */
    import { onMount, tick } from 'svelte';
    import Search from '@lucide/svelte/icons/search';
    import Maximize2 from '@lucide/svelte/icons/maximize-2';
    import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
    import Crosshair from '@lucide/svelte/icons/crosshair';
    import X from '@lucide/svelte/icons/x';
    import Loader2 from '@lucide/svelte/icons/loader-2';
    import GitBranch from '@lucide/svelte/icons/git-branch';
    import FileCheck from '@lucide/svelte/icons/file-check';

    interface Props {
        /** Category names for the filter control (from the topics endpoint). */
        categories?: string[];
        /** Invoked when the user asks to see a topic's claims. */
        onViewClaims?: (topicId: number, topicName: string) => void;
        /** Height of the canvas area. */
        height?: string;
    }

    let { categories = [], onViewClaims = undefined, height = '620px' }: Props = $props();

    // ── Payload types (mirror lib/server/knowledge-graph.ts) ──
    interface ApiNode {
        id: number;
        name: string;
        category: string | null;
        communityId: number | null;
        claimCount: number;
        degree: number;
        totalDegree: number;
        hop: number | null;
        matched: boolean;
    }
    interface ApiEdge { source: number; target: number; type: string }
    interface ApiCommunity { id: number; title: string | null; nodeCount: number }
    interface GraphMeta {
        totalTopics: number;
        totalEdges: number;
        connectedTopics: number;
        isolatedTopics: number;
        omittedByLimit: number;
        droppedUnconnected: number;
        focusTopicId: number | null;
        truncated: boolean;
    }

    // ── Simulation types ──
    interface Node extends ApiNode {
        x: number; y: number; vx: number; vy: number;
        radius: number;
        /** Cluster key: community id, or a sentinel for topics with no community. */
        cluster: number;
        pinned: boolean;
    }
    interface Edge { source: Node; target: Node; type: string; intra: boolean }
    interface Cluster {
        key: number;
        title: string | null;
        nodes: Node[];
        /**
         * Reserved centre, fixed by layoutClusters and guaranteed not to overlap
         * any other cluster's reserved circle. Gravity and containment are both
         * anchored here.
         *
         * This is deliberately NOT the live centroid of the member nodes. When the
         * two were one field, the per-frame centroid recomputation (for label
         * placement) moved the anchor, gravity then pulled nodes toward the moved
         * anchor, and the drift compounded until clusters wandered across each
         * other — visible on screen as separate outlines sliding into one mass.
         */
        ax: number; ay: number;
        /** Live centroid of the member nodes — for the label only. */
        cx: number; cy: number;
        /** Convex hull of member positions, recomputed each frame. */
        hull: { x: number; y: number }[];
    }

    const UNCLUSTERED = -1;

    // ── Controls ──
    let search = $state('');
    let category = $state('All');
    let minClaims = $state(0);
    /**
     * Default node budget. 150 was measured on this corpus as ~930 edges on
     * screen — average degree 12, which no layout renders as anything but a mass.
     * 90 keeps the clusters and the links between them legible; the control raises
     * it, and the status line always says how many matches are being held back.
     */
    let maxNodes = $state(90);
    let depth = $state(2);
    let focusTopicId = $state<number | null>(null);

    let loading = $state(true);
    let error = $state<string | null>(null);
    let meta = $state<GraphMeta | null>(null);
    let communities = $state<ApiCommunity[]>([]);
    let focusName = $state<string | null>(null);

    // ── Canvas / view state ──
    let canvas = $state<HTMLCanvasElement | undefined>(undefined);
    let wrapper = $state<HTMLDivElement | undefined>(undefined);

    // The simulation arrays are deliberately NOT `$state`: every tick mutates
    // x/y/vx/vy on every node, and a deep reactive proxy would put a signal write
    // in the hot loop for values only the canvas reads. What the markup needs is
    // the counts, which are published as plain numbers when a graph is built.
    let nodes: Node[] = [];
    let edges: Edge[] = [];
    let clusters: Cluster[] = [];
    let neighbourIds = new Set<number>();

    let nodeCount = $state(0);
    let edgeCount = $state(0);
    let clusterCount = $state(0);

    // `$state.raw` for the same reason: these hold simulation nodes, and only
    // their (immutable) descriptive fields are rendered.
    let selected = $state.raw<Node | null>(null);
    let hovered = $state.raw<Node | null>(null);
    let selectedEdges = $state<{ dir: '→' | '←'; type: string; other: string; otherId: number }[]>([]);

    let width = 0;
    let height_px = 0;
    let view = { x: 0, y: 0, scale: 1 };
    let animFrame = 0;
    let alpha = 0;
    let dragNode: Node | null = null;
    let panning = false;
    let pointerMoved = false;
    let lastPointer = { x: 0, y: 0 };

    // ── Theme-resolved colours ─────────────────────────────────────────────
    // Canvas cannot read CSS classes, so every colour is resolved from the same
    // tokens the markup uses; re-read on each draw so the theme toggle applies
    // without a reload.
    const CATEGORY_SLUGS: Record<string, string> = {
        Technical: 'technical',
        Architecture: 'architecture',
        'Best Practice': 'practice',
        'Organizational Norm': 'norm'
    };
    function categorySlug(cat: string | null | undefined): string {
        return (cat && CATEGORY_SLUGS[cat]) || 'other';
    }
    const SANS = "'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif";

    function token(name: string): string {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#8a9a94';
    }
    function ink(name: string, alphaValue = 1): string {
        const hex = token(name);
        if (alphaValue >= 1) return hex;
        const n = hex.replace('#', '');
        const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
        return `rgba(${r}, ${g}, ${b}, ${alphaValue})`;
    }
    function catColor(cat: string | null, alphaValue = 1): string {
        return ink(`--cat-${categorySlug(cat)}`, alphaValue);
    }

    // ── Data loading ───────────────────────────────────────────────────────
    let loadToken = 0;
    async function load(resetView = true) {
        const mine = ++loadToken;
        loading = true;
        error = null;
        const params = new URLSearchParams();
        if (focusTopicId !== null) {
            params.set('focusTopicId', String(focusTopicId));
            params.set('depth', String(depth));
        } else {
            if (search.trim()) params.set('search', search.trim());
            if (category !== 'All') params.set('category', category);
            if (minClaims > 0) params.set('minClaims', String(minClaims));
        }
        params.set('maxNodes', String(maxNodes));

        try {
            const res = await fetch(`/api/knowledge/graph?${params}`);
            if (!res.ok) throw new Error(`Graph request failed (${res.status})`);
            const payload = await res.json() as {
                nodes: ApiNode[]; edges: ApiEdge[]; communities: ApiCommunity[]; meta: GraphMeta;
            };
            // A slower earlier request must not overwrite a newer result.
            if (mine !== loadToken) return;

            meta = payload.meta;
            communities = payload.communities;
            build(payload.nodes, payload.edges, payload.communities);
            focusName = focusTopicId !== null
                ? payload.nodes.find(n => n.id === focusTopicId)?.name ?? null
                : null;
            await tick();
            layout(resetView);
        } catch (e) {
            if (mine !== loadToken) return;
            error = (e as Error).message;
        } finally {
            if (mine === loadToken) loading = false;
        }
    }

    function build(apiNodes: ApiNode[], apiEdges: ApiEdge[], apiCommunities: ApiCommunity[]) {
        const byId = new Map<number, Node>();
        nodes = apiNodes.map(n => {
            const node: Node = {
                ...n,
                x: 0, y: 0, vx: 0, vy: 0,
                // sqrt scale: degree spans 1–200 in this corpus, and a linear
                // radius makes hubs swallow the canvas.
                radius: Math.max(5, Math.min(22, 4.5 + Math.sqrt(n.degree) * 2.4)),
                cluster: n.communityId ?? UNCLUSTERED,
                pinned: false
            };
            byId.set(n.id, node);
            return node;
        });

        edges = apiEdges
            .map(e => {
                const source = byId.get(e.source);
                const target = byId.get(e.target);
                if (!source || !target) return null;
                return { source, target, type: e.type, intra: source.cluster === target.cluster && source.cluster !== UNCLUSTERED };
            })
            .filter((e): e is Edge => e !== null);

        const titles = new Map(apiCommunities.map(c => [c.id, c.title]));
        const grouped = new Map<number, Node[]>();
        for (const n of nodes) {
            if (!grouped.has(n.cluster)) grouped.set(n.cluster, []);
            grouped.get(n.cluster)!.push(n);
        }
        clusters = [...grouped.entries()]
            .map(([key, members]) => ({
                key,
                title: key === UNCLUSTERED ? null : titles.get(key) ?? null,
                nodes: members,
                ax: 0, ay: 0, cx: 0, cy: 0,
                hull: [] as { x: number; y: number }[]
            }))
            .sort((a, b) => b.nodes.length - a.nodes.length);

        nodeCount = nodes.length;
        edgeCount = edges.length;
        clusterCount = clusters.filter(c => c.key !== UNCLUSTERED).length;

        if (selected && !byId.has(selected.id)) selected = null;
        else if (selected) selected = byId.get(selected.id)!;
        hovered = null;
        refreshSelectionDetail();
    }

    // ── Layout ─────────────────────────────────────────────────────────────
    /**
     * Two-level force layout.
     *
     * Level 1 places one point per cluster, using the *cluster* graph (edge count
     * between clusters as attraction, cluster size as repulsion). Level 2 lays out
     * nodes with their own cluster's centroid as a gravity well.
     *
     * The single-level layout this replaces had one global gravity well, which is
     * precisely the force that produces a hairball: with every node pulled to the
     * same point, the only thing separating groups is edge tension, and dense
     * corpora overwhelm it.
     */
    function layout(resetView = true) {
        if (!canvas || !wrapper) return;
        cancelAnimationFrame(animFrame);
        resize();
        if (nodes.length === 0) {
            draw();
            return;
        }

        layoutClusters();

        // Seed nodes on a ring around their cluster centre; a deterministic golden
        // -angle spiral rather than random jitter, so the same graph lays out the
        // same way twice (a layout that reshuffles on every redraw is unreadable).
        for (const cluster of clusters) {
            const r = clusterRadius(cluster);
            cluster.nodes.forEach((node, i) => {
                const angle = i * 2.39996;
                const spread = r * Math.sqrt((i + 0.5) / cluster.nodes.length);
                node.x = cluster.ax + Math.cos(angle) * spread;
                node.y = cluster.ay + Math.sin(angle) * spread;
                node.vx = 0;
                node.vy = 0;
            });
        }

        alpha = 1;
        if (resetView) view = { x: 0, y: 0, scale: 1 };
        run(resetView);
    }

    /**
     * Space reserved for a cluster, estimated from the area its own marks need
     * (Σ of node areas plus per-node breathing room) rather than from node count
     * alone. Node radii vary by a factor of four here, so a count-based estimate
     * under-reserves for hub-heavy clusters — and an under-reserved cluster is
     * one whose nodes spill over its neighbours, which is what the first version
     * of this layout did.
     */
    function clusterRadius(cluster: Cluster): number {
        const area = cluster.nodes.reduce((sum, n) => sum + (n.radius + 10) ** 2, 0);
        return Math.max(44, 1.32 * Math.sqrt(area));
    }

    /**
     * Empty space between two clusters' reserved circles. Must exceed twice the
     * hull inflation below, or the drawn outlines touch even though the circles do
     * not — measured on screen: at a 34px gap the regions read as one mass with
     * decorative lines through it, which is the problem this layout exists to fix.
     */
    const CLUSTER_GAP = 96;
    /** How far a hull outline sits outside its outermost node. */
    const HULL_PADDING = 22;

    function layoutClusters() {
        const between = new Map<string, number>();
        for (const e of edges) {
            if (e.source.cluster === e.target.cluster) continue;
            const a = Math.min(e.source.cluster, e.target.cluster);
            const b = Math.max(e.source.cluster, e.target.cluster);
            const key = `${a}:${b}`;
            between.set(key, (between.get(key) ?? 0) + 1);
        }

        // Seed on a circle ordered by size, largest first — a reproducible start
        // that already separates the big clusters.
        const cx = width / 2;
        const cy = height_px / 2;
        const ring = Math.min(width, height_px) * 0.32;
        clusters.forEach((cluster, i) => {
            const angle = (2 * Math.PI * i) / clusters.length;
            cluster.ax = cx + Math.cos(angle) * ring;
            cluster.ay = cy + Math.sin(angle) * ring;
        });
        if (clusters.length === 1) {
            clusters[0].ax = cx;
            clusters[0].ay = cy;
            return;
        }

        const byKey = new Map(clusters.map(c => [c.key, c]));
        const gap = CLUSTER_GAP;

        for (let iter = 0; iter < 500; iter++) {
            const cooling = 1 - iter / 500;

            // Separation: no two reserved circles may overlap.
            for (let i = 0; i < clusters.length; i++) {
                for (let j = i + 1; j < clusters.length; j++) {
                    const a = clusters[i], b = clusters[j];
                    let dx = b.ax - a.ax, dy = b.ay - a.ay;
                    let dist = Math.hypot(dx, dy) || 0.01;
                    const wanted = clusterRadius(a) + clusterRadius(b) + gap;
                    if (dist >= wanted) continue;
                    const push = ((wanted - dist) / dist) * 0.5;
                    a.ax -= dx * push; a.ay -= dy * push;
                    b.ax += dx * push; b.ay += dy * push;
                }
            }

            // Attraction along inter-cluster edge bundles — enough to put related
            // clusters near each other (so the lines between them are short and
            // readable), never enough to overcome the separation pass above.
            for (const [key, weight] of between) {
                const [aKey, bKey] = key.split(':').map(Number);
                const a = byKey.get(aKey), b = byKey.get(bKey);
                if (!a || !b) continue;
                const dx = b.ax - a.ax, dy = b.ay - a.ay;
                const dist = Math.hypot(dx, dy) || 0.01;
                const wanted = clusterRadius(a) + clusterRadius(b) + gap * 2;
                if (dist <= wanted) continue;
                const pull = ((dist - wanted) / dist) * Math.min(0.05, 0.01 * Math.log2(1 + weight)) * cooling;
                a.ax += dx * pull; a.ay += dy * pull;
                b.ax -= dx * pull; b.ay -= dy * pull;
            }

            // Keep the whole arrangement near the centre without collapsing it.
            for (const cluster of clusters) {
                cluster.ax += (cx - cluster.ax) * 0.003 * cooling;
                cluster.ay += (cy - cluster.ay) * 0.003 * cooling;
            }
        }

        // Final strict de-overlap: attraction and centring both ran last, so this
        // guarantees the invariant the node-level containment force depends on.
        for (let iter = 0; iter < 60; iter++) {
            let moved = false;
            for (let i = 0; i < clusters.length; i++) {
                for (let j = i + 1; j < clusters.length; j++) {
                    const a = clusters[i], b = clusters[j];
                    const dx = b.ax - a.ax, dy = b.ay - a.ay;
                    const dist = Math.hypot(dx, dy) || 0.01;
                    const wanted = clusterRadius(a) + clusterRadius(b) + gap;
                    if (dist >= wanted) continue;
                    const push = ((wanted - dist) / dist) * 0.51;
                    a.ax -= dx * push; a.ay -= dy * push;
                    b.ax += dx * push; b.ay += dy * push;
                    moved = true;
                }
            }
            if (!moved) break;
        }

        // Seed the drawn centroid so the first frame has a sane label position.
        for (const cluster of clusters) {
            cluster.cx = cluster.ax;
            cluster.cy = cluster.ay;
        }
    }

    /**
     * Node-level relaxation. Repulsion uses a uniform grid so cost is
     * proportional to node count rather than its square — the old all-pairs loop
     * ran 300 iterations of O(n²) on the main thread for every filter change.
     */
    function step() {
        const CELL = 70;
        const grid = new Map<string, Node[]>();
        const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
        for (const n of nodes) {
            const key = cellKey(n.x, n.y);
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key)!.push(n);
        }

        for (const node of nodes) {
            const gx = Math.floor(node.x / CELL);
            const gy = Math.floor(node.y / CELL);
            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    const bucket = grid.get(`${gx + ox}:${gy + oy}`);
                    if (!bucket) continue;
                    for (const other of bucket) {
                        if (other === node) continue;
                        let dx = node.x - other.x;
                        let dy = node.y - other.y;
                        let distSq = dx * dx + dy * dy;
                        if (distSq > CELL * CELL) continue;
                        if (distSq < 0.01) {
                            // Exactly coincident nodes have no direction to separate
                            // along; nudge deterministically by identity.
                            dx = (node.id % 7) - 3 || 1;
                            dy = (node.id % 5) - 2 || 1;
                            distSq = dx * dx + dy * dy;
                        }
                        const dist = Math.sqrt(distSq);
                        const minGap = node.radius + other.radius + 10;
                        // Strong below the touching distance (marks must stay
                        // countable), weak above it (clusters must stay compact, or
                        // containment does all the work and nodes pile on the
                        // boundary).
                        const force = (dist < minGap ? 95 : 22) * alpha / dist;
                        node.vx += (dx / dist) * force;
                        node.vy += (dy / dist) * force;
                    }
                }
            }
        }

        for (const e of edges) {
            const dx = e.target.x - e.source.x;
            const dy = e.target.y - e.source.y;
            const dist = Math.hypot(dx, dy) || 0.01;
            // Intra-cluster edges are held short so a cluster reads as a unit;
            // inter-cluster edges are long, so the lines *between* clusters are
            // visible as connections instead of being buried inside a mass.
            const rest = e.intra ? 52 : 150;
            const stiffness = e.intra ? 0.06 : 0.02;
            const force = (dist - rest) * stiffness * alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            if (!e.source.pinned) { e.source.vx += fx; e.source.vy += fy; }
            if (!e.target.pinned) { e.target.vx -= fx; e.target.vy -= fy; }
        }

        // Cluster gravity plus containment — the forces that keep groups apart.
        //
        // Gravity alone (the first version of this) is not enough: repulsion inside
        // a dense cluster wins, the cluster inflates past the space reserved for it,
        // and neighbouring clusters interleave — which looks like one hairball with
        // decorative outlines. Containment makes the reserved circle a hard
        // boundary, so cluster separation is a property of the layout rather than
        // an outcome of force balance.
        for (const cluster of clusters) {
            for (const node of cluster.nodes) {
                if (node.pinned) continue;
                node.vx += (cluster.ax - node.x) * 0.02 * alpha;
                node.vy += (cluster.ay - node.y) * 0.02 * alpha;
            }
        }

        for (const node of nodes) {
            if (node.pinned) continue;
            node.vx *= 0.82;
            node.vy *= 0.82;
            // Cap displacement per tick: an unbounded impulse on a dense graph
            // flings nodes off-canvas before the layout can settle.
            const speed = Math.hypot(node.vx, node.vy);
            const max = 18;
            if (speed > max) {
                node.vx = (node.vx / speed) * max;
                node.vy = (node.vy / speed) * max;
            }
            node.x += node.vx;
            node.y += node.vy;
        }

        // Containment, applied after integration so a node is never left outside
        // its cluster's reserved circle at draw time. Gravity alone is not enough:
        // repulsion inside a dense cluster wins, the cluster inflates past the
        // space reserved for it, and neighbouring clusters interleave — which looks
        // like one hairball with decorative outlines around it. With the cluster
        // circles guaranteed non-overlapping (see layoutClusters), a hard boundary
        // here makes cluster separation a property of the layout rather than an
        // outcome of force balance.
        for (const cluster of clusters) {
            const bound = clusterRadius(cluster);
            for (const node of cluster.nodes) {
                if (node.pinned) continue;
                const dx = node.x - cluster.ax;
                const dy = node.y - cluster.ay;
                const dist = Math.hypot(dx, dy);
                const limit = Math.max(12, bound - node.radius);
                if (dist > limit) {
                    const scale = limit / dist;
                    node.x = cluster.ax + dx * scale;
                    node.y = cluster.ay + dy * scale;
                    // Bleed off the outward velocity, or the node bounces along the
                    // boundary for the rest of the run.
                    node.vx *= 0.35;
                    node.vy *= 0.35;
                }
            }
        }

        alpha *= 0.975;
    }

    function run(fitAfter = true) {
        let iterations = 0;
        const total = 320;
        function frame() {
            const budgetStart = performance.now();
            // Several relaxation steps per frame, bounded by time so a large graph
            // still animates rather than freezing the tab.
            while (iterations < total && performance.now() - budgetStart < 12) {
                step();
                iterations++;
            }
            computeHulls();
            draw();
            if (iterations < total) {
                animFrame = requestAnimationFrame(frame);
            } else if (fitAfter) {
                fitToView();
            }
        }
        animFrame = requestAnimationFrame(frame);
    }

    // ── Cluster hulls ──────────────────────────────────────────────────────
    /** Andrew's monotone chain. */
    function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
        if (points.length < 3) return points;
        const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
        const cross = (o: any, a: any, b: any) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
        const lower: any[] = [];
        for (const p of sorted) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper: any[] = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
            const p = sorted[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        return lower.slice(0, -1).concat(upper.slice(0, -1));
    }

    function computeHulls() {
        for (const cluster of clusters) {
            let sx = 0, sy = 0;
            for (const n of cluster.nodes) { sx += n.x; sy += n.y; }
            cluster.cx = sx / cluster.nodes.length;
            cluster.cy = sy / cluster.nodes.length;

            if (cluster.nodes.length < 3 || cluster.key === UNCLUSTERED) {
                cluster.hull = [];
                continue;
            }
            const hull = convexHull(cluster.nodes.map(n => ({ x: n.x, y: n.y })));
            // Inflate away from the centroid so the outline clears the marks.
            cluster.hull = hull.map(p => {
                const dx = p.x - cluster.cx;
                const dy = p.y - cluster.cy;
                const d = Math.hypot(dx, dy) || 1;
                return { x: p.x + (dx / d) * HULL_PADDING, y: p.y + (dy / d) * HULL_PADDING };
            });
        }
    }

    // ── Rendering ──────────────────────────────────────────────────────────
    function resize() {
        if (!canvas || !wrapper) return;
        // Back the canvas at device resolution: the previous version drew at CSS
        // pixel size, so every label and circle was resampled and soft.
        const dpr = window.devicePixelRatio || 1;
        width = wrapper.clientWidth;
        height_px = wrapper.clientHeight || 520;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height_px * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height_px}px`;
    }

    function fitToView() {
        if (nodes.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            minX = Math.min(minX, n.x - n.radius);
            minY = Math.min(minY, n.y - n.radius);
            maxX = Math.max(maxX, n.x + n.radius);
            maxY = Math.max(maxY, n.y + n.radius);
        }
        const pad = 48;
        const scale = Math.min(
            (width - pad * 2) / Math.max(1, maxX - minX),
            (height_px - pad * 2) / Math.max(1, maxY - minY)
        );
        // "Reset view" used to just set scale 1 / offset 0, which on a graph laid
        // out around its own centroid could leave the whole thing off-screen.
        view.scale = Math.max(0.15, Math.min(2.2, scale));
        view.x = width / 2 - ((minX + maxX) / 2) * view.scale;
        view.y = height_px / 2 - ((minY + maxY) / 2) * view.scale;
        draw();
    }

    function draw() {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height_px);
        ctx.save();
        ctx.translate(view.x, view.y);
        ctx.scale(view.scale, view.scale);

        const focusNode = hovered ?? selected;
        const surface = token('--bg-surface');

        drawHulls(ctx);
        drawEdges(ctx, focusNode);
        drawNodes(ctx, focusNode, surface);

        ctx.restore();
        drawHud(ctx);
    }

    function drawHulls(ctx: CanvasRenderingContext2D) {
        // Clusters are drawn as soft neutral regions with a label, which is what
        // carries group identity here (see the note at the top of this file on why
        // it is position-and-label rather than a per-cluster hue).
        for (const cluster of clusters) {
            if (cluster.hull.length < 3) continue;
            ctx.beginPath();
            const hull = cluster.hull;
            // Rounded outline: move through edge midpoints with the vertices as
            // control points, so the region reads as a blob rather than a polygon.
            const mid = (a: any, b: any) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            let start = mid(hull[hull.length - 1], hull[0]);
            ctx.moveTo(start.x, start.y);
            for (let i = 0; i < hull.length; i++) {
                const current = hull[i];
                const next = hull[(i + 1) % hull.length];
                const m = mid(current, next);
                ctx.quadraticCurveTo(current.x, current.y, m.x, m.y);
            }
            ctx.closePath();
            ctx.fillStyle = ink('--bg-muted', 0.35);
            ctx.fill();
            ctx.strokeStyle = ink('--line', 0.7);
            ctx.setLineDash([5, 6]);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);

            if (cluster.title && view.scale > 0.34) {
                const top = cluster.hull.reduce((a, b) => (b.y < a.y ? b : a));
                ctx.font = `600 ${11 / view.scale > 16 ? 16 : 11}px ${SANS}`;
                ctx.fillStyle = ink('--text-faint');
                ctx.textAlign = 'center';
                ctx.fillText(truncate(cluster.title, 42), cluster.cx, top.y - 8);
            }
        }
    }

    function drawEdges(ctx: CanvasRenderingContext2D, focusNode: Node | null) {
        for (const e of edges) {
            const isActive = focusNode !== null && (e.source.id === focusNode.id || e.target.id === focusNode.id);
            const dimmed = focusNode !== null && !isActive;
            if (dimmed && view.scale < 0.5) continue; // declutter when zoomed out

            const dx = e.target.x - e.source.x;
            const dy = e.target.y - e.source.y;
            const dist = Math.hypot(dx, dy) || 1;
            // A gentle arc separates the two directions of a reciprocal pair and
            // keeps parallel bundles from overprinting as one thick smear.
            const bow = Math.min(26, dist * 0.12);
            const mx = (e.source.x + e.target.x) / 2 - (dy / dist) * bow;
            const my = (e.source.y + e.target.y) / 2 + (dx / dist) * bow;

            ctx.beginPath();
            ctx.moveTo(e.source.x, e.source.y);
            ctx.quadraticCurveTo(mx, my, e.target.x, e.target.y);
            ctx.strokeStyle = isActive
                ? ink('--accent-quiet', 0.95)
                : dimmed
                  ? ink('--line', 0.28)
                  // Inter-cluster edges are the long ones and the informative
                  // ones ("this cluster governs that one"), so they are drawn at
                  // least as strongly as the short intra-cluster links.
                  : ink('--line-strong', e.intra ? 0.5 : 0.62);
            ctx.lineWidth = isActive ? 2 : 1;
            ctx.stroke();

            // Arrowheads only where direction is actually being read: on the
            // highlighted neighbourhood, or when zoomed in far enough to see them.
            if (isActive || view.scale > 1.25) {
                const t = 0.86;
                const px = (1 - t) * (1 - t) * e.source.x + 2 * (1 - t) * t * mx + t * t * e.target.x;
                const py = (1 - t) * (1 - t) * e.source.y + 2 * (1 - t) * t * my + t * t * e.target.y;
                const angle = Math.atan2(e.target.y - py, e.target.x - px);
                const tipX = e.target.x - Math.cos(angle) * (e.target.radius + 2);
                const tipY = e.target.y - Math.sin(angle) * (e.target.radius + 2);
                const len = isActive ? 9 : 6;
                ctx.fillStyle = ctx.strokeStyle as string;
                ctx.beginPath();
                ctx.moveTo(tipX, tipY);
                ctx.lineTo(tipX - len * Math.cos(angle - 0.42), tipY - len * Math.sin(angle - 0.42));
                ctx.lineTo(tipX - len * Math.cos(angle + 0.42), tipY - len * Math.sin(angle + 0.42));
                ctx.closePath();
                ctx.fill();
            }

            if (isActive && view.scale > 0.55) {
                ctx.font = `500 9px ${SANS}`;
                ctx.fillStyle = ink('--text-muted');
                ctx.textAlign = 'center';
                ctx.fillText(e.type.replace(/_/g, ' '), mx, my - 4);
            }
        }
    }

    function drawNodes(ctx: CanvasRenderingContext2D, focusNode: Node | null, surface: string) {
        // Hubs are labelled by default; everything else earns a label by being
        // hovered, selected, or adjacent to the focus.
        const labelThreshold = (() => {
            const degrees = nodes.map(n => n.degree).sort((a, b) => b - a);
            const cap = Math.min(nodes.length, view.scale > 1.1 ? 40 : 16);
            return degrees[cap - 1] ?? 0;
        })();

        for (const node of nodes) {
            const isFocus = focusNode?.id === node.id;
            const isNeighbour = focusNode !== null && neighbourIds.has(node.id);
            const dimmed = focusNode !== null && !isFocus && !isNeighbour;
            const contextOnly = !node.matched;

            if (isFocus) {
                const glow = ctx.createRadialGradient(node.x, node.y, node.radius, node.x, node.y, node.radius * 3);
                glow.addColorStop(0, catColor(node.category, 0.32));
                glow.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.radius * 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // In an ego view, emphasis follows hop distance — the focus is solid,
            // its direct neighbours nearly so, the second ring recedes. Flat
            // "matched vs context" shading there made everything except the one
            // focused node look equally unimportant.
            const baseAlpha =
                node.hop === null
                    ? contextOnly ? 0.3 : 0.8
                    : node.hop === 0 ? 0.9 : node.hop === 1 ? 0.68 : 0.32;
            const fillAlpha = dimmed ? 0.14 : baseAlpha;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            ctx.fillStyle = catColor(node.category, fillAlpha);
            ctx.fill();
            // Surface-coloured ring so overlapping nodes stay countable in dense
            // regions; the accent ring marks the selection.
            ctx.lineWidth = isFocus ? 2.5 : 1.5;
            ctx.strokeStyle = isFocus ? ink('--accent') : dimmed ? ink('--bg-surface', 0.5) : surface;
            ctx.stroke();

            if (node.hop === 0) {
                // The focused topic of an ego view: a second ring, so it stays
                // identifiable after the user selects something else.
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
                ctx.strokeStyle = ink('--accent', 0.75);
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            const wantsLabel =
                isFocus || isNeighbour || node.hop === 0 || (!dimmed && node.degree >= labelThreshold);
            if (wantsLabel && view.scale > 0.3) {
                const size = isFocus ? 12 : 10.5;
                ctx.font = `${isFocus ? '600 ' : ''}${size}px ${SANS}`;
                ctx.textAlign = 'center';
                const label = truncate(node.name, isFocus ? 40 : 24);
                // Halo, so a label crossing an edge or another node stays readable.
                ctx.lineWidth = 3;
                ctx.strokeStyle = ink('--bg-surface', 0.85);
                ctx.strokeText(label, node.x, node.y + node.radius + 13);
                ctx.fillStyle = isFocus ? ink('--text-strong') : ink('--text-secondary');
                ctx.fillText(label, node.x, node.y + node.radius + 13);
            }
        }
    }

    function drawHud(ctx: CanvasRenderingContext2D) {
        if (!hovered) return;
        const lines = [
            hovered.name,
            `${hovered.category ?? 'Uncategorized'} · ${hovered.claimCount} claim${hovered.claimCount === 1 ? '' : 's'} · ` +
                `${hovered.degree} of ${hovered.totalDegree} relationship${hovered.totalDegree === 1 ? '' : 's'} shown`
        ];
        ctx.font = `600 12.5px ${SANS}`;
        const w = Math.max(ctx.measureText(lines[0]).width, 240) + 24;
        ctx.font = `11px ${SANS}`;
        const w2 = ctx.measureText(lines[1]).width + 24;
        const boxW = Math.min(Math.max(w, w2), width - 24);
        const boxH = 52;
        const x = 12;
        const y = height_px - boxH - 12;

        ctx.fillStyle = token('--bg-raised');
        ctx.strokeStyle = ink('--line');
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, boxW, boxH, 12);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = ink('--text-strong');
        ctx.font = `600 12.5px ${SANS}`;
        ctx.fillText(truncate(lines[0], 46), x + 12, y + 21);
        ctx.fillStyle = ink('--text-muted');
        ctx.font = `11px ${SANS}`;
        ctx.fillText(lines[1], x + 12, y + 39);
    }

    function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function truncate(s: string, n: number): string {
        return s.length > n ? `${s.slice(0, n)}…` : s;
    }

    // ── Interaction ────────────────────────────────────────────────────────
    function toWorld(clientX: number, clientY: number) {
        const rect = canvas!.getBoundingClientRect();
        return {
            x: (clientX - rect.left - view.x) / view.scale,
            y: (clientY - rect.top - view.y) / view.scale
        };
    }

    function nodeAt(clientX: number, clientY: number): Node | null {
        const { x, y } = toWorld(clientX, clientY);
        // Reverse order: later-drawn nodes sit on top, so they should be hit first.
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if (Math.hypot(n.x - x, n.y - y) <= n.radius + 5 / view.scale) return n;
        }
        return null;
    }

    function refreshSelectionDetail() {
        neighbourIds = new Set();
        const target = hovered ?? selected;
        if (!target) {
            selectedEdges = [];
            return;
        }
        const rows: typeof selectedEdges = [];
        for (const e of edges) {
            if (e.source.id === target.id) {
                neighbourIds.add(e.target.id);
                rows.push({ dir: '→', type: e.type, other: e.target.name, otherId: e.target.id });
            } else if (e.target.id === target.id) {
                neighbourIds.add(e.source.id);
                rows.push({ dir: '←', type: e.type, other: e.source.name, otherId: e.source.id });
            }
        }
        selectedEdges = rows;
    }

    function onPointerDown(event: PointerEvent) {
        if (!canvas) return;
        canvas.setPointerCapture(event.pointerId);
        pointerMoved = false;
        const hit = nodeAt(event.clientX, event.clientY);
        if (hit) {
            dragNode = hit;
            hit.pinned = true;
        } else {
            panning = true;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
    }

    function onPointerMove(event: PointerEvent) {
        if (!canvas) return;
        if (Math.abs(event.clientX - lastPointer.x) + Math.abs(event.clientY - lastPointer.y) > 3) {
            pointerMoved = true;
        }

        if (dragNode) {
            const { x, y } = toWorld(event.clientX, event.clientY);
            dragNode.x = x;
            dragNode.y = y;
            dragNode.vx = 0;
            dragNode.vy = 0;
            // Let the neighbourhood settle around the dragged node.
            alpha = Math.max(alpha, 0.25);
            computeHulls();
            draw();
            return;
        }

        if (panning) {
            view.x += event.clientX - lastPointer.x;
            view.y += event.clientY - lastPointer.y;
            lastPointer = { x: event.clientX, y: event.clientY };
            draw();
            return;
        }

        const hit = nodeAt(event.clientX, event.clientY);
        if (hit?.id !== hovered?.id) {
            hovered = hit;
            refreshSelectionDetail();
            canvas.style.cursor = hit ? 'pointer' : 'grab';
            draw();
        }
    }

    function onPointerUp(event: PointerEvent) {
        if (dragNode) {
            dragNode.pinned = false;
            if (!pointerMoved) {
                selected = dragNode;
                refreshSelectionDetail();
            }
            dragNode = null;
            // Resume relaxation so the graph re-settles after a drag.
            cancelAnimationFrame(animFrame);
            run(false);
        } else if (panning && !pointerMoved) {
            selected = null;
            refreshSelectionDetail();
            draw();
        }
        panning = false;
        canvas?.releasePointerCapture?.(event.pointerId);
    }

    function onWheel(event: WheelEvent) {
        event.preventDefault();
        const rect = canvas!.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const previous = view.scale;
        view.scale = Math.max(0.15, Math.min(3, view.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
        view.x = mx - (mx - view.x) * (view.scale / previous);
        view.y = my - (my - view.y) * (view.scale / previous);
        draw();
    }

    function zoomBy(factor: number) {
        const previous = view.scale;
        view.scale = Math.max(0.15, Math.min(3, view.scale * factor));
        view.x = width / 2 - (width / 2 - view.x) * (view.scale / previous);
        view.y = height_px / 2 - (height_px / 2 - view.y) * (view.scale / previous);
        draw();
    }

    // ── Control changes ────────────────────────────────────────────────────
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    function onSearchInput() {
        if (searchTimer) clearTimeout(searchTimer);
        // Debounced: each keystroke would otherwise re-run selection and a full
        // relayout.
        searchTimer = setTimeout(() => {
            focusTopicId = null;
            load();
        }, 280);
    }

    function focusNeighbourhood(node: Node) {
        focusTopicId = node.id;
        selected = null;
        load();
    }

    function clearFocus() {
        focusTopicId = null;
        load();
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    function onResize() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => layout(true), 150);
    }

    onMount(() => {
        load();
        const observer = new ResizeObserver(onResize);
        if (wrapper) observer.observe(wrapper);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(animFrame);
            if (searchTimer) clearTimeout(searchTimer);
            if (resizeTimer) clearTimeout(resizeTimer);
        };
    });

    const detailTarget = $derived(selected ?? null);
</script>

<svelte:window onresize={onResize} />

<div class="card overflow-hidden flex flex-col">
    <!-- Controls -->
    <div class="border-b border-line-subtle p-3 flex flex-wrap items-center gap-2">
        <div class="relative min-w-[210px] flex-1 max-w-xs">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
            <input
                type="text"
                bind:value={search}
                oninput={onSearchInput}
                placeholder="Find a topic…"
                class="field pl-9 pr-8 text-xs"
                disabled={focusTopicId !== null}
            />
            {#if search}
                <button
                    onclick={() => { search = ''; focusTopicId = null; load(); }}
                    class="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-body"
                    aria-label="Clear search"
                >×</button>
            {/if}
        </div>

        <label class="flex items-center gap-1.5">
            <span class="eyebrow">Category</span>
            <select
                bind:value={category}
                onchange={() => { focusTopicId = null; load(); }}
                class="field w-auto text-xs py-1.5"
                disabled={focusTopicId !== null}
            >
                <option value="All">All</option>
                {#each categories as cat}
                    <option value={cat}>{cat}</option>
                {/each}
            </select>
        </label>

        <label class="flex items-center gap-2">
            <span class="eyebrow whitespace-nowrap">Min claims {minClaims}</span>
            <input
                type="range" min="0" max="10"
                bind:value={minClaims}
                onchange={() => { focusTopicId = null; load(); }}
                class="w-16 accent-[var(--accent-quiet)] cursor-pointer"
                disabled={focusTopicId !== null}
            />
        </label>

        <label class="flex items-center gap-1.5">
            <span class="eyebrow whitespace-nowrap">Nodes</span>
            <select bind:value={maxNodes} onchange={() => load()} class="field w-auto text-xs py-1.5">
                <option value={60}>60</option>
                <option value={90}>90</option>
                <option value={150}>150</option>
                <option value={300}>300</option>
                <option value={600}>600</option>
            </select>
        </label>

        {#if focusTopicId !== null}
            <label class="flex items-center gap-1.5">
                <span class="eyebrow whitespace-nowrap">Hops</span>
                <select bind:value={depth} onchange={() => load()} class="field w-auto text-xs py-1.5">
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                </select>
            </label>
            <button onclick={clearFocus} class="btn btn-secondary btn-sm">
                <X class="w-3.5 h-3.5" />
                Exit focus{focusName ? `: ${truncate(focusName, 22)}` : ''}
            </button>
        {/if}

        <div class="ml-auto flex items-center gap-1.5">
            <button onclick={() => zoomBy(1.2)} class="btn btn-secondary btn-icon" aria-label="Zoom in" title="Zoom in">+</button>
            <button onclick={() => zoomBy(1 / 1.2)} class="btn btn-secondary btn-icon" aria-label="Zoom out" title="Zoom out">−</button>
            <button onclick={fitToView} class="btn btn-secondary btn-icon" aria-label="Fit to view" title="Fit to view">
                <Maximize2 class="w-3.5 h-3.5" />
            </button>
            <button onclick={() => layout(true)} class="btn btn-secondary btn-icon" aria-label="Re-run layout" title="Re-run layout">
                <RotateCcw class="w-3.5 h-3.5" />
            </button>
        </div>
    </div>

    <!-- Canvas -->
    <div class="relative bg-well" bind:this={wrapper} style="height: {height};">
        <canvas
            bind:this={canvas}
            class="absolute inset-0 cursor-grab touch-none"
            onpointerdown={onPointerDown}
            onpointermove={onPointerMove}
            onpointerup={onPointerUp}
            onpointercancel={onPointerUp}
            onwheel={onWheel}
        ></canvas>

        <!-- Legend -->
        <div class="absolute top-3 left-3 bg-surface/95 border border-line rounded-xl px-3 py-2 flex flex-col gap-1.5 pointer-events-none">
            <div class="flex flex-wrap gap-x-3 gap-y-1">
                {#each [
                    { label: 'Technical', cat: 'technical' },
                    { label: 'Architecture', cat: 'architecture' },
                    { label: 'Best practice', cat: 'practice' },
                    { label: 'Org norm', cat: 'norm' },
                    { label: 'Other', cat: 'other' }
                ] as item}
                    <span class="flex items-center gap-1.5 text-xs text-mute" data-cat={item.cat}>
                        <span class="w-2 h-2 rounded-full" style="background: var(--cat)"></span>
                        {item.label}
                    </span>
                {/each}
            </div>
            <p class="text-[10.5px] text-faint leading-tight max-w-[260px]">
                Dashed regions are clusters the corpus forms on its own; node size is how
                many relationships it has here.
            </p>
        </div>

        {#if loading}
            <div class="absolute inset-0 flex items-center justify-center bg-well/70">
                <span class="flex items-center gap-2 text-[13px] text-mute">
                    <Loader2 class="w-4 h-4 animate-spin" />
                    Building graph…
                </span>
            </div>
        {:else if error}
            <div class="absolute inset-0 flex items-center justify-center">
                <p class="text-[13px] text-danger">{error}</p>
            </div>
        {:else if nodeCount === 0}
            <div class="absolute inset-0 flex items-center justify-center px-6">
                <p class="text-[13px] text-mute text-center max-w-sm">
                    No connected topics match these filters. Relationships are what this view
                    draws, so a topic with none of them appears in the Topics tab rather than here.
                </p>
            </div>
        {/if}

        <!-- Detail panel -->
        {#if detailTarget}
            <div class="absolute bottom-3 right-3 w-72 bg-surface border border-line rounded-2xl shadow-xl p-4 flex flex-col gap-3">
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <h4 class="text-sm font-semibold text-strong break-words">{detailTarget.name}</h4>
                        <span class="tag-cat mt-1.5" data-cat={categorySlug(detailTarget.category)}>
                            {detailTarget.category ?? 'Uncategorized'}
                        </span>
                    </div>
                    <button onclick={() => { selected = null; refreshSelectionDetail(); draw(); }}
                        class="btn btn-ghost btn-icon flex-shrink-0" aria-label="Close details">
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>

                <div class="flex items-center gap-3 text-xs text-mute">
                    <span class="flex items-center gap-1.5"><FileCheck class="w-3.5 h-3.5" />{detailTarget.claimCount} claims</span>
                    <span class="flex items-center gap-1.5">
                        <GitBranch class="w-3.5 h-3.5" />
                        {detailTarget.degree} of {detailTarget.totalDegree} shown
                    </span>
                </div>

                <div class="max-h-40 overflow-y-auto pr-1 space-y-1 border-t border-line-subtle pt-2">
                    {#each selectedEdges as row}
                        <p class="text-[11px] text-faint leading-snug">
                            {row.dir}
                            <span class="text-accent">{row.type.replace(/_/g, ' ')}</span>
                            {row.other}
                        </p>
                    {:else}
                        <p class="text-[11px] text-faint">No relationships in the current view.</p>
                    {/each}
                </div>

                <div class="pt-1 flex gap-2">
                    {#if focusTopicId === detailTarget.id}
                        <button onclick={clearFocus} class="btn btn-secondary btn-sm flex-1">Exit focus</button>
                    {:else}
                        <button onclick={() => focusNeighbourhood(detailTarget)} class="btn btn-primary btn-sm flex-1">
                            <Crosshair class="w-3.5 h-3.5" />
                            Focus
                        </button>
                    {/if}
                    {#if onViewClaims}
                        <button onclick={() => onViewClaims?.(detailTarget.id, detailTarget.name)} class="btn btn-secondary btn-sm flex-1">
                            Claims
                        </button>
                    {/if}
                </div>
            </div>
        {/if}
    </div>

    <!-- Status line: what is on screen, and what deliberately is not -->
    {#if meta}
        <div class="border-t border-line-subtle px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-faint tabular-nums">
            <span>{nodeCount} topics · {edgeCount} relationships shown</span>
            {#if clusterCount > 1}
                <span>{clusterCount} clusters</span>
            {/if}
            {#if meta.omittedByLimit > 0}
                <span>{meta.omittedByLimit} more match — raise “Nodes” or filter further</span>
            {/if}
            {#if meta.droppedUnconnected > 0}
                <span>{meta.droppedUnconnected} hidden: no relationship to anything else shown</span>
            {/if}
            {#if meta.isolatedTopics > 0}
                <span>{meta.isolatedTopics} of {meta.totalTopics} topics have no relationships at all</span>
            {/if}
        </div>
    {/if}
</div>
