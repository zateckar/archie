<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { 
        Database, 
        Network, 
        FileCheck, 
        AlertTriangle, 
        Search, 
        Filter, 
        ArrowRight, 
        Tag,
        BookOpen,
        Activity,
        ChevronRight,
        ChevronLeft,
        RefreshCw,
        GitBranch,
        Layers
    } from 'lucide-svelte';
    import { fade, slide, fly } from 'svelte/transition';

    interface Topic { id: number; name: string; description: string; category: string; }
    interface Claim { id: number; topic_id: number; topic_name: string; claim_text: string; status: string; doc_name: string; doc_id: number; }
    interface Relationship { id: number; source_topic_id: number; target_topic_id: number; relationship_type: string; }
    let data = $state<{ topics: Topic[]; relationships: Relationship[]; claims: Claim[] }>({ topics: [], relationships: [], claims: [] });
    let loading = $state(true);
    let topicFilter = $state<string | null>(null);
    let searchQuery = $state('');
    let selectedCategory = $state('All');
    let activeTab = $state('topics'); // 'topics', 'claims', 'graph'

    const categories = ['All', 'Technical', 'Architecture', 'Best Practice', 'Organizational Norm'];

    // ── Graph Visualization States ──
    interface GraphNode {
        id: number;
        name: string;
        category: string;
        x: number;
        y: number;
        vx: number;
        vy: number;
        radius: number;
        claimCount: number;
        relCount: number;
        pinned: boolean;
    }

    interface GraphEdge {
        source: GraphNode;
        target: GraphNode;
        type: string;
    }

    let canvas = $state<HTMLCanvasElement | undefined>(undefined);
    let graphNodes = $state<GraphNode[]>([]);
    let graphEdges = $state<GraphEdge[]>([]);
    let hoveredNode = $state<GraphNode | null>(null);
    let selectedNode = $state<GraphNode | null>(null);
    let animFrame = 0;
    let isDragging = false;
    let dragNode: GraphNode | null = null;
    let panOffset = { x: 0, y: 0 };
    let zoom = 1;
    let lastMouse = { x: 0, y: 0 };
    let isPanning = false;

    // Graph specific filter caps
    let minClaims = $state(0);
    let maxNodesLimit = $state(100);
    let focusedNodeId = $state<number | null>(null);

    onMount(async () => {
        await loadKnowledge();
    });

    // Clear focused node if user types in search
    $effect(() => {
        if (searchQuery) {
            focusedNodeId = null;
        }
    });

    async function loadKnowledge() {
        loading = true;
        try {
            const res = await fetch('/api/knowledge');
            if (res.ok) {
                data = await res.json();
                await tick();
                if (activeTab === 'graph') initGraph(true);
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
        }
    }

    // ── Graph Visualization (Force-Directed with Filtering and Neighborhood Focus) ──
    function initGraph(resetCamera = false) {
        if (!canvas || data.topics.length === 0) return;

        // Stop any existing animation
        if (animFrame) cancelAnimationFrame(animFrame);

        const w = canvas.width = canvas.parentElement!.clientWidth;
        const h = canvas.height = canvas.parentElement!.clientHeight || 500;

        // Calculate claims count and relation count for ALL topics first, to help with filtering/sorting
        const allClaimCounts = new Map<number, number>();
        const allRelCounts = new Map<number, number>();
        for (const t of data.topics) {
            allClaimCounts.set(t.id, 0);
            allRelCounts.set(t.id, 0);
        }
        for (const c of data.claims) {
            allClaimCounts.set(c.topic_id, (allClaimCounts.get(c.topic_id) || 0) + 1);
        }
        for (const r of data.relationships) {
            allRelCounts.set(r.source_topic_id, (allRelCounts.get(r.source_topic_id) || 0) + 1);
            allRelCounts.set(r.target_topic_id, (allRelCounts.get(r.target_topic_id) || 0) + 1);
        }

        let visibleTopics = [...data.topics];

        // Apply filters
        if (focusedNodeId !== null) {
            const neighbors = new Set<number>();
            neighbors.add(focusedNodeId);
            for (const r of data.relationships) {
                if (r.source_topic_id === focusedNodeId) {
                    neighbors.add(r.target_topic_id);
                }
                if (r.target_topic_id === focusedNodeId) {
                    neighbors.add(r.source_topic_id);
                }
            }
            visibleTopics = visibleTopics.filter(t => neighbors.has(t.id));
        } else {
            // Filter by search query (shared from main search input)
            if (searchQuery.trim()) {
                const query = searchQuery.toLowerCase().trim();
                const matchedTopicIds = new Set<number>();
                for (const t of visibleTopics) {
                    if (
                        t.name.toLowerCase().includes(query) ||
                        (t.description && t.description.toLowerCase().includes(query)) ||
                        (t.category && t.category.toLowerCase().includes(query))
                    ) {
                        matchedTopicIds.add(t.id);
                    }
                }

                // If number of matched topics is small, also show their 1-hop neighbors for context
                if (matchedTopicIds.size > 0 && matchedTopicIds.size < 25) {
                    const expandedSet = new Set<number>(matchedTopicIds);
                    for (const r of data.relationships) {
                        if (matchedTopicIds.has(r.source_topic_id)) {
                            expandedSet.add(r.target_topic_id);
                        }
                        if (matchedTopicIds.has(r.target_topic_id)) {
                            expandedSet.add(r.source_topic_id);
                        }
                    }
                    visibleTopics = visibleTopics.filter(t => expandedSet.has(t.id));
                } else {
                    visibleTopics = visibleTopics.filter(t => matchedTopicIds.has(t.id));
                }
            }

            // Filter by category (shared from main category buttons)
            if (selectedCategory !== 'All') {
                visibleTopics = visibleTopics.filter(t => t.category === selectedCategory);
            }

            // Filter by min claims
            if (minClaims > 0) {
                visibleTopics = visibleTopics.filter(t => (allClaimCounts.get(t.id) || 0) >= minClaims);
            }

            // Sort by importance: total relationships + claims count descending, and apply max limit
            visibleTopics.sort((a, b) => {
                const scoreA = (allRelCounts.get(a.id) || 0) * 2 + (allClaimCounts.get(a.id) || 0);
                const scoreB = (allRelCounts.get(b.id) || 0) * 2 + (allClaimCounts.get(b.id) || 0);
                return scoreB - scoreA;
            });

            if (visibleTopics.length > maxNodesLimit) {
                visibleTopics = visibleTopics.slice(0, maxNodesLimit);
            }
        }

        // Create nodes
        const nodeMap = new Map<number, GraphNode>();
        graphNodes = visibleTopics.map((t, i) => {
            const angle = (2 * Math.PI * i) / visibleTopics.length;
            const r = Math.min(w, h) * 0.35;
            const claimCount = allClaimCounts.get(t.id) || 0;
            const relCount = allRelCounts.get(t.id) || 0;
            const node: GraphNode = {
                id: t.id,
                name: t.name,
                category: t.category || 'Unknown',
                x: w / 2 + r * Math.cos(angle) + (Math.random() - 0.5) * 40,
                y: h / 2 + r * Math.sin(angle) + (Math.random() - 0.5) * 40,
                vx: 0, vy: 0,
                radius: Math.max(8, Math.min(24, 8 + claimCount * 2 + relCount)),
                claimCount,
                relCount,
                pinned: false
            };
            nodeMap.set(t.id, node);
            return node;
        });

        // Create edges (only keep relationships between visible nodes)
        graphEdges = data.relationships
            .filter(r => nodeMap.has(r.source_topic_id) && nodeMap.has(r.target_topic_id))
            .map(r => ({
                source: nodeMap.get(r.source_topic_id)!,
                target: nodeMap.get(r.target_topic_id)!,
                type: r.relationship_type
            }));

        // Reset pan/zoom if requested
        if (resetCamera) {
            panOffset = { x: 0, y: 0 };
            zoom = 1;
        }

        // If previously selected node is no longer visible, deselect it
        if (selectedNode && !nodeMap.has(selectedNode.id)) {
            selectedNode = null;
        }

        // Start simulation
        runSimulation();
    }

    function runSimulation() {
        let iteration = 0;
        const maxIterations = 300;

        function step() {
            if (!canvas) return;
            const w = canvas.width;
            const h = canvas.height;

            // Force simulation
            const alpha = Math.max(0.001, 1 - iteration / maxIterations);

            // Repulsion with distance threshold (nodes push each other apart)
            const maxRepulsionDistance = 350;
            for (let i = 0; i < graphNodes.length; i++) {
                for (let j = i + 1; j < graphNodes.length; j++) {
                    const a = graphNodes[i], b = graphNodes[j];
                    let dx = b.x - a.x, dy = b.y - a.y;
                    let distSq = dx * dx + dy * dy;
                    if (distSq > maxRepulsionDistance * maxRepulsionDistance) continue; // Skip far-away nodes
                    
                    let dist = Math.sqrt(distSq) || 1;
                    const force = (180 * alpha) / dist;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
                    if (!b.pinned) { b.vx += fx; b.vy += fy; }
                }
            }

            // Attraction (edges pull connected nodes together)
            for (const edge of graphEdges) {
                const dx = edge.target.x - edge.source.x;
                const dy = edge.target.y - edge.source.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const force = (dist - 120) * 0.03 * alpha;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                if (!edge.source.pinned) { edge.source.vx += fx; edge.source.vy += fy; }
                if (!edge.target.pinned) { edge.target.vx -= fx; edge.target.vy -= fy; }
            }

            // Center gravity
            for (const node of graphNodes) {
                if (node.pinned) continue;
                node.vx += (w / 2 - node.x) * 0.001 * alpha;
                node.vy += (h / 2 - node.y) * 0.001 * alpha;
                node.vx *= 0.9;
                node.vy *= 0.9;
                node.x += node.vx;
                node.y += node.vy;
                // Keep in bounds
                node.x = Math.max(node.radius, Math.min(w - node.radius, node.x));
                node.y = Math.max(node.radius, Math.min(h - node.radius, node.y));
            }

            drawGraph();
            iteration++;

            if (iteration < maxIterations || isDragging) {
                animFrame = requestAnimationFrame(step);
            }
        }

        step();
    }

    function drawGraph() {
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        const w = canvas.width, h = canvas.height;

        ctx.save();
        ctx.clearRect(0, 0, w, h);

        // Apply pan and zoom
        ctx.translate(panOffset.x, panOffset.y);
        ctx.scale(zoom, zoom);

        // Draw edges
        for (const edge of graphEdges) {
            const isHighlighted = selectedNode && (edge.source.id === selectedNode.id || edge.target.id === selectedNode.id);
            ctx.strokeStyle = isHighlighted ? 'rgba(34, 211, 238, 0.6)' : 'rgba(100, 116, 139, 0.2)';
            ctx.lineWidth = isHighlighted ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(edge.source.x, edge.source.y);
            ctx.lineTo(edge.target.x, edge.target.y);
            ctx.stroke();

            // Draw arrow
            const dx = edge.target.x - edge.source.x;
            const dy = edge.target.y - edge.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                const ratio = (dist - edge.target.radius - 4) / dist;
                const ax = edge.source.x + dx * ratio;
                const ay = edge.source.y + dy * ratio;
                const angle = Math.atan2(dy, dx);
                const arrowLen = isHighlighted ? 10 : 6;
                ctx.fillStyle = ctx.strokeStyle;
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(ax - arrowLen * Math.cos(angle - 0.4), ay - arrowLen * Math.sin(angle - 0.4));
                ctx.lineTo(ax - arrowLen * Math.cos(angle + 0.4), ay - arrowLen * Math.sin(angle + 0.4));
                ctx.closePath();
                ctx.fill();
            }

            // Edge label (only when highlighted)
            if (isHighlighted) {
                const mx = (edge.source.x + edge.target.x) / 2;
                const my = (edge.source.y + edge.target.y) / 2;
                ctx.font = '9px JetBrains Mono, monospace';
                ctx.fillStyle = 'rgba(34, 211, 238, 0.8)';
                ctx.textAlign = 'center';
                ctx.fillText(edge.type.replace(/_/g, ' '), mx, my - 6);
            }
        }

        // Draw nodes
        for (const node of graphNodes) {
            const isSelected = selectedNode?.id === node.id;
            const isHovered = hoveredNode?.id === node.id;
            const isConnected = selectedNode !== null && graphEdges.some(e =>
                (e.source.id === selectedNode!.id && e.target.id === node.id) ||
                (e.target.id === selectedNode!.id && e.source.id === node.id)
            );
            const dimmed = selectedNode && !isSelected && !isConnected;

            // Node glow
            if (isSelected || isHovered) {
                const gradient = ctx.createRadialGradient(node.x, node.y, node.radius, node.x, node.y, node.radius * 2.5);
                gradient.addColorStop(0, getCategoryGlow(node.category, 0.3));
                gradient.addColorStop(1, 'transparent');
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.radius * 2.5, 0, Math.PI * 2);
                ctx.fill();
            }

            // Node circle
            ctx.fillStyle = dimmed ? 'rgba(30, 30, 30, 0.5)' : getCategoryColorCanvas(node.category);
            ctx.strokeStyle = isSelected ? '#22d3ee' : (dimmed ? 'rgba(50,50,50,0.3)' : 'rgba(255,255,255,0.1)');
            ctx.lineWidth = isSelected ? 2.5 : 1;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Node label (optimized for density and zoom)
            if (!dimmed || isConnected) {
                const shouldDrawLabel = graphNodes.length <= 150 || isSelected || isHovered || isConnected || zoom > 0.8 || node.claimCount > 3;
                if (shouldDrawLabel) {
                    ctx.font = `${isSelected ? 'bold ' : ''}${Math.max(9, 11 - graphNodes.length * 0.05)}px Inter, system-ui, sans-serif`;
                    ctx.fillStyle = dimmed ? 'rgba(148, 163, 184, 0.4)' : 'rgba(226, 232, 240, 0.9)';
                    ctx.textAlign = 'center';
                    ctx.fillText(truncate(node.name, 18), node.x, node.y + node.radius + 14);
                }
            }
        }

        ctx.restore();

        // HUD: hovered node info
        if (hoveredNode) {
            const padding = 12;
            const infoX = 16, infoY = h - 80;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.strokeStyle = 'rgba(34, 211, 238, 0.3)';
            ctx.lineWidth = 1;
            roundRect(ctx, infoX, infoY, 280, 64, 12);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#22d3ee';
            ctx.font = 'bold 13px Inter, system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(hoveredNode.name, infoX + padding, infoY + 22);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '11px JetBrains Mono, monospace';
            ctx.fillText(`${hoveredNode.category} · ${hoveredNode.claimCount} claims · ${hoveredNode.relCount} relationships`, infoX + padding, infoY + 44);
        }
    }

    function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // ── Canvas Interaction ──
    function screenToWorld(cx: number, cy: number) {
        return {
            x: (cx - panOffset.x) / zoom,
            y: (cy - panOffset.y) / zoom
        };
    }

    function handleMouseDown(e: MouseEvent) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

        // Check if clicking a node
        for (const node of graphNodes) {
            const dx = node.x - x, dy = node.y - y;
            if (Math.sqrt(dx * dx + dy * dy) < node.radius + 4) {
                isDragging = true;
                dragNode = node;
                node.pinned = true;
                selectedNode = node;
                runSimulation();
                return;
            }
        }
        // Start panning
        isPanning = true;
        lastMouse = { x: e.clientX, y: e.clientY };
        selectedNode = null;
        drawGraph();
    }

    function handleMouseMove(e: MouseEvent) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();

        if (isDragging && dragNode) {
            const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
            dragNode.x = x;
            dragNode.y = y;
            drawGraph();
            return;
        }

        if (isPanning) {
            panOffset.x += e.clientX - lastMouse.x;
            panOffset.y += e.clientY - lastMouse.y;
            lastMouse = { x: e.clientX, y: e.clientY };
            drawGraph();
            return;
        }

        // Hover detection
        const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        let found: GraphNode | null = null;
        for (const node of graphNodes) {
            const dx = node.x - x, dy = node.y - y;
            if (Math.sqrt(dx * dx + dy * dy) < node.radius + 4) {
                found = node;
                break;
            }
        }
        if (found !== hoveredNode) {
            hoveredNode = found;
            canvas.style.cursor = found ? 'pointer' : 'grab';
            drawGraph();
        }
    }

    function handleMouseUp() {
        if (dragNode) {
            dragNode.pinned = false;
            dragNode = null;
        }
        isDragging = false;
        isPanning = false;
    }

    function handleWheel(e: WheelEvent) {
        if (!canvas) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const oldZoom = zoom;
        zoom *= e.deltaY > 0 ? 0.92 : 1.08;
        zoom = Math.max(0.2, Math.min(3, zoom));

        // Zoom toward mouse position
        panOffset.x = mx - (mx - panOffset.x) * (zoom / oldZoom);
        panOffset.y = my - (my - panOffset.y) * (zoom / oldZoom);

        drawGraph();
    }

    // ── Color Helpers ──
    function getCategoryColorCanvas(cat: string): string {
        switch (cat) {
            case 'Technical': return 'rgba(34, 211, 238, 0.3)';
            case 'Architecture': return 'rgba(192, 132, 252, 0.3)';
            case 'Best Practice': return 'rgba(52, 211, 153, 0.3)';
            case 'Organizational Norm': return 'rgba(251, 191, 36, 0.3)';
            default: return 'rgba(100, 116, 139, 0.3)';
        }
    }

    function getCategoryGlow(cat: string, alpha: number): string {
        switch (cat) {
            case 'Technical': return `rgba(34, 211, 238, ${alpha})`;
            case 'Architecture': return `rgba(192, 132, 252, ${alpha})`;
            case 'Best Practice': return `rgba(52, 211, 153, ${alpha})`;
            case 'Organizational Norm': return `rgba(251, 191, 36, ${alpha})`;
            default: return `rgba(100, 116, 139, ${alpha})`;
        }
    }

    function getCategoryCss(cat: string): string {
        switch (cat) {
            case 'Technical': return 'text-cyan-400 border-cyan-400/30 bg-cyan-400/5';
            case 'Architecture': return 'text-purple-400 border-purple-400/30 bg-purple-400/5';
            case 'Best Practice': return 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5';
            case 'Organizational Norm': return 'text-amber-400 border-amber-400/30 bg-amber-400/5';
            default: return 'text-slate-400 border-slate-400/30 bg-slate-400/5';
        }
    }

    function truncate(s: string, n: number): string {
        return s.length > n ? s.slice(0, n) + '…' : s;
    }

    // ── Tab switch: re-init graph when switching to graph tab ──
    $effect(() => {
        if (activeTab === 'graph' && !loading && data.topics.length > 0) {
            tick().then(() => initGraph());
        }
    });

    // Handle resize
    function handleResize() {
        if (activeTab === 'graph' && canvas) {
            initGraph();
        }
    }

    let filteredTopics = $derived(
        data.topics.filter(t => 
            (selectedCategory === 'All' || t.category === selectedCategory) &&
            (t.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
             t.description.toLowerCase().includes(searchQuery.toLowerCase()))
        )
    );

    let filteredClaims = $derived(
        data.claims.filter(c => 
            (topicFilter === null || c.topic_name === topicFilter) &&
            (c.claim_text.toLowerCase().includes(searchQuery.toLowerCase()) ||
             c.topic_name.toLowerCase().includes(searchQuery.toLowerCase()))
        )
    );

    function getCategoryColor(category: string) {
        switch (category) {
            case 'Technical': return 'text-cyan-400 border-cyan-400/30 bg-cyan-400/5';
            case 'Architecture': return 'text-purple-400 border-purple-400/30 bg-purple-400/5';
            case 'Best Practice': return 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5';
            case 'Organizational Norm': return 'text-amber-400 border-amber-400/30 bg-amber-400/5';
            default: return 'text-slate-400 border-slate-400/30 bg-slate-400/5';
        }
    }
</script>

<style>
    :global(body) {
        background-color: #050505;
        color: #e2e8f0;
        font-family: 'Inter', system-ui, sans-serif;
    }

    .mono {
        font-family: 'JetBrains Mono', monospace;
    }

    .glass {
        background: rgba(15, 15, 15, 0.7);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .neon-glow-cyan {
        box-shadow: 0 0 20px rgba(34, 211, 238, 0.1);
    }

    .neon-glow-purple {
        box-shadow: 0 0 20px rgba(192, 132, 252, 0.1);
    }

    .card-hover {
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .card-hover:hover {
        transform: translateY(-4px);
        border-color: rgba(255, 255, 255, 0.15);
        background: rgba(25, 25, 25, 0.8);
    }
</style>

<svelte:window onresize={handleResize} />

<div class="min-h-screen p-6 md:p-12 max-w-7xl mx-auto">
    <!-- Navigation -->
    <nav class="mb-8">
        <a href="/" class="inline-flex items-center gap-2 text-slate-500 hover:text-[#78FAAE] transition-colors group">
            <ChevronLeft class="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            <span class="text-xs font-bold uppercase tracking-widest">Back to Chat</span>
        </a>
    </nav>

    <!-- Header -->
    <header class="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
            <div class="flex items-center gap-3 mb-4">
                <div class="p-2 bg-cyan-500/10 rounded-xl border border-cyan-500/20">
                    <Network class="w-6 h-6 text-cyan-400" />
                </div>
                <span class="mono text-xs uppercase tracking-[0.2em] text-cyan-500/70 font-bold">Semantic Layer</span>
            </div>
            <h1 class="text-5xl font-black tracking-tight text-white mb-2">
                Knowledge <span class="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-500">Graph</span>
            </h1>
            <p class="text-slate-400 max-w-xl text-lg leading-relaxed">
                Structured, interconnected IT knowledge extracted from your documents. 
                Maintained for accuracy and consistency.
            </p>
        </div>

        <div class="flex bg-slate-900/50 p-1 rounded-2xl border border-slate-800">
            <button 
                onclick={() => activeTab = 'topics'}
                class="px-6 py-2 rounded-xl text-sm font-bold transition-all {activeTab === 'topics' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-400 hover:text-white'}"
            >
                Topics
            </button>
            <button 
                onclick={() => activeTab = 'claims'}
                class="px-6 py-2 rounded-xl text-sm font-bold transition-all {activeTab === 'claims' ? 'bg-purple-500 text-white shadow-lg shadow-purple-500/20' : 'text-slate-400 hover:text-white'}"
            >
                Claims
            </button>
            <button 
                onclick={() => activeTab = 'graph'}
                class="px-6 py-2 rounded-xl text-sm font-bold transition-all {activeTab === 'graph' ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-white'}"
            >
                Graph View
            </button>
        </div>
    </header>

    <!-- Search & Filters -->
    {#if activeTab !== 'graph'}
        <div class="flex flex-col md:flex-row gap-4 mb-8" transition:slide>
            <div class="relative flex-1 group">
                <Search class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500 group-focus-within:text-cyan-400 transition-colors" />
                <input 
                    type="text" 
                    bind:value={searchQuery}
                    placeholder="Search the knowledge base..."
                    class="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-cyan-500/50 transition-all placeholder:text-slate-600"
                />
            </div>
            
            <div class="flex gap-2 overflow-x-auto pb-2 md:pb-0">
                {#each categories as cat}
                    <button 
                        onclick={() => selectedCategory = cat}
                        class="px-4 py-2 rounded-xl border text-sm font-medium whitespace-nowrap transition-all
                        {selectedCategory === cat ? 'bg-white text-black border-white' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}"
                    >
                        {cat}
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    {#if loading}
        <div class="flex flex-col items-center justify-center py-24 gap-4" in:fade>
            <div class="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin"></div>
            <p class="mono text-sm text-cyan-500 animate-pulse">Synthesizing Knowledge...</p>
        </div>
    {:else}
        {#if activeTab === 'topics'}
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" in:fade>
                {#each filteredTopics as topic}
                    <div class="glass p-6 rounded-3xl card-hover flex flex-col gap-4 relative overflow-hidden group">
                        <!-- Category Badge -->
                        <div class="flex justify-between items-start">
                            <span class="mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-md border {getCategoryColor(topic.category)}">
                                {topic.category}
                            </span>
                            <div class="flex -space-x-2">
                                <div class="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-400">
                                    {data.relationships.filter(r => r.source_topic_id === topic.id || r.target_topic_id === topic.id).length}
                                </div>
                            </div>
                        </div>

                        <div>
                            <h3 class="text-xl font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">{topic.name}</h3>
                            <p class="text-slate-400 text-sm leading-relaxed line-clamp-3">
                                {topic.description}
                            </p>
                        </div>

                        <div class="mt-auto pt-4 border-t border-slate-800/50 flex items-center justify-between">
                            <div class="flex items-center gap-2 text-xs text-slate-500">
                                <FileCheck class="w-3 h-3" />
                                <span>{data.claims.filter(c => c.topic_id === topic.id).length} Claims</span>
                            </div>
                            <button 
                                onclick={() => { activeTab = 'claims'; topicFilter = topic.name; }}
                                class="text-cyan-500 hover:text-cyan-400 transition-colors"
                            >
                                <ChevronRight class="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                {/each}
            </div>
        {:else if activeTab === 'claims'}
            <div class="space-y-4" in:fade>
                {#if topicFilter}
                    <div class="flex items-center justify-between bg-purple-500/10 border border-purple-500/20 p-4 rounded-2xl mb-6" in:slide>
                        <div class="flex items-center gap-3">
                            <Tag class="w-5 h-5 text-purple-400" />
                            <div>
                                <p class="text-[10px] mono uppercase text-purple-500 font-bold">Filtering by Topic</p>
                                <p class="text-white font-bold">{topicFilter}</p>
                            </div>
                        </div>
                        <button 
                            onclick={() => topicFilter = null}
                            class="px-4 py-2 bg-purple-500 hover:bg-purple-400 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-purple-500/20"
                        >
                            Clear Filter
                        </button>
                    </div>
                {/if}
                {#each filteredClaims as claim}
                    <div class="glass p-6 rounded-2xl card-hover flex flex-col md:flex-row gap-6 items-start md:items-center">
                        <div class="flex-1">
                            <div class="flex items-center gap-3 mb-2">
                                <span class="mono text-[10px] uppercase tracking-wider text-purple-400 bg-purple-400/10 px-2 py-0.5 rounded border border-purple-400/20">
                                    {claim.topic_name}
                                </span>
                                {#if claim.status === 'conflicting'}
                                    <span class="flex items-center gap-1 mono text-[10px] uppercase tracking-wider text-red-400 bg-red-400/10 px-2 py-0.5 rounded border border-red-400/20">
                                        <AlertTriangle class="w-3 h-3" /> Conflict
                                    </span>
                                {/if}
                            </div>
                            <p class="text-slate-200 text-lg font-medium leading-relaxed">
                                {claim.claim_text}
                            </p>
                        </div>
                        
                        <div class="flex flex-col items-end gap-1 min-w-[150px]">
                            <span class="text-[10px] mono text-slate-500 uppercase">Source</span>
                            <span class="text-xs text-slate-400 bg-slate-800/50 px-2 py-1 rounded border border-slate-700 truncate max-w-[200px]">
                                {claim.doc_name}
                            </span>
                        </div>
                    </div>
                {/each}
            </div>
        {:else if activeTab === 'graph'}
            <div class="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden relative flex flex-col" in:fade>
                <!-- Controls/Filters Bar -->
                <div class="border-b border-slate-800/80 bg-slate-950/60 p-4 flex flex-wrap items-center justify-between gap-4 z-10 relative">
                    <div class="flex flex-wrap items-center gap-4">
                        <!-- Search Input (bound to shared searchQuery) -->
                        <div class="relative min-w-[220px]">
                            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                            <input
                                type="text"
                                bind:value={searchQuery}
                                oninput={() => initGraph()}
                                placeholder="Search topic name/desc..."
                                class="w-full pl-9 pr-8 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all"
                            />
                            {#if searchQuery}
                                <button onclick={() => { searchQuery = ''; initGraph(); }} class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-sm font-bold">×</button>
                            {/if}
                        </div>

                        <!-- Category Filter (bound to shared selectedCategory) -->
                        <div class="flex items-center gap-1.5">
                            <span class="text-[10px] font-mono uppercase text-slate-500">Category:</span>
                            <select
                                bind:value={selectedCategory}
                                onchange={() => initGraph()}
                                class="bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
                            >
                                <option value="All">All Categories</option>
                                {#each categories.filter(c => c !== 'All') as cat}
                                    <option value={cat}>{cat}</option>
                                {/each}
                            </select>
                        </div>

                        <!-- Min Claims Slider -->
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-mono uppercase text-slate-500 min-w-[90px]">Min Claims: {minClaims}</span>
                            <input
                                type="range"
                                min="0"
                                max="10"
                                bind:value={minClaims}
                                oninput={() => initGraph()}
                                class="w-20 accent-cyan-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                            />
                        </div>

                        <!-- Max Nodes Dropdown -->
                        <div class="flex items-center gap-1.5">
                            <span class="text-[10px] font-mono uppercase text-slate-500">Max Nodes:</span>
                            <select
                                bind:value={maxNodesLimit}
                                onchange={() => initGraph()}
                                class="bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
                            >
                                <option value={50}>50</option>
                                <option value={100}>100 (Default)</option>
                                <option value={200}>200</option>
                                <option value={500}>500</option>
                                <option value={10000}>All ({data.topics.length})</option>
                            </select>
                        </div>
                    </div>

                    <div class="flex items-center gap-3">
                        {#if focusedNodeId !== null}
                            <button
                                onclick={() => { focusedNodeId = null; initGraph(); }}
                                class="px-2.5 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/40 rounded-xl text-xs font-semibold transition-all"
                            >
                                Clear Focus
                            </button>
                        {/if}
                        <span class="text-xs font-mono text-slate-400">
                            Showing <strong class="text-cyan-400">{graphNodes.length}</strong> / {data.topics.length} nodes
                        </span>
                    </div>
                </div>

                <div class="relative flex-1 w-full overflow-hidden">
                    <!-- Legend -->
                    <div class="absolute top-4 left-4 z-10 bg-black/80 backdrop-blur-sm border border-slate-800 rounded-xl p-3 flex flex-wrap gap-3 text-[10px] font-mono uppercase tracking-wider">
                        {#each [
                            { label: 'Technical', color: 'bg-cyan-400' },
                            { label: 'Architecture', color: 'bg-purple-400' },
                            { label: 'Best Practice', color: 'bg-emerald-400' },
                            { label: 'Org Norm', color: 'bg-amber-400' }
                        ] as item}
                            <span class="flex items-center gap-1.5 text-slate-400">
                                <span class="w-2.5 h-2.5 rounded-full {item.color}"></span>
                                {item.label}
                            </span>
                        {/each}
                    </div>

                    <!-- Zoom controls -->
                    <div class="absolute top-4 right-4 z-10 flex flex-col gap-1">
                        <button onclick={() => { zoom = Math.min(3, zoom * 1.2); drawGraph(); }}
                            class="w-8 h-8 bg-black/80 border border-slate-700 rounded-lg text-slate-400 hover:text-white flex items-center justify-center text-lg font-bold">+</button>
                        <button onclick={() => { zoom = Math.max(0.2, zoom * 0.8); drawGraph(); }}
                            class="w-8 h-8 bg-black/80 border border-slate-700 rounded-lg text-slate-400 hover:text-white flex items-center justify-center text-lg font-bold">−</button>
                        <button onclick={() => initGraph(true)}
                            class="w-8 h-8 bg-black/80 border border-slate-700 rounded-lg text-slate-400 hover:text-white flex items-center justify-center text-xs" title="Reset Camera">⟲</button>
                    </div>

                    <!-- Selected node details -->
                    {#if selectedNode}
                        <div class="absolute bottom-4 right-4 z-10 w-72 bg-black/90 backdrop-blur-sm border border-cyan-500/30 rounded-2xl p-4 flex flex-col gap-3" transition:slide>
                            <div>
                                <h4 class="text-white font-bold text-sm mb-1.5">{selectedNode.name}</h4>
                                <span class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border {getCategoryCss(selectedNode.category)}">
                                    {selectedNode.category}
                                </span>
                            </div>
                            
                            <div class="space-y-1 text-xs text-slate-400">
                                <p class="font-semibold text-slate-300">{selectedNode.claimCount} claims · {selectedNode.relCount} relationships</p>
                                <div class="max-h-36 overflow-y-auto pr-1 space-y-1">
                                    {#each graphEdges.filter(e => e.source.id === selectedNode?.id || e.target.id === selectedNode?.id) as edge}
                                        <p class="text-[11px] text-slate-500 leading-tight">
                                            {edge.source.id === selectedNode?.id ? '→' : '←'}
                                            <span class="text-cyan-400/70">{edge.type.replace(/_/g, ' ')}</span>
                                            {edge.source.id === selectedNode?.id ? edge.target.name : edge.source.name}
                                        </p>
                                    {/each}
                                </div>
                            </div>

                            <div class="pt-2 border-t border-slate-800 flex gap-2">
                                {#if focusedNodeId === selectedNode.id}
                                    <button
                                        onclick={() => { focusedNodeId = null; initGraph(); }}
                                        class="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-all"
                                    >
                                        Unfocus Node
                                    </button>
                                {:else}
                                    <button
                                        onclick={() => { focusedNodeId = selectedNode!.id; initGraph(); }}
                                        class="flex-1 py-1.5 px-3 bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl text-xs font-semibold transition-all"
                                    >
                                        Focus Neighborhood
                                    </button>
                                {/if}
                            </div>
                        </div>
                    {/if}

                    <div class="w-full" style="height: 520px;">
                        <canvas
                            bind:this={canvas}
                            onmousedown={handleMouseDown}
                            onmousemove={handleMouseMove}
                            onmouseup={handleMouseUp}
                            onmouseleave={handleMouseUp}
                            onwheel={handleWheel}
                            class="w-full h-full cursor-grab"
                            style="background: radial-gradient(circle at 50% 50%, rgba(15,23,42,1) 0%, rgba(5,5,5,1) 100%);"
                        ></canvas>
                    </div>
                </div>
            </div>
        {/if}
    {/if}
</div>
