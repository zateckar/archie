<script lang="ts">
    import { onMount, tick } from 'svelte';
    import {
        Network, AlertTriangle, CheckCircle, XCircle, ChevronDown, ChevronRight,
        Trash2, Eye, Tag, FileCheck, Activity, Layers, GitBranch, Search, Filter, RefreshCw,
        Wand2, Loader2
    } from 'lucide-svelte';
    import { fade, slide } from 'svelte/transition';

    // ── State ──
    let data = $state<{ topics: any[]; relationships: any[]; claims: any[] }>({ topics: [], relationships: [], claims: [] });
    let loading = $state(true);
    let activeTab = $state<'graph' | 'conflicts' | 'hierarchy'>('graph');
    let searchQuery = $state('');

    // Graph state
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

    // Conflict resolution state
    let conflictGroups = $derived(buildConflictGroups());
    let expandedConflict = $state<number | null>(null);
    let resolving = $state<number | null>(null);
    let rebuildingTaxonomy = $state(false);
    let taxonomyResult = $state<{ total: number; updated: number } | null>(null);
    let backfillingEmbeddings = $state(false);
    let backfillResult = $state<{ topicsEmbedded: number; claimsEmbedded: number } | null>(null);

    // Topic hierarchy
    let hierarchyTree = $derived(buildHierarchy());

    // Stats
    let stats = $derived({
        topics: data.topics.length,
        relationships: data.relationships.length,
        claims: data.claims.length,
        conflicts: data.claims.filter(c => c.status === 'conflicting').length,
        categories: [...new Set(data.topics.map(t => t.category).filter(Boolean))].length
    });

    // ── Types ──
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

    // ── Data Loading ──
    onMount(async () => {
        await loadKnowledge();
    });

    async function loadKnowledge() {
        loading = true;
        try {
            const res = await fetch('/api/knowledge');
            if (res.ok) {
                data = await res.json();
                await tick();
                if (activeTab === 'graph') initGraph();
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
        }
    }

    // ── Graph Visualization (Force-Directed) ──
    function initGraph() {
        if (!canvas || data.topics.length === 0) return;

        // Stop any existing animation
        if (animFrame) cancelAnimationFrame(animFrame);

        const w = canvas.width = canvas.parentElement!.clientWidth;
        const h = canvas.height = canvas.parentElement!.clientHeight || 500;

        // Create nodes
        const nodeMap = new Map<number, GraphNode>();
        graphNodes = data.topics.map((t, i) => {
            const angle = (2 * Math.PI * i) / data.topics.length;
            const r = Math.min(w, h) * 0.3;
            const claimCount = data.claims.filter(c => c.topic_id === t.id).length;
            const relCount = data.relationships.filter(rel => rel.source_topic_id === t.id || rel.target_topic_id === t.id).length;
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

        // Create edges
        graphEdges = data.relationships
            .filter(r => nodeMap.has(r.source_topic_id) && nodeMap.has(r.target_topic_id))
            .map(r => ({
                source: nodeMap.get(r.source_topic_id)!,
                target: nodeMap.get(r.target_topic_id)!,
                type: r.relationship_type
            }));

        // Reset pan/zoom
        panOffset = { x: 0, y: 0 };
        zoom = 1;

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

            // Repulsion (nodes push each other apart)
            for (let i = 0; i < graphNodes.length; i++) {
                for (let j = i + 1; j < graphNodes.length; j++) {
                    const a = graphNodes[i], b = graphNodes[j];
                    let dx = b.x - a.x, dy = b.y - a.y;
                    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = (200 * alpha) / dist;
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
            ctx.fillStyle = dimmed ? 'rgba(30, 30, 30, 0.5)' : getCategoryColor(node.category);
            ctx.strokeStyle = isSelected ? '#22d3ee' : (dimmed ? 'rgba(50,50,50,0.3)' : 'rgba(255,255,255,0.1)');
            ctx.lineWidth = isSelected ? 2.5 : 1;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Node label
            if (!dimmed || isConnected) {
                ctx.font = `${isSelected ? 'bold ' : ''}${Math.max(9, 11 - graphNodes.length * 0.05)}px Inter, system-ui, sans-serif`;
                ctx.fillStyle = dimmed ? 'rgba(148, 163, 184, 0.4)' : 'rgba(226, 232, 240, 0.9)';
                ctx.textAlign = 'center';
                ctx.fillText(truncate(node.name, 18), node.x, node.y + node.radius + 14);
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
    function getCategoryColor(cat: string): string {
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

    // ── Conflict Resolution ──
    function buildConflictGroups() {
        const conflicting = data.claims.filter(c => c.status === 'conflicting');
        const groups = new Map<number, { topic: any; conflicting: any[]; active: any[] }>();

        for (const c of conflicting) {
            if (!groups.has(c.topic_id)) {
                const topic = data.topics.find(t => t.id === c.topic_id);
                const active = data.claims.filter(ac => ac.topic_id === c.topic_id && ac.status === 'active');
                groups.set(c.topic_id, { topic, conflicting: [], active });
            }
            groups.get(c.topic_id)!.conflicting.push(c);
        }
        return Array.from(groups.values());
    }

    async function resolveConflict(claimId: number, action: 'accept' | 'reject' | 'dismiss') {
        resolving = claimId;
        try {
            const res = await fetch('/api/knowledge', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ claimId, action })
            });
            if (res.ok) {
                await loadKnowledge();
            }
        } catch (err) {
            console.error(err);
        } finally {
            resolving = null;
        }
    }

    async function triggerTaxonomyRebuild() {
        rebuildingTaxonomy = true;
        taxonomyResult = null;
        try {
            const res = await fetch('/api/knowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'rebuild-taxonomy' })
            });
            if (res.ok) {
                const result = await res.json();
                taxonomyResult = { total: result.total, updated: result.updated };
                await loadKnowledge();
            }
        } catch (err) {
            console.error(err);
        } finally {
            rebuildingTaxonomy = false;
        }
    }

    async function triggerBackfill() {
        backfillingEmbeddings = true;
        backfillResult = null;
        try {
            const res = await fetch('/api/knowledge/backfill', { method: 'POST' });
            if (res.ok) {
                backfillResult = await res.json();
                await loadKnowledge();
            }
        } catch (err) {
            console.error(err);
        } finally {
            backfillingEmbeddings = false;
        }
    }

    // ── Topic Hierarchy ──
    interface HierarchyNode {
        topic: any;
        children: HierarchyNode[];
        depth: number;
        expanded: boolean;
    }

    let expandedHierarchyNodes = $state(new Set<number>());

    function buildHierarchy(): { roots: HierarchyNode[]; categorized: Map<string, any[]> } {
        // Group by category as a pseudo-hierarchy
        const categorized = new Map<string, any[]>();
        for (const t of data.topics) {
            const cat = t.category || 'Uncategorized';
            if (!categorized.has(cat)) categorized.set(cat, []);
            categorized.get(cat)!.push(t);
        }

        // Build actual parent-child tree from parent_topic_id
        const childMap = new Map<number | null, any[]>();
        for (const t of data.topics) {
            const parentId = t.parent_topic_id ?? null;
            if (!childMap.has(parentId)) childMap.set(parentId, []);
            childMap.get(parentId)!.push(t);
        }

        function buildNode(topic: any, depth: number): HierarchyNode {
            const children = (childMap.get(topic.id) || []).map((c: any) => buildNode(c, depth + 1));
            return { topic, children, depth, expanded: expandedHierarchyNodes.has(topic.id) };
        }

        const roots = (childMap.get(null) || []).map((t: any) => buildNode(t, 0));
        return { roots, categorized };
    }

    function toggleHierarchyNode(id: number) {
        if (expandedHierarchyNodes.has(id)) {
            expandedHierarchyNodes.delete(id);
        } else {
            expandedHierarchyNodes.add(id);
        }
        expandedHierarchyNodes = new Set(expandedHierarchyNodes);
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
</script>

<svelte:window onresize={handleResize} />

<div class="p-8">
    <!-- Header -->
    <header class="mb-8 flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div>
            <div class="flex items-center gap-3 mb-3">
                <div class="p-2 bg-cyan-500/10 rounded-xl border border-cyan-500/20">
                    <Network class="w-6 h-6 text-cyan-400" />
                </div>
                <span class="font-mono text-xs uppercase tracking-[0.2em] text-cyan-500/70 font-bold">Knowledge Management</span>
            </div>
            <h1 class="text-3xl font-bold text-white mb-1">Knowledge Graph</h1>
            <p class="text-slate-400">Visualize, manage, and resolve knowledge conflicts.</p>
        </div>

        <div class="flex items-center gap-3">
            <button
                onclick={loadKnowledge}
                class="p-2 rounded-xl border border-slate-800 hover:border-cyan-500/50 text-slate-400 hover:text-cyan-400 transition-all"
                title="Refresh"
            >
                <RefreshCw class="w-5 h-5 {loading ? 'animate-spin' : ''}" />
            </button>
            <button
                onclick={triggerTaxonomyRebuild}
                disabled={rebuildingTaxonomy}
                class="px-4 py-2 rounded-xl border border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 transition-all text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                title="LLM analyzes all topics and builds an optimal hierarchy"
            >
                {#if rebuildingTaxonomy}
                    <Loader2 class="w-4 h-4 animate-spin" /> Rebuilding...
                {:else}
                    <Wand2 class="w-4 h-4" /> Rebuild Taxonomy
                {/if}
            </button>
            <button
                onclick={triggerBackfill}
                disabled={backfillingEmbeddings}
                class="px-4 py-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-300 transition-all text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                title="Generate embeddings for topics and claims that are missing them"
            >
                {#if backfillingEmbeddings}
                    <Loader2 class="w-4 h-4 animate-spin" /> Backfilling...
                {:else}
                    <RefreshCw class="w-4 h-4" /> Backfill Embeddings
                {/if}
            </button>
            <a
                href="/knowledge"
                class="px-4 py-2 rounded-xl border border-slate-800 text-slate-400 hover:text-white hover:border-slate-600 transition-all text-sm font-medium"
            >
                <Eye class="w-4 h-4 inline mr-1" /> Public View
            </a>
        </div>
    </header>

    <!-- Stats Row -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        {#each [
            { label: 'Topics', value: stats.topics, icon: Tag, color: 'text-cyan-400' },
            { label: 'Relationships', value: stats.relationships, icon: GitBranch, color: 'text-purple-400' },
            { label: 'Claims', value: stats.claims, icon: FileCheck, color: 'text-emerald-400' },
            { label: 'Conflicts', value: stats.conflicts, icon: AlertTriangle, color: stats.conflicts > 0 ? 'text-red-400' : 'text-slate-500' },
            { label: 'Categories', value: stats.categories, icon: Layers, color: 'text-amber-400' }
        ] as stat}
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
                <div class="p-2 rounded-lg bg-slate-800/50">
                    <stat.icon class="w-4 h-4 {stat.color}" />
                </div>
                <div>
                    <p class="text-2xl font-black text-white tracking-tight">{stat.value}</p>
                    <p class="text-xs text-slate-500 font-medium">{stat.label}</p>
                </div>
            </div>
        {/each}
    </div>

    <!-- Tab Navigation -->
    <div class="flex bg-slate-900/50 p-1 rounded-2xl border border-slate-800 mb-6 w-fit">
        <button
            onclick={() => activeTab = 'graph'}
            class="px-5 py-2 rounded-xl text-sm font-bold transition-all {activeTab === 'graph' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-400 hover:text-white'}"
        >
            <Network class="w-4 h-4 inline mr-1" /> Graph
        </button>
        <button
            onclick={() => activeTab = 'conflicts'}
            class="px-5 py-2 rounded-xl text-sm font-bold transition-all {activeTab === 'conflicts' ? 'bg-red-500 text-white shadow-lg shadow-red-500/20' : 'text-slate-400 hover:text-white'}"
        >
            <AlertTriangle class="w-4 h-4 inline mr-1" /> Conflicts
            {#if stats.conflicts > 0}
                <span class="ml-1 px-1.5 py-0.5 bg-red-600 text-white text-[10px] rounded-full font-bold">{stats.conflicts}</span>
            {/if}
        </button>
        <button
            onclick={() => activeTab = 'hierarchy'}
            class="px-5 py-2 rounded-xl text-sm font-bold transition-all {activeTab === 'hierarchy' ? 'bg-purple-500 text-white shadow-lg shadow-purple-500/20' : 'text-slate-400 hover:text-white'}"
        >
            <Layers class="w-4 h-4 inline mr-1" /> Hierarchy
        </button>
    </div>

    <!-- Content -->
    {#if loading}
        <div class="flex flex-col items-center justify-center py-24 gap-4" in:fade>
            <div class="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin"></div>
            <p class="font-mono text-sm text-cyan-500 animate-pulse">Loading knowledge graph...</p>
        </div>
    {:else}
        <!-- ═══ GRAPH TAB ═══ -->
        {#if activeTab === 'graph'}
            <div class="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden relative" in:fade>
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
                    <button onclick={initGraph}
                        class="w-8 h-8 bg-black/80 border border-slate-700 rounded-lg text-slate-400 hover:text-white flex items-center justify-center text-xs" title="Reset">⟲</button>
                </div>

                <!-- Selected node details -->
                {#if selectedNode}
                    <div class="absolute bottom-4 right-4 z-10 w-72 bg-black/90 backdrop-blur-sm border border-cyan-500/30 rounded-2xl p-4" transition:slide>
                        <h4 class="text-white font-bold text-sm mb-2">{selectedNode.name}</h4>
                        <span class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border {getCategoryCss(selectedNode.category)}">
                            {selectedNode.category}
                        </span>
                        <div class="mt-3 space-y-1 text-xs text-slate-400">
                            <p>{selectedNode.claimCount} claims · {selectedNode.relCount} relationships</p>
                            {#each graphEdges.filter(e => e.source.id === selectedNode?.id || e.target.id === selectedNode?.id) as edge}
                                <p class="text-slate-500">
                                    {edge.source.id === selectedNode?.id ? '→' : '←'}
                                    <span class="text-cyan-400/70">{edge.type.replace(/_/g, ' ')}</span>
                                    {edge.source.id === selectedNode?.id ? edge.target.name : edge.source.name}
                                </p>
                            {/each}
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

                {#if data.topics.length === 0}
                    <div class="absolute inset-0 flex items-center justify-center">
                        <p class="text-slate-500 text-sm">No topics yet. Upload documents to build the knowledge graph.</p>
                    </div>
                {/if}
            </div>
        {/if}

        <!-- ═══ CONFLICTS TAB ═══ -->
        {#if activeTab === 'conflicts'}
            <div class="space-y-4" in:fade>
                {#if conflictGroups.length === 0}
                    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-12 text-center">
                        <CheckCircle class="w-12 h-12 text-emerald-400 mx-auto mb-4" />
                        <h3 class="text-xl font-bold text-white mb-2">No Conflicts</h3>
                        <p class="text-slate-400">All knowledge claims are consistent. No resolution needed.</p>
                    </div>
                {:else}
                    <div class="bg-red-500/5 border border-red-500/20 rounded-2xl p-4 mb-2 flex items-center gap-3">
                        <AlertTriangle class="w-5 h-5 text-red-400 shrink-0" />
                        <p class="text-sm text-red-300">
                            <strong>{stats.conflicts}</strong> conflicting claim{stats.conflicts !== 1 ? 's' : ''} across <strong>{conflictGroups.length}</strong> topic{conflictGroups.length !== 1 ? 's' : ''} need review.
                        </p>
                    </div>

                    {#each conflictGroups as group}
                        <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                            <!-- Topic header -->
                            <button
                                onclick={() => expandedConflict = expandedConflict === group.topic?.id ? null : group.topic?.id}
                                class="w-full flex items-center justify-between p-5 hover:bg-slate-800/50 transition-colors text-left"
                            >
                                <div class="flex items-center gap-3">
                                    {#if expandedConflict === group.topic?.id}
                                        <ChevronDown class="w-5 h-5 text-slate-500" />
                                    {:else}
                                        <ChevronRight class="w-5 h-5 text-slate-500" />
                                    {/if}
                                    <div>
                                        <h3 class="text-white font-bold">{group.topic?.name ?? 'Unknown Topic'}</h3>
                                        <span class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border {getCategoryCss(group.topic?.category || '')}">
                                            {group.topic?.category || 'Unknown'}
                                        </span>
                                    </div>
                                </div>
                                <span class="px-3 py-1 bg-red-500/10 text-red-400 text-xs font-bold rounded-full border border-red-500/20">
                                    {group.conflicting.length} conflict{group.conflicting.length !== 1 ? 's' : ''}
                                </span>
                            </button>

                            <!-- Expanded: side-by-side comparison -->
                            {#if expandedConflict === group.topic?.id}
                                <div class="border-t border-slate-800 p-5 space-y-4" transition:slide>
                                    <!-- Active claims (existing truth) -->
                                    {#if group.active.length > 0}
                                        <div>
                                            <h4 class="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                                                <CheckCircle class="w-3.5 h-3.5" /> Active Claims (Current Truth)
                                            </h4>
                                            <div class="space-y-2">
                                                {#each group.active as claim}
                                                    <div class="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-3">
                                                        <p class="text-slate-200 text-sm leading-relaxed">{claim.claim_text}</p>
                                                        <div class="mt-2 flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                                                            <span>Source: {claim.doc_name}</span>
                                                            {#if claim.doc_content_hash}
                                                                <span>· v:{claim.doc_content_hash?.slice(0, 8)}</span>
                                                            {/if}
                                                        </div>
                                                    </div>
                                                {/each}
                                            </div>
                                        </div>
                                    {/if}

                                    <!-- Conflicting claims -->
                                    <div>
                                        <h4 class="text-xs font-bold text-red-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                                            <AlertTriangle class="w-3.5 h-3.5" /> Conflicting Claims (Need Resolution)
                                        </h4>
                                        <div class="space-y-3">
                                            {#each group.conflicting as claim}
                                                <div class="bg-red-500/5 border border-red-500/10 rounded-xl p-4">
                                                    <p class="text-slate-200 text-sm leading-relaxed mb-3">{claim.claim_text}</p>
                                                    <div class="flex items-center justify-between">
                                                        <div class="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                                                            <span>Source: {claim.doc_name}</span>
                                                            {#if claim.doc_content_hash}
                                                                <span>· v:{claim.doc_content_hash?.slice(0, 8)}</span>
                                                            {/if}
                                                            {#if claim.current_doc_hash && claim.doc_content_hash && claim.current_doc_hash !== claim.doc_content_hash}
                                                                <span class="text-amber-400">⚠ doc updated since</span>
                                                            {/if}
                                                        </div>
                                                        <div class="flex items-center gap-2">
                                                            <button
                                                                onclick={() => resolveConflict(claim.id, 'accept')}
                                                                disabled={resolving === claim.id}
                                                                class="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-bold rounded-lg border border-emerald-500/20 transition-all disabled:opacity-50 flex items-center gap-1"
                                                            >
                                                                <CheckCircle class="w-3 h-3" /> Accept
                                                            </button>
                                                            <button
                                                                onclick={() => resolveConflict(claim.id, 'dismiss')}
                                                                disabled={resolving === claim.id}
                                                                class="px-3 py-1.5 bg-slate-500/10 hover:bg-slate-500/20 text-slate-400 text-xs font-bold rounded-lg border border-slate-500/20 transition-all disabled:opacity-50 flex items-center gap-1"
                                                            >
                                                                <Eye class="w-3 h-3" /> Dismiss
                                                            </button>
                                                            <button
                                                                onclick={() => resolveConflict(claim.id, 'reject')}
                                                                disabled={resolving === claim.id}
                                                                class="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold rounded-lg border border-red-500/20 transition-all disabled:opacity-50 flex items-center gap-1"
                                                            >
                                                                <XCircle class="w-3 h-3" /> Reject
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            {/each}
                                        </div>
                                    </div>
                                </div>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}

        <!-- ═══ HIERARCHY TAB ═══ -->
        {#if activeTab === 'hierarchy'}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6" in:fade>
                <!-- Category Grouping -->
                <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6">
                    <h3 class="text-lg font-bold text-white mb-4 flex items-center gap-2">
                        <Layers class="w-5 h-5 text-purple-400" />
                        By Category
                    </h3>
                    <div class="space-y-4">
                        {#each Array.from(hierarchyTree.categorized.entries()) as [category, topics]}
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    <span class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border {getCategoryCss(category)}">
                                        {category}
                                    </span>
                                    <span class="text-xs text-slate-500">{topics.length} topic{topics.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div class="space-y-1">
                                    {#each topics as topic}
                                        <div class="flex items-center justify-between py-1.5 px-3 rounded-lg hover:bg-slate-800/50 transition-colors group">
                                            <span class="text-sm text-slate-300 group-hover:text-white transition-colors">{topic.name}</span>
                                            <div class="flex items-center gap-2 text-[10px] text-slate-500">
                                                <span>{data.claims.filter((c: any) => c.topic_id === topic.id).length} claims</span>
                                                <span>{data.relationships.filter((r: any) => r.source_topic_id === topic.id || r.target_topic_id === topic.id).length} rels</span>
                                            </div>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>

                <!-- Tree View (parent-child) -->
                <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6">
                    <h3 class="text-lg font-bold text-white mb-4 flex items-center gap-2">
                        <GitBranch class="w-5 h-5 text-cyan-400" />
                        Topic Tree
                    </h3>
                    {#if hierarchyTree.roots.length === 0}
                        <p class="text-slate-500 text-sm">No topics yet.</p>
                    {:else}
                        <div class="space-y-0.5">
                            {#each hierarchyTree.roots as node}
                                {@render treeNode(node)}
                            {/each}
                        </div>
                    {/if}

                    <!-- Taxonomy rebuild result -->
                    {#if taxonomyResult}
                        <div class="mt-6 p-3 bg-purple-500/10 rounded-xl border border-purple-500/20" transition:slide>
                            <p class="text-[10px] text-purple-400 font-mono uppercase tracking-wider mb-1">Taxonomy Rebuild Complete</p>
                            <p class="text-sm text-slate-300">
                                <strong class="text-white">{taxonomyResult.updated}</strong> of {taxonomyResult.total} topics assigned to parents.
                            </p>
                        </div>
                    {/if}

                    <div class="mt-4 p-3 bg-slate-800/30 rounded-xl border border-slate-700/50">
                        <p class="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-1">How it works</p>
                        <p class="text-xs text-slate-400">
                            <strong class="text-cyan-400">Incremental:</strong> After each document import, new topics are automatically placed into the existing hierarchy.
                            <br />
                            <strong class="text-purple-400">Full rebuild:</strong> Click "Rebuild Taxonomy" to have the LLM review all topics and create an optimal hierarchy from scratch.
                            The rebuild also runs automatically after each git repo sync.
                        </p>
                    </div>
                </div>
            </div>
        {/if}
    {/if}
</div>

{#snippet treeNode(node: HierarchyNode)}
    <div style="margin-left: {node.depth * 20}px">
        <button
            onclick={() => node.children.length > 0 && toggleHierarchyNode(node.topic.id)}
            class="w-full flex items-center gap-2 py-1.5 px-3 rounded-lg hover:bg-slate-800/50 transition-colors text-left group"
        >
            {#if node.children.length > 0}
                {#if node.expanded}
                    <ChevronDown class="w-3.5 h-3.5 text-slate-500" />
                {:else}
                    <ChevronRight class="w-3.5 h-3.5 text-slate-500" />
                {/if}
            {:else}
                <span class="w-3.5 h-3.5 flex items-center justify-center text-slate-700">•</span>
            {/if}
            <span class="text-sm text-slate-300 group-hover:text-white transition-colors flex-1">{node.topic.name}</span>
            <span class="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border {getCategoryCss(node.topic.category || '')} opacity-60">
                {node.topic.category || '?'}
            </span>
        </button>
        {#if node.expanded && node.children.length > 0}
            {#each node.children as child}
                {@render treeNode(child)}
            {/each}
        {/if}
    </div>
{/snippet}
