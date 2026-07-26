<script lang="ts">
    import { onMount } from 'svelte';
    import { fade, fly, slide, scale } from 'svelte/transition';
    import { cubicOut, elasticOut, quintOut } from 'svelte/easing';
    import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import Bot from '@lucide/svelte/icons/bot';
import FileText from '@lucide/svelte/icons/file-text';
import Brain from '@lucide/svelte/icons/brain';
import Network from '@lucide/svelte/icons/network';
import Search from '@lucide/svelte/icons/search';
import Database from '@lucide/svelte/icons/database';
import Zap from '@lucide/svelte/icons/zap';
import GitBranch from '@lucide/svelte/icons/git-branch';
import MessageSquare from '@lucide/svelte/icons/message-square';
import Upload from '@lucide/svelte/icons/upload';
import Layers from '@lucide/svelte/icons/layers';
import Cpu from '@lucide/svelte/icons/cpu';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import Sparkles from '@lucide/svelte/icons/sparkles';
import ArrowRight from '@lucide/svelte/icons/arrow-right';
import BookOpen from '@lucide/svelte/icons/book-open';
import Activity from '@lucide/svelte/icons/activity';
import Link2 from '@lucide/svelte/icons/link-2';
import Target from '@lucide/svelte/icons/target';
import Workflow from '@lucide/svelte/icons/workflow';

    let mounted = $state(false);
    let activeSection = $state(0);
    let graphAnimPhase = $state(0);
    let pipelineStep = $state(-1);
    let showScrollHint = $state(true);

    // Knowledge graph demo nodes
    const demoNodes = [
        { id: 0, label: 'TypeScript', category: 'Technical', x: 50, y: 40, r: 28 },
        { id: 1, label: 'SvelteKit', category: 'Technical', x: 25, y: 25, r: 24 },
        { id: 2, label: 'REST API', category: 'Architecture', x: 75, y: 30, r: 22 },
        { id: 3, label: 'Auth', category: 'Architecture', x: 20, y: 60, r: 20 },
        { id: 4, label: 'Testing', category: 'Best Practice', x: 70, y: 65, r: 21 },
        { id: 5, label: 'SQLite', category: 'Technical', x: 45, y: 72, r: 23 },
        { id: 6, label: 'RAG', category: 'Architecture', x: 80, y: 50, r: 25 },
        { id: 7, label: 'Embeddings', category: 'Technical', x: 55, y: 20, r: 19 },
        { id: 8, label: 'Git Sync', category: 'Best Practice', x: 30, y: 45, r: 18 },
    ];

    const demoEdges = [
        { from: 0, to: 1, type: 'powers' },
        { from: 0, to: 2, type: 'defines' },
        { from: 1, to: 3, type: 'implements' },
        { from: 1, to: 8, type: 'uses' },
        { from: 2, to: 6, type: 'feeds' },
        { from: 5, to: 6, type: 'stores' },
        { from: 6, to: 7, type: 'generates' },
        { from: 4, to: 0, type: 'validates' },
        { from: 3, to: 5, type: 'persists' },
        { from: 7, to: 2, type: 'enhances' },
    ];

    // The demo graph uses the same category tokens as the real graph, so this
    // page shows the product's actual colour language rather than its own.
    const categoryColors: Record<string, { token: string }> = {
        'Technical': { token: '--cat-technical' },
        'Architecture': { token: '--cat-architecture' },
        'Best Practice': { token: '--cat-practice' },
    };

    function catVar(category: string): string {
        return `var(${categoryColors[category]?.token ?? '--cat-other'})`;
    }

    // Seven stages, one accent. Giving each stage its own hue made the diagram
    // look like a legend for something; sequence is carried by the numbering
    // and by which stage is currently active.
    const pipelineSteps = [
        { icon: Upload, title: 'Ingest', desc: 'Documents uploaded or synced from Git repositories' },
        { icon: Layers, title: 'Chunk', desc: 'Split into semantic segments with overlap' },
        { icon: Cpu, title: 'Embed', desc: 'Each chunk becomes a vector embedding' },
        { icon: Brain, title: 'Extract', desc: 'Topics, relationships and factual claims are identified' },
        { icon: Network, title: 'Graph', desc: 'The knowledge graph is built from nodes, edges and hierarchy' },
        { icon: Search, title: 'Retrieve', desc: 'Hybrid vector and full-text search finds relevant context' },
        { icon: Sparkles, title: 'Generate', desc: 'The model answers, grounded in your data' },
    ];

    onMount(() => {
        mounted = true;

        // Animate graph phases
        let phase = 0;
        const graphInterval = setInterval(() => {
            phase = (phase + 1) % 4;
            graphAnimPhase = phase;
        }, 2000);

        // Pipeline auto-advance
        let step = -1;
        const pipelineInterval = setInterval(() => {
            step = (step + 1) % (pipelineSteps.length + 2);
            pipelineStep = step >= pipelineSteps.length ? -1 : step;
        }, 1800);

        // Intersection observer for scroll sections
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    const idx = parseInt(e.target.getAttribute('data-section') || '0');
                    activeSection = idx;
                }
            });
        }, { threshold: 0.3 });

        document.querySelectorAll('[data-section]').forEach(el => observer.observe(el));

        // Hide scroll hint after scroll
        const handleScroll = () => { showScrollHint = false; };
        window.addEventListener('scroll', handleScroll, { once: true });

        return () => {
            clearInterval(graphInterval);
            clearInterval(pipelineInterval);
            observer.disconnect();
            window.removeEventListener('scroll', handleScroll);
        };
    });
</script>

<svelte:head>
    <title>About — ARCHIE</title>
</svelte:head>

<div class="min-h-screen bg-page text-body overflow-x-hidden">
    <!-- Navigation bar -->
    <nav class="fixed top-0 left-0 right-0 z-50 bg-page/90 backdrop-blur-md border-b border-line-subtle">
        <div class="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
            <a href="/" class="btn btn-ghost btn-sm -ml-2.5">
                <ArrowLeft class="w-4 h-4" />
                Back to chat
            </a>
            <p class="wordmark">Archie<span class="wordmark-dot ml-1"></span></p>
        </div>
    </nav>

    <!-- ===== SECTION 0: Hero ===== -->
    <section data-section="0" class="relative min-h-screen flex flex-col items-center justify-center px-6 pt-14">
        {#if mounted}
            <div class="relative z-10 text-center max-w-2xl" in:fade={{ duration: 400 }}>
                <div class="w-12 h-12 mx-auto rounded-2xl bg-surface border border-line flex items-center justify-center">
                    <Bot class="w-6 h-6 text-accent" />
                </div>

                <div in:fly={{ y: 12, duration: 400, delay: 100 }}>
                    <h1 class="text-4xl md:text-5xl font-semibold tracking-tight text-strong mt-6">
                        Archie
                    </h1>
                    <p class="text-lg text-mute mt-3">
                        Answers from your own documents, with the sources attached.
                    </p>
                </div>

                <div class="flex flex-wrap justify-center gap-1.5 mt-7" in:fly={{ y: 12, duration: 400, delay: 200 }}>
                    {#each ['RAG pipeline', 'Knowledge graph', 'Semantic search', 'Editable wiki'] as label}
                        <span class="chip">{label}</span>
                    {/each}
                </div>

                <p class="text-[13px] text-faint max-w-md mx-auto leading-relaxed mt-7" in:fly={{ y: 12, duration: 400, delay: 300 }}>
                    Archie doesn't just search your documents — it <strong class="font-semibold text-body">understands</strong> them.
                    It extracts topics, discovers relationships, and builds a living knowledge graph
                    so every answer can be traced back to where it came from.
                </p>
            </div>

            <!-- Scroll indicator -->
            {#if showScrollHint}
                <div class="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5" transition:fade>
                    <span class="eyebrow">Scroll to explore</span>
                    <ChevronDown class="w-4 h-4 text-ghost" />
                </div>
            {/if}
        {/if}
    </section>

    <!-- ===== SECTION 1: How It Works Overview ===== -->
    <section data-section="1" class="relative flex items-center justify-center px-6 py-24">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="mb-10">
                <p class="eyebrow eyebrow-accent">How it works</p>
                <h2 class="text-2xl font-semibold tracking-tight text-strong mt-2">From documents to answers</h2>
                <p class="text-[13px] text-mute mt-2 max-w-lg">Three layers turn raw documents into an interactive knowledge system.</p>
            </div>

            <div class="grid md:grid-cols-3 gap-3">
                {#each [
                    { icon: Upload, title: 'Ingest and process', desc: 'Upload documents or sync a Git repo. Archie watches for changes and re-processes updated files.' },
                    { icon: Brain, title: 'Understand and map', desc: 'Topics, relationships and factual claims are extracted into a graph that grows with every document.' },
                    { icon: MessageSquare, title: 'Ask and answer', desc: 'Ask in plain language. Archie finds the relevant context and answers from it, citing each source.' },
                ] as card, i}
                    <div class="card card-hover p-5">
                        <div class="flex items-center justify-between">
                            <div class="w-9 h-9 rounded-xl bg-muted border border-line-subtle flex items-center justify-center">
                                <card.icon class="w-4 h-4 text-accent-quiet" />
                            </div>
                            <span class="eyebrow tabular-nums">Step {i + 1}</span>
                        </div>
                        <h3 class="text-sm font-semibold text-strong mt-4">{card.title}</h3>
                        <p class="text-[13px] text-mute leading-relaxed mt-1.5">{card.desc}</p>
                    </div>
                {/each}
            </div>
        </div>
    </section>

    <!-- ===== SECTION 2: RAG Pipeline ===== -->
    <section data-section="2" class="relative flex items-center justify-center px-6 py-24">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="mb-10">
                <p class="eyebrow eyebrow-accent">The pipeline</p>
                <h2 class="text-2xl font-semibold tracking-tight text-strong mt-2">Retrieval-augmented generation</h2>
                <p class="text-[13px] text-mute mt-2 max-w-xl">Every question travels through seven stages, each one narrowing raw data towards a sourced answer.</p>
            </div>

            <!-- Pipeline visualization -->
            <!-- The steps are a real sequence, so they get numbers and a rail;
                 the active step is marked by the accent alone. -->
            <div class="relative">
                <div class="absolute top-5 left-0 right-0 h-px bg-[var(--line)] hidden lg:block"></div>

                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-4 lg:gap-2">
                    {#each pipelineSteps as step, i}
                        {@const isActive = pipelineStep === i}
                        {@const isPast = pipelineStep > i}
                        <div class="relative flex flex-col items-center text-center">
                            <div
                                class="w-10 h-10 rounded-xl flex items-center justify-center relative z-10 border transition-colors duration-300
                                {isActive
                                    ? 'bg-accent-solid border-transparent'
                                    : isPast
                                        ? 'bg-muted border-line-strong'
                                        : 'bg-surface border-line'}"
                            >
                                <step.icon class="w-4 h-4 {isActive ? 'text-on-accent' : isPast ? 'text-mute' : 'text-faint'}" />
                            </div>

                            <div class="mt-3">
                                <p class="text-xs font-semibold {isActive ? 'text-strong' : 'text-mute'}">
                                    <span class="text-ghost tabular-nums mr-1">{i + 1}</span>{step.title}
                                </p>
                                <p class="text-xs text-faint leading-relaxed max-w-[15ch] mx-auto mt-1">
                                    {step.desc}
                                </p>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>

            <!-- Pipeline detail cards -->
            <div class="grid md:grid-cols-2 gap-3 mt-14">
                <div class="card p-5">
                    <div class="flex items-center gap-2.5">
                        <Search class="w-4 h-4 text-accent-quiet" />
                        <h3 class="text-sm font-semibold text-strong">Hybrid search</h3>
                    </div>
                    <p class="text-[13px] text-mute leading-relaxed mt-3">
                        Archie combines <strong class="font-semibold text-body">vector similarity search</strong>, which finds semantically
                        similar content through embeddings, with <strong class="font-semibold text-body">full-text search</strong> (BM25
                        keyword matching via SQLite FTS5). Results are merged and re-ranked, so meaning and exact terms both count.
                    </p>
                </div>
                <div class="card p-5">
                    <div class="flex items-center gap-2.5">
                        <Sparkles class="w-4 h-4 text-accent-quiet" />
                        <h3 class="text-sm font-semibold text-strong">Grounded generation</h3>
                    </div>
                    <p class="text-[13px] text-mute leading-relaxed mt-3">
                        Answers are <strong class="font-semibold text-body">grounded in your documents</strong>. The retrieved chunks,
                        relevant claims and topic context go into the prompt, so the model speaks only about what your data
                        actually says — and every answer traces back to its source.
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- ===== SECTION 3: Knowledge Graph Deep Dive ===== -->
    <section data-section="3" class="relative flex items-center justify-center px-6 py-24">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="mb-10">
                <p class="eyebrow eyebrow-accent">The difference</p>
                <h2 class="text-2xl font-semibold tracking-tight text-strong mt-2">The knowledge graph</h2>
                <p class="text-[13px] text-mute mt-2 max-w-xl">
                    Instead of only storing text, Archie builds a structured map of concepts, how they relate, and which facts hold.
                </p>
            </div>

            <div class="grid lg:grid-cols-2 gap-8 items-center">
                <!-- Graph illustration: same node colours as the real graph -->
                <div class="relative aspect-square max-w-md mx-auto w-full">
                    <div class="absolute inset-0 rounded-3xl bg-well border border-line overflow-hidden">
                        <svg class="absolute inset-0 w-full h-full" viewBox="0 0 100 100" aria-hidden="true">
                            <!-- Edges -->
                            <!-- Colours go through `style`, not the stroke/fill
                                 attributes: presentation attributes don't resolve
                                 var(), so tokens set that way render as nothing. -->
                            {#each demoEdges as edge, i}
                                {@const from = demoNodes[edge.from]}
                                {@const to = demoNodes[edge.to]}
                                {@const isHighlighted = graphAnimPhase === (i % 4)}
                                <line
                                    x1={from.x} y1={from.y}
                                    x2={to.x} y2={to.y}
                                    class="transition-all duration-700"
                                    style="stroke: {isHighlighted ? 'var(--accent-quiet)' : 'var(--line-strong)'}; stroke-width: {isHighlighted ? 0.5 : 0.25}"
                                />
                            {/each}

                            <!-- Nodes -->
                            {#each demoNodes as node}
                                <circle
                                    cx={node.x} cy={node.y} r={node.r * 0.12}
                                    style="fill: {catVar(node.category)}; fill-opacity: 0.22; stroke: {catVar(node.category)}; stroke-width: 0.35"
                                />
                                <text
                                    x={node.x} y={node.y + 0.5}
                                    text-anchor="middle"
                                    dominant-baseline="middle"
                                    font-size="2.2"
                                    class="pointer-events-none select-none"
                                    style="fill: var(--text-secondary); font-weight: 600; font-family: system-ui, sans-serif"
                                >
                                    {node.label}
                                </text>
                            {/each}
                        </svg>

                        <!-- Legend -->
                        <div class="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1">
                            {#each Object.keys(categoryColors) as cat}
                                <span class="flex items-center gap-1.5 text-xs text-mute">
                                    <span class="w-2 h-2 rounded-full" style="background: {catVar(cat)}"></span>
                                    {cat}
                                </span>
                            {/each}
                        </div>
                    </div>
                </div>

                <!-- Graph explanation -->
                <div class="space-y-1">
                    {#each [
                        { icon: Target, title: 'Topics', desc: 'Each document is analysed for its key concepts — technologies, patterns, processes. Topics are categorised and can form hierarchies.' },
                        { icon: Link2, title: 'Relationships', desc: 'Archie records how topics connect: uses, depends on, implements, conflicts with. Those directed edges make the knowledge navigable.' },
                        { icon: BookOpen, title: 'Claims', desc: 'Factual statements are linked to both a topic and a source document. When documents change, claims are re-validated and conflicts are flagged.' },
                        { icon: Activity, title: 'A living map', desc: 'Update a document and the graph reconciles: retired claims are superseded, new topics appear, relationships adapt.' },
                    ] as item}
                        <div class="flex gap-3 p-3 rounded-xl">
                            <item.icon class="w-4 h-4 text-accent-quiet flex-shrink-0 mt-0.5" />
                            <div>
                                <h3 class="text-sm font-semibold text-strong">{item.title}</h3>
                                <p class="text-[13px] text-mute leading-relaxed mt-1">{item.desc}</p>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    </section>

    <!-- ===== SECTION 4: Knowledge Extraction Deep Dive ===== -->
    <section data-section="4" class="relative flex items-center justify-center px-6 py-24">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="mb-10">
                <p class="eyebrow eyebrow-accent">Under the hood</p>
                <h2 class="text-2xl font-semibold tracking-tight text-strong mt-2">How knowledge is extracted</h2>
                <p class="text-[13px] text-mute mt-2 max-w-xl">
                    A document entering the system goes through five stages of analysis.
                </p>
            </div>

            <!-- Process flow visualization -->
            <div class="relative space-y-4">
                {#each [
                    {
                        step: '01',
                        title: 'Document chunking',
                        desc: 'The document is split into overlapping segments of about 500 characters with roughly 100 characters of overlap, so nothing is lost at a chunk boundary.',
                        visual: 'chunk'
                    },
                    {
                        step: '02',
                        title: 'Vector embedding',
                        desc: 'Each chunk becomes a vector that captures its meaning. Vectors are stored in SQLite through the vector extension for efficient similarity search.',
                        visual: 'embed'
                    },
                    {
                        step: '03',
                        title: 'Topic extraction',
                        desc: 'The document is analysed against existing topics and new ones are extracted, each with a name, description and category — plus any parent-child relationship.',
                        visual: 'topic'
                    },
                    {
                        step: '04',
                        title: 'Relationship discovery',
                        desc: 'Directed relationships between topics are identified: "SvelteKit uses TypeScript", "REST API implements authentication". These edges make the graph traversable.',
                        visual: 'relation'
                    },
                    {
                        step: '05',
                        title: 'Claim extraction',
                        desc: 'Atomic factual statements are linked to topics. Each claim carries a content hash, so when a document changes its claims can be compared and conflicts surfaced.',
                        visual: 'claim'
                    },
                ] as proc, i}
                    <div class="relative grid md:grid-cols-[3rem_1fr] gap-4 card card-hover p-5">
                        <!-- Step number -->
                        <div class="flex md:flex-col items-center gap-3 md:gap-2">
                            <span class="text-lg font-semibold tabular-nums text-accent-quiet">{proc.step}</span>
                            {#if i < 4}
                                <div class="hidden md:block w-px flex-1 bg-[var(--line-subtle)]"></div>
                            {/if}
                        </div>

                        <!-- Content -->
                        <div>
                            <h3 class="text-sm font-semibold text-strong">{proc.title}</h3>
                            <p class="text-[13px] text-mute leading-relaxed mt-1.5">{proc.desc}</p>

                            <!-- Visual representation -->
                            {#if proc.visual === 'chunk'}
                                <div class="flex gap-1 mt-3 overflow-hidden">
                                    {#each Array(7) as _, j}
                                        <div
                                            class="h-7 rounded-md flex items-center justify-center text-[10px] font-mono border
                                            {j === 3
                                                ? 'bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] border-[color-mix(in_oklab,var(--accent)_30%,transparent)] text-accent-quiet'
                                                : 'bg-well border-line-subtle text-faint'}"
                                            style="flex: {j === 3 ? 2 : 1};"
                                        >
                                            {j === 2 ? '…overlap' : j === 3 ? 'chunk' : j === 4 ? 'overlap…' : ''}
                                        </div>
                                    {/each}
                                </div>
                            {:else if proc.visual === 'embed'}
                                <div class="flex gap-0.5 items-end mt-3 h-10">
                                    {#each Array(40) as _, j}
                                        <div
                                            class="flex-1 rounded-t-sm min-w-[3px] bg-accent-quiet"
                                            style="
                                                height: {20 + Math.sin(j * 0.5) * 30 + Math.cos(j * 0.3) * 20}%;
                                                opacity: {0.25 + Math.abs(Math.sin(j * 0.4)) * 0.5};
                                            "
                                        ></div>
                                    {/each}
                                    <span class="text-xs font-mono text-faint ml-2 self-center whitespace-nowrap">n dims</span>
                                </div>
                            {:else if proc.visual === 'topic'}
                                <div class="flex flex-wrap gap-1.5 mt-3">
                                    {#each [
                                        { name: 'SvelteKit', cat: 'Technical' },
                                        { name: 'REST API', cat: 'Architecture' },
                                        { name: 'Auth', cat: 'Architecture' },
                                        { name: 'Testing', cat: 'Best Practice' },
                                    ] as t}
                                        <span class="tag-cat" data-cat={t.cat === 'Technical' ? 'technical' : t.cat === 'Architecture' ? 'architecture' : 'practice'}>
                                            <span class="w-1.5 h-1.5 rounded-full" style="background: var(--cat)"></span>
                                            {t.name}
                                        </span>
                                    {/each}
                                </div>
                            {:else if proc.visual === 'relation'}
                                <div class="flex items-center gap-2 mt-3 flex-wrap">
                                    {#each [
                                        { from: 'SvelteKit', to: 'TypeScript', rel: 'uses' },
                                        { from: 'REST API', to: 'Auth', rel: 'implements' },
                                    ] as r}
                                        <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-well border border-line-subtle">
                                            <span class="text-xs font-medium text-body">{r.from}</span>
                                            <span class="text-xs font-mono text-faint">{r.rel}</span>
                                            <ArrowRight class="w-3 h-3 text-ghost" />
                                            <span class="text-xs font-medium text-body">{r.to}</span>
                                        </div>
                                    {/each}
                                </div>
                            {:else if proc.visual === 'claim'}
                                <div class="space-y-1.5 mt-3">
                                    {#each [
                                        'SvelteKit uses file-based routing for all endpoints',
                                        'Authentication is handled via session cookies',
                                    ] as claim}
                                        <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-well border border-line-subtle">
                                            <div class="w-1.5 h-1.5 rounded-full bg-accent-quiet mt-1.5 flex-shrink-0"></div>
                                            <span class="text-xs text-dim leading-relaxed">{claim}</span>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    </section>

    <!-- ===== SECTION 5: Features & Tech ===== -->
    <section data-section="5" class="relative flex items-center justify-center px-6 py-24">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="mb-10">
                <p class="eyebrow eyebrow-accent">Built with</p>
                <h2 class="text-2xl font-semibold tracking-tight text-strong mt-2">Technology stack</h2>
            </div>

            <!-- Vendor colours are deliberately not used here: eight brand hues
                 in one grid competed with the product's own palette. -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                {#each [
                    { name: 'SvelteKit 5', desc: 'Full-stack framework', icon: Zap },
                    { name: 'TypeScript', desc: 'Type-safe codebase', icon: FileText },
                    { name: 'SQLite', desc: 'Embedded database', icon: Database },
                    { name: 'LLM provider', desc: 'Answers and embeddings', icon: Sparkles },
                    { name: 'sqlite-vec', desc: 'Vector similarity', icon: Cpu },
                    { name: 'FTS5', desc: 'Full-text search', icon: Search },
                    { name: 'Git sync', desc: 'Repository integration', icon: GitBranch },
                    { name: 'Tailwind', desc: 'Utility-first CSS', icon: Layers },
                ] as tech}
                    <div class="card card-hover p-4">
                        <tech.icon class="w-4 h-4 text-faint" />
                        <h3 class="text-[13px] font-semibold text-strong mt-3">{tech.name}</h3>
                        <p class="text-xs text-faint mt-0.5">{tech.desc}</p>
                    </div>
                {/each}
            </div>

            <!-- Key features grid -->
            <div class="mt-10 grid md:grid-cols-2 gap-3">
                {#each [
                    { title: 'Multi-user access', desc: 'Role-based access control across Admin, Contributor and User. Admins manage everything, Contributors edit and create wiki pages, Users read and chat.' },
                    { title: 'Git integration', desc: 'Connect a repository and Archie clones, indexes and watches it for changes. Filter by file extension and directory; pushed docs are processed automatically.' },
                    { title: 'Conversation history', desc: 'Every conversation is kept per user. Resume an earlier thread, delete what you no longer need, or start fresh — context carries through the thread.' },
                    { title: 'Conflict detection', desc: 'When documents change, the graph detects conflicting claims. Old facts are retired, new ones take their place, and contradictions are flagged for review.' },
                ] as feature}
                    <div class="card p-5">
                        <h3 class="text-sm font-semibold text-strong">{feature.title}</h3>
                        <p class="text-[13px] text-mute leading-relaxed mt-2">{feature.desc}</p>
                    </div>
                {/each}
            </div>
        </div>
    </section>

    <!-- ===== SECTION 6: CTA ===== -->
    <section data-section="6" class="relative flex items-center justify-center px-6 py-24">
        <div class="text-center relative z-10">
            <h2 class="text-2xl font-semibold tracking-tight text-strong">Ready to explore your knowledge?</h2>
            <p class="text-[13px] text-mute max-w-md mx-auto mt-2">Start a conversation, or open the graph to see how your documents connect.</p>
            <div class="flex flex-wrap justify-center gap-2 mt-6">
                <a href="/" class="btn btn-primary">
                    <MessageSquare class="w-4 h-4" />
                    Start chatting
                </a>
                <a href="/knowledge" class="btn btn-secondary">
                    <Network class="w-4 h-4" />
                    Knowledge graph
                </a>
            </div>
        </div>
    </section>

    <!-- Footer -->
    <footer class="border-t border-line-subtle py-6 text-center">
        <p class="text-xs text-faint">Built with SvelteKit, SQLite and a hosted LLM.</p>
    </footer>

    <!-- Progress rail (fixed) -->
    <!-- Same accent-rail device as the app's nav, rotated to the page edge. -->
    <div class="fixed right-6 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-1.5">
        {#each ['Hero', 'Overview', 'Pipeline', 'Graph', 'Extraction', 'Tech', 'Start'] as label, i}
            <button
                onclick={() => {
                    const el = document.querySelector(`[data-section="${i}"]`);
                    el?.scrollIntoView({ behavior: 'smooth' });
                }}
                class="group relative h-4 w-0.5 rounded-full transition-colors {activeSection === i ? 'bg-accent' : 'bg-[var(--line-strong)] hover:bg-[var(--text-faintest)]'}"
                aria-label="Go to {label}"
                aria-current={activeSection === i}
            >
                <span class="absolute right-4 top-1/2 -translate-y-1/2 text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity text-mute pointer-events-none">
                    {label}
                </span>
            </button>
        {/each}
    </div>
</div>

<style>
    :global(body) {
        scroll-behavior: smooth;
    }
</style>
