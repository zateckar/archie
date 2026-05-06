<script lang="ts">
    import { onMount } from 'svelte';
    import { fade, fly, slide, scale } from 'svelte/transition';
    import { cubicOut, elasticOut, quintOut } from 'svelte/easing';
    import {
        ArrowLeft, Bot, FileText, Brain, Network, Search,
        Database, Zap, GitBranch, MessageSquare, Upload,
        Layers, Cpu, ChevronDown, Sparkles, ArrowRight,
        BookOpen, Activity, Link2, Target, Workflow
    } from 'lucide-svelte';

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

    const categoryColors: Record<string, { fill: string; stroke: string; glow: string; text: string }> = {
        'Technical': { fill: '#0e7490', stroke: '#22d3ee', glow: 'rgba(34,211,238,0.3)', text: '#cffafe' },
        'Architecture': { fill: '#7e22ce', stroke: '#a855f7', glow: 'rgba(168,85,247,0.3)', text: '#f3e8ff' },
        'Best Practice': { fill: '#065f46', stroke: '#34d399', glow: 'rgba(52,211,153,0.3)', text: '#d1fae5' },
    };

    const pipelineSteps = [
        { icon: Upload, title: 'Ingest', desc: 'Documents uploaded or synced from Git repositories', color: '#78FAAE' },
        { icon: Layers, title: 'Chunk', desc: 'Smart splitting into semantic segments with overlap', color: '#22d3ee' },
        { icon: Cpu, title: 'Embed', desc: 'Gemini creates 768-dimensional vector embeddings', color: '#a855f7' },
        { icon: Brain, title: 'Extract', desc: 'AI identifies topics, relationships & factual claims', color: '#f59e0b' },
        { icon: Network, title: 'Graph', desc: 'Knowledge graph built with nodes, edges & hierarchy', color: '#ec4899' },
        { icon: Search, title: 'Retrieve', desc: 'Hybrid vector + full-text search finds relevant context', color: '#22d3ee' },
        { icon: Sparkles, title: 'Generate', desc: 'Gemini synthesizes an answer grounded in your data', color: '#78FAAE' },
    ];

    // Animated particles for background
    let particles: { x: number; y: number; size: number; speed: number; opacity: number; delay: number }[] = $state([]);

    onMount(() => {
        mounted = true;

        // Generate background particles
        particles = Array.from({ length: 40 }, (_, i) => ({
            x: Math.random() * 100,
            y: Math.random() * 100,
            size: Math.random() * 3 + 1,
            speed: Math.random() * 20 + 10,
            opacity: Math.random() * 0.5 + 0.1,
            delay: Math.random() * 5,
        }));

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

<div class="min-h-screen bg-[#050505] text-white overflow-x-hidden">
    <!-- Floating particles background -->
    <div class="fixed inset-0 pointer-events-none overflow-hidden z-0">
        {#each particles as p, i}
            <div
                class="absolute rounded-full bg-[#78FAAE] particle"
                style="
                    left: {p.x}%;
                    top: {p.y}%;
                    width: {p.size}px;
                    height: {p.size}px;
                    opacity: {p.opacity};
                    animation-duration: {p.speed}s;
                    animation-delay: {p.delay}s;
                "
            ></div>
        {/each}
        <!-- Gradient orbs -->
        <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-[#78FAAE]/5 rounded-full blur-3xl animate-pulse-slow"></div>
        <div class="absolute bottom-1/3 right-1/4 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl animate-pulse-slow" style="animation-delay: 2s"></div>
        <div class="absolute top-2/3 left-1/2 w-72 h-72 bg-purple-500/5 rounded-full blur-3xl animate-pulse-slow" style="animation-delay: 4s"></div>
    </div>

    <!-- Navigation bar -->
    <nav class="fixed top-0 left-0 right-0 z-50 bg-[#050505]/80 backdrop-blur-xl border-b border-slate-800/50">
        <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
            <a href="/" class="flex items-center gap-3 group">
                <ArrowLeft class="w-4 h-4 text-slate-500 group-hover:text-[#78FAAE] transition-colors" />
                <span class="text-xs font-black uppercase tracking-[0.2em] text-slate-500 group-hover:text-white transition-colors">Back to Chat</span>
            </a>
            <div class="flex items-center gap-2">
                <div class="w-2 h-2 rounded-full bg-[#78FAAE] animate-pulse shadow-[0_0_8px_rgba(120,250,174,0.5)]"></div>
                <span class="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">ARCHIE</span>
            </div>
        </div>
    </nav>

    <!-- ===== SECTION 0: Hero ===== -->
    <section data-section="0" class="relative min-h-screen flex flex-col items-center justify-center px-6 pt-14">
        {#if mounted}
            <div class="relative z-10 text-center space-y-8 max-w-3xl" in:fade={{ duration: 800 }}>
                <!-- Animated logo -->
                <div class="relative inline-block" in:scale={{ duration: 1000, easing: elasticOut, start: 0.5 }}>
                    <div class="w-28 h-28 mx-auto rounded-3xl bg-gradient-to-br from-[#0E3A2F] to-[#78FAAE] flex items-center justify-center shadow-2xl shadow-[#0E3A2F]/60 rotate-12 hover:rotate-0 transition-transform duration-700">
                        <Bot class="w-14 h-14 text-[#0E3A2F]" />
                    </div>
                    <div class="absolute -inset-4 rounded-3xl bg-[#78FAAE]/10 blur-2xl animate-pulse-slow rotate-12"></div>
                </div>

                <div in:fly={{ y: 30, duration: 800, delay: 300 }}>
                    <h1 class="text-6xl md:text-8xl font-black tracking-tighter">
                        <span class="bg-gradient-to-r from-[#78FAAE] via-cyan-400 to-purple-400 bg-clip-text text-transparent">ARCHIE</span>
                    </h1>
                    <p class="text-lg md:text-xl text-slate-400 mt-4 font-light tracking-wide">
                        Your AI-Powered Knowledge Assistant
                    </p>
                </div>

                <div class="flex flex-wrap justify-center gap-3 mt-8" in:fly={{ y: 20, duration: 600, delay: 600 }}>
                    {#each [
                        { label: 'RAG Pipeline', bg: 'bg-emerald-950/50', border: 'border-emerald-500/30', text: 'text-emerald-400' },
                        { label: 'Knowledge Graph', bg: 'bg-cyan-950/50', border: 'border-cyan-500/30', text: 'text-cyan-400' },
                        { label: 'Semantic Search', bg: 'bg-purple-950/50', border: 'border-purple-500/30', text: 'text-purple-400' },
                        { label: 'Gemini AI', bg: 'bg-amber-950/50', border: 'border-amber-500/30', text: 'text-amber-400' },
                    ] as badge}
                        <span class="px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border {badge.bg} {badge.border} {badge.text}">
                            {badge.label}
                        </span>
                    {/each}
                </div>

                <p class="text-sm text-slate-500 max-w-lg mx-auto leading-relaxed" in:fly={{ y: 20, duration: 600, delay: 800 }}>
                    Archie doesn't just search your documents — it <strong class="text-white">understands</strong> them.
                    It extracts topics, discovers relationships, and builds a living knowledge graph
                    to give you precise, sourced answers.
                </p>
            </div>

            <!-- Scroll indicator -->
            {#if showScrollHint}
                <div class="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 animate-bounce" transition:fade>
                    <span class="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Scroll to explore</span>
                    <ChevronDown class="w-5 h-5 text-slate-600" />
                </div>
            {/if}
        {/if}
    </section>

    <!-- ===== SECTION 1: How It Works Overview ===== -->
    <section data-section="1" class="relative min-h-screen flex items-center justify-center px-6 py-32">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="text-center mb-20">
                <p class="text-[10px] font-black text-[#78FAAE] uppercase tracking-[0.3em] mb-3">How It Works</p>
                <h2 class="text-4xl md:text-5xl font-black tracking-tight">From Documents to Answers</h2>
                <p class="text-slate-500 mt-4 max-w-lg mx-auto">Three intelligent layers work together to transform your raw documents into an interactive knowledge system.</p>
            </div>

            <div class="grid md:grid-cols-3 gap-8">
                {#each [
                    { icon: Upload, title: 'Ingest & Process', desc: 'Upload documents or sync a Git repo. Archie watches for changes and automatically re-processes updated files.', color: '#78FAAE', border: 'border-[#78FAAE]/20', bg: 'bg-[#0E3A2F]/20' },
                    { icon: Brain, title: 'Understand & Map', desc: 'AI extracts topics, relationships, and factual claims — building a rich knowledge graph that grows with every document.', color: '#22d3ee', border: 'border-cyan-500/20', bg: 'bg-cyan-950/20' },
                    { icon: MessageSquare, title: 'Ask & Answer', desc: 'Ask questions in natural language. Archie finds the most relevant context and generates grounded, sourced responses.', color: '#a855f7', border: 'border-purple-500/20', bg: 'bg-purple-950/20' },
                ] as card, i}
                    <div class="group relative">
                        <div class="absolute inset-0 {card.bg} rounded-3xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                        <div class="relative p-8 rounded-3xl bg-[#0a0a0a] border {card.border} hover:border-opacity-60 transition-all duration-500 h-full">
                            <div class="w-14 h-14 rounded-2xl flex items-center justify-center mb-6 transition-transform group-hover:scale-110 group-hover:rotate-6 duration-500"
                                style="background: {card.color}15; border: 1px solid {card.color}30;">
                                <card.icon class="w-7 h-7" style="color: {card.color}" />
                            </div>
                            <div class="flex items-center gap-3 mb-3">
                                <span class="text-[10px] font-black uppercase tracking-[0.2em] rounded-full px-2 py-0.5" style="color: {card.color}; background: {card.color}15;">Step {i + 1}</span>
                            </div>
                            <h3 class="text-xl font-black tracking-tight mb-3">{card.title}</h3>
                            <p class="text-sm text-slate-500 leading-relaxed">{card.desc}</p>
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    </section>

    <!-- ===== SECTION 2: RAG Pipeline ===== -->
    <section data-section="2" class="relative min-h-screen flex items-center justify-center px-6 py-32">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="text-center mb-16">
                <p class="text-[10px] font-black text-cyan-400 uppercase tracking-[0.3em] mb-3">The Pipeline</p>
                <h2 class="text-4xl md:text-5xl font-black tracking-tight">RAG: Retrieval-Augmented Generation</h2>
                <p class="text-slate-500 mt-4 max-w-2xl mx-auto">Every question travels through a seven-stage pipeline. Each stage refines the raw data into a precise, trustworthy answer.</p>
            </div>

            <!-- Pipeline visualization -->
            <div class="relative">
                <!-- Connection line -->
                <div class="absolute top-8 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-slate-800 to-transparent hidden lg:block"></div>

                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-4 lg:gap-2">
                    {#each pipelineSteps as step, i}
                        {@const isActive = pipelineStep === i}
                        {@const isPast = pipelineStep > i}
                        <div class="relative flex flex-col items-center text-center group">
                            <!-- Node -->
                            <div
                                class="w-16 h-16 rounded-2xl flex items-center justify-center relative z-10 transition-all duration-500 {isActive ? 'scale-125' : 'scale-100'}"
                                style="
                                    background: {isActive || isPast ? step.color + '20' : '#0a0a0a'};
                                    border: 2px solid {isActive ? step.color : isPast ? step.color + '60' : '#1e293b'};
                                    box-shadow: {isActive ? `0 0 30px ${step.color}40, 0 0 60px ${step.color}15` : 'none'};
                                "
                            >
                                <step.icon
                                    class="w-7 h-7 transition-colors duration-500"
                                    style="color: {isActive || isPast ? step.color : '#475569'}"
                                />
                                {#if isActive}
                                    <div class="absolute inset-0 rounded-2xl animate-ping opacity-20" style="background: {step.color}"></div>
                                {/if}
                            </div>

                            <!-- Arrow (desktop) -->
                            {#if i < pipelineSteps.length - 1}
                                <div class="absolute top-8 -right-1 z-20 hidden lg:block">
                                    <ArrowRight class="w-3 h-3 {isPast ? 'text-slate-500' : 'text-slate-800'} transition-colors duration-500" />
                                </div>
                            {/if}

                            <!-- Label -->
                            <div class="mt-4 space-y-1">
                                <p class="text-xs font-black uppercase tracking-wider transition-colors duration-500"
                                    style="color: {isActive ? step.color : '#94a3b8'}">
                                    {step.title}
                                </p>
                                <p class="text-[10px] text-slate-600 leading-relaxed max-w-[140px] mx-auto hidden lg:block">
                                    {step.desc}
                                </p>
                                <p class="text-xs text-slate-500 leading-relaxed lg:hidden">
                                    {step.desc}
                                </p>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>

            <!-- Pipeline detail cards -->
            <div class="grid md:grid-cols-2 gap-6 mt-20">
                <div class="p-6 rounded-3xl bg-[#0a0a0a] border border-cyan-500/10">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-xl bg-cyan-950 border border-cyan-500/20 flex items-center justify-center">
                            <Search class="w-5 h-5 text-cyan-400" />
                        </div>
                        <h3 class="text-sm font-black uppercase tracking-wider text-cyan-400">Hybrid Search</h3>
                    </div>
                    <p class="text-sm text-slate-400 leading-relaxed">
                        Archie combines <strong class="text-white">vector similarity search</strong> (finding semantically similar content using 768-dimensional embeddings)
                        with <strong class="text-white">full-text search</strong> (BM25 keyword matching via SQLite FTS5). The results are merged and re-ranked to give the best of both worlds — understanding meaning <em>and</em> matching exact terms.
                    </p>
                </div>
                <div class="p-6 rounded-3xl bg-[#0a0a0a] border border-purple-500/10">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-xl bg-purple-950 border border-purple-500/20 flex items-center justify-center">
                            <Sparkles class="w-5 h-5 text-purple-400" />
                        </div>
                        <h3 class="text-sm font-black uppercase tracking-wider text-purple-400">Grounded Generation</h3>
                    </div>
                    <p class="text-sm text-slate-400 leading-relaxed">
                        Unlike generic AI, Archie's responses are <strong class="text-white">grounded in your documents</strong>.
                        The retrieved chunks, relevant knowledge claims, and topic context are injected into the prompt — so the AI can only speak about what it actually knows from your data. Every answer can be traced back to its source.
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- ===== SECTION 3: Knowledge Graph Deep Dive ===== -->
    <section data-section="3" class="relative min-h-screen flex items-center justify-center px-6 py-32">
        <div class="max-w-6xl mx-auto w-full relative z-10">
            <div class="text-center mb-16">
                <p class="text-[10px] font-black text-purple-400 uppercase tracking-[0.3em] mb-3">The Secret Weapon</p>
                <h2 class="text-4xl md:text-5xl font-black tracking-tight">The Knowledge Graph</h2>
                <p class="text-slate-500 mt-4 max-w-2xl mx-auto">
                    This is what makes Archie different. Instead of just storing text, it builds a structured map of concepts, their relationships, and verified facts.
                </p>
            </div>

            <div class="grid lg:grid-cols-2 gap-12 items-center">
                <!-- Interactive Graph Visualization -->
                <div class="relative aspect-square max-w-lg mx-auto w-full">
                    <div class="absolute inset-0 rounded-3xl bg-[#0a0a0a] border border-slate-800/50 overflow-hidden">
                        <!-- Grid background -->
                        <svg class="absolute inset-0 w-full h-full opacity-10">
                            <defs>
                                <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#334155" stroke-width="0.5"/>
                                </pattern>
                            </defs>
                            <rect width="100%" height="100%" fill="url(#grid)" />
                        </svg>

                        <!-- Graph SVG -->
                        <svg class="absolute inset-0 w-full h-full" viewBox="0 0 100 100">
                            <!-- Edges -->
                            {#each demoEdges as edge, i}
                                {@const from = demoNodes[edge.from]}
                                {@const to = demoNodes[edge.to]}
                                {@const isHighlighted = graphAnimPhase === (i % 4)}
                                <line
                                    x1={from.x} y1={from.y}
                                    x2={to.x} y2={to.y}
                                    stroke={isHighlighted ? '#78FAAE' : '#1e293b'}
                                    stroke-width={isHighlighted ? 0.6 : 0.3}
                                    class="transition-all duration-700"
                                    stroke-dasharray={isHighlighted ? '0' : '1 1'}
                                >
                                    {#if isHighlighted}
                                        <animate attributeName="stroke-opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite" />
                                    {/if}
                                </line>
                                <!-- Data flow particle -->
                                {#if isHighlighted}
                                    <circle r="0.8" fill="#78FAAE">
                                        <animateMotion dur="1.5s" repeatCount="indefinite" path="M{from.x},{from.y} L{to.x},{to.y}" />
                                    </circle>
                                {/if}
                            {/each}

                            <!-- Nodes -->
                            {#each demoNodes as node}
                                {@const colors = categoryColors[node.category]}
                                <!-- Glow -->
                                <circle
                                    cx={node.x} cy={node.y} r={node.r * 0.15 + 2}
                                    fill="none"
                                    stroke={colors.stroke}
                                    stroke-width="0.3"
                                    opacity="0.3"
                                    class="animate-pulse-slow"
                                />
                                <!-- Node circle -->
                                <circle
                                    cx={node.x} cy={node.y} r={node.r * 0.12}
                                    fill={colors.fill}
                                    stroke={colors.stroke}
                                    stroke-width="0.4"
                                    class="transition-all duration-500 cursor-pointer hover:scale-110"
                                    style="filter: drop-shadow(0 0 4px {colors.glow})"
                                />
                                <!-- Label -->
                                <text
                                    x={node.x} y={node.y + 0.5}
                                    text-anchor="middle"
                                    dominant-baseline="middle"
                                    fill={colors.text}
                                    font-size="2.2"
                                    font-weight="bold"
                                    class="pointer-events-none select-none"
                                    style="font-family: system-ui, sans-serif"
                                >
                                    {node.label}
                                </text>
                            {/each}
                        </svg>

                        <!-- Legend -->
                        <div class="absolute bottom-3 left-3 flex gap-3">
                            {#each Object.entries(categoryColors) as [cat, col]}
                                <div class="flex items-center gap-1.5">
                                    <div class="w-2 h-2 rounded-full" style="background: {col.stroke}"></div>
                                    <span class="text-[8px] font-bold uppercase tracking-wider" style="color: {col.stroke}">{cat}</span>
                                </div>
                            {/each}
                        </div>

                        <!-- "LIVE" indicator -->
                        <div class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-[#0E3A2F]/50 border border-[#78FAAE]/20">
                            <div class="w-1.5 h-1.5 rounded-full bg-[#78FAAE] animate-pulse"></div>
                            <span class="text-[8px] font-black text-[#78FAAE] uppercase tracking-widest">Live Graph</span>
                        </div>
                    </div>
                </div>

                <!-- Graph explanation -->
                <div class="space-y-6">
                    {#each [
                        { icon: Target, title: 'Topics', desc: 'Every document is analyzed to extract key concepts — technologies, patterns, processes. Topics are categorized (Technical, Architecture, Best Practice, Organizational Norm) and can form hierarchies.', color: '#22d3ee', accent: 'cyan' },
                        { icon: Link2, title: 'Relationships', desc: 'Archie discovers how topics connect: "uses", "depends on", "implements", "conflicts with". These directed edges create a navigable web of knowledge that reveals hidden patterns.', color: '#a855f7', accent: 'purple' },
                        { icon: BookOpen, title: 'Claims', desc: 'Factual statements are extracted and linked to both topics and source documents. When documents change, claims are re-validated — conflicts are automatically detected and flagged.', color: '#f59e0b', accent: 'amber' },
                        { icon: Activity, title: 'Living System', desc: 'The graph evolves with your data. Update a document and Archie automatically reconciles: stale claims are retired, new topics emerge, and relationships adapt. It\'s a living map of organizational knowledge.', color: '#78FAAE', accent: 'green' },
                    ] as item, i}
                        <div class="group flex gap-4 p-4 rounded-2xl hover:bg-white/[0.02] transition-colors duration-300">
                            <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-110 group-hover:rotate-6 duration-500"
                                style="background: {item.color}15; border: 1px solid {item.color}30;">
                                <item.icon class="w-5 h-5" style="color: {item.color}" />
                            </div>
                            <div>
                                <h3 class="font-black text-sm tracking-tight mb-1" style="color: {item.color}">{item.title}</h3>
                                <p class="text-xs text-slate-500 leading-relaxed">{item.desc}</p>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    </section>

    <!-- ===== SECTION 4: Knowledge Extraction Deep Dive ===== -->
    <section data-section="4" class="relative min-h-screen flex items-center justify-center px-6 py-32">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="text-center mb-16">
                <p class="text-[10px] font-black text-amber-400 uppercase tracking-[0.3em] mb-3">Under The Hood</p>
                <h2 class="text-4xl md:text-5xl font-black tracking-tight">How Knowledge Is Extracted</h2>
                <p class="text-slate-500 mt-4 max-w-2xl mx-auto">
                    When a document enters the system, it goes through a multi-stage AI analysis. Here's what happens behind the scenes.
                </p>
            </div>

            <!-- Process flow visualization -->
            <div class="relative space-y-4">
                {#each [
                    {
                        step: '01',
                        title: 'Document Chunking',
                        desc: 'The document is split into overlapping segments of ~500 characters with ~100 character overlap. This ensures no information falls between the cracks at chunk boundaries.',
                        visual: 'chunk',
                        color: '#78FAAE'
                    },
                    {
                        step: '02',
                        title: 'Vector Embedding',
                        desc: 'Each chunk is sent to Gemini\'s text-embedding-004 model, which returns a 768-dimensional vector capturing the semantic meaning. These vectors are stored in SQLite using the sqlite-vec extension for efficient similarity search.',
                        visual: 'embed',
                        color: '#22d3ee'
                    },
                    {
                        step: '03',
                        title: 'Topic Extraction',
                        desc: 'Gemini analyzes the full document against existing topics and extracts new ones. Each topic gets a name, description, and category. The AI also identifies parent-child relationships for hierarchical organization.',
                        visual: 'topic',
                        color: '#a855f7'
                    },
                    {
                        step: '04',
                        title: 'Relationship Discovery',
                        desc: 'The AI identifies directed relationships between topics: "SvelteKit uses TypeScript", "REST API implements Authentication". These edges connect the graph and enable traversal-based retrieval.',
                        visual: 'relation',
                        color: '#ec4899'
                    },
                    {
                        step: '05',
                        title: 'Claim Extraction',
                        desc: 'Atomic factual statements are extracted and linked to topics. Each claim carries a content hash for version tracking. When documents change, claims are compared and conflicts are surfaced.',
                        visual: 'claim',
                        color: '#f59e0b'
                    },
                ] as proc, i}
                    <div class="group relative grid md:grid-cols-[80px_1fr] gap-6 p-6 rounded-3xl bg-[#0a0a0a]/80 border border-slate-800/30 hover:border-slate-700/50 transition-all duration-500">
                        <!-- Step number -->
                        <div class="flex md:flex-col items-center md:items-center gap-4 md:gap-2">
                            <span class="text-3xl font-black tracking-tighter transition-colors duration-500" style="color: {proc.color}30; group-hover:color: {proc.color}">
                                {proc.step}
                            </span>
                            {#if i < 4}
                                <div class="hidden md:block w-px flex-1 bg-gradient-to-b from-slate-800 to-transparent"></div>
                            {/if}
                        </div>

                        <!-- Content -->
                        <div class="space-y-3">
                            <h3 class="text-lg font-black tracking-tight transition-colors duration-300" style="color: {proc.color}">
                                {proc.title}
                            </h3>
                            <p class="text-sm text-slate-400 leading-relaxed">{proc.desc}</p>

                            <!-- Visual representation -->
                            {#if proc.visual === 'chunk'}
                                <div class="flex gap-1 mt-3 overflow-hidden">
                                    {#each Array(7) as _, j}
                                        <div
                                            class="h-8 rounded-lg flex items-center justify-center text-[8px] font-mono font-bold transition-all duration-500"
                                            style="
                                                flex: {j === 3 ? 2 : 1};
                                                background: {j === 3 ? '#78FAAE15' : '#0f0f0f'};
                                                border: 1px solid {j === 3 ? '#78FAAE30' : '#1e293b'};
                                                color: {j === 3 ? '#78FAAE' : '#475569'};
                                            "
                                        >
                                            {j === 2 ? '...overlap' : j === 3 ? 'CHUNK' : j === 4 ? 'overlap...' : ''}
                                        </div>
                                    {/each}
                                </div>
                            {:else if proc.visual === 'embed'}
                                <div class="flex gap-0.5 items-end mt-3 h-10">
                                    {#each Array(40) as _, j}
                                        <div
                                            class="flex-1 rounded-t-sm min-w-[3px] vector-bar"
                                            style="
                                                height: {20 + Math.sin(j * 0.5) * 30 + Math.cos(j * 0.3) * 20}%;
                                                background: linear-gradient(to top, #0e7490, #22d3ee);
                                                opacity: {0.3 + Math.abs(Math.sin(j * 0.4)) * 0.7};
                                                animation-delay: {j * 50}ms;
                                            "
                                        ></div>
                                    {/each}
                                    <span class="text-[8px] font-mono text-cyan-600 ml-2 self-center whitespace-nowrap">768 dims</span>
                                </div>
                            {:else if proc.visual === 'topic'}
                                <div class="flex flex-wrap gap-2 mt-3">
                                    {#each [
                                        { name: 'SvelteKit', cat: 'Technical' },
                                        { name: 'REST API', cat: 'Architecture' },
                                        { name: 'Auth', cat: 'Architecture' },
                                        { name: 'Testing', cat: 'Best Practice' },
                                    ] as t}
                                        {@const c = categoryColors[t.cat]}
                                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold"
                                            style="background: {c.fill}30; border: 1px solid {c.stroke}30; color: {c.stroke}">
                                            <span class="w-1.5 h-1.5 rounded-full" style="background: {c.stroke}"></span>
                                            {t.name}
                                        </span>
                                    {/each}
                                </div>
                            {:else if proc.visual === 'relation'}
                                <div class="flex items-center gap-3 mt-3 flex-wrap">
                                    {#each [
                                        { from: 'SvelteKit', to: 'TypeScript', rel: 'uses' },
                                        { from: 'REST API', to: 'Auth', rel: 'implements' },
                                    ] as r}
                                        <div class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#0f0f0f] border border-pink-500/10">
                                            <span class="text-[10px] font-bold text-cyan-400">{r.from}</span>
                                            <span class="text-[8px] font-mono text-pink-400 px-1.5 py-0.5 rounded bg-pink-500/10">{r.rel}</span>
                                            <ArrowRight class="w-3 h-3 text-slate-600" />
                                            <span class="text-[10px] font-bold text-purple-400">{r.to}</span>
                                        </div>
                                    {/each}
                                </div>
                            {:else if proc.visual === 'claim'}
                                <div class="space-y-2 mt-3">
                                    {#each [
                                        'SvelteKit uses file-based routing for all endpoints',
                                        'Authentication is handled via session cookies',
                                    ] as claim}
                                        <div class="flex items-start gap-2 px-3 py-2 rounded-xl bg-[#0f0f0f] border border-amber-500/10">
                                            <div class="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0"></div>
                                            <span class="text-[10px] text-amber-200/70 leading-relaxed">{claim}</span>
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
    <section data-section="5" class="relative min-h-screen flex items-center justify-center px-6 py-32">
        <div class="max-w-5xl mx-auto w-full relative z-10">
            <div class="text-center mb-16">
                <p class="text-[10px] font-black text-[#78FAAE] uppercase tracking-[0.3em] mb-3">Built With</p>
                <h2 class="text-4xl md:text-5xl font-black tracking-tight">Technology Stack</h2>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                {#each [
                    { name: 'SvelteKit 5', desc: 'Full-stack framework', icon: Zap, color: '#ff3e00' },
                    { name: 'TypeScript', desc: 'Type-safe codebase', icon: FileText, color: '#3178c6' },
                    { name: 'SQLite', desc: 'Embedded database', icon: Database, color: '#0f9fdb' },
                    { name: 'Gemini AI', desc: 'LLM & embeddings', icon: Sparkles, color: '#f59e0b' },
                    { name: 'sqlite-vec', desc: 'Vector similarity', icon: Cpu, color: '#22d3ee' },
                    { name: 'FTS5', desc: 'Full-text search', icon: Search, color: '#a855f7' },
                    { name: 'Git Sync', desc: 'Repo integration', icon: GitBranch, color: '#78FAAE' },
                    { name: 'Tailwind', desc: 'Utility-first CSS', icon: Layers, color: '#38bdf8' },
                ] as tech}
                    <div class="group p-5 rounded-2xl bg-[#0a0a0a] border border-slate-800/30 hover:border-slate-700/50 transition-all duration-500 text-center">
                        <div class="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3 transition-transform group-hover:scale-110 group-hover:-rotate-6 duration-500"
                            style="background: {tech.color}10; border: 1px solid {tech.color}20;">
                            <tech.icon class="w-6 h-6" style="color: {tech.color}" />
                        </div>
                        <h3 class="text-sm font-black tracking-tight">{tech.name}</h3>
                        <p class="text-[10px] text-slate-600 mt-1">{tech.desc}</p>
                    </div>
                {/each}
            </div>

            <!-- Key features grid -->
            <div class="mt-16 grid md:grid-cols-2 gap-6">
                <div class="p-6 rounded-3xl bg-gradient-to-br from-[#0E3A2F]/20 to-transparent border border-[#78FAAE]/10">
                    <h3 class="text-sm font-black uppercase tracking-wider text-[#78FAAE] mb-3">🔒 Multi-User Auth</h3>
                    <p class="text-xs text-slate-500 leading-relaxed">
                        Role-based access control with admin and user roles. Session-based authentication with Argon2 password hashing. Admins manage users, documents, and the knowledge base.
                    </p>
                </div>
                <div class="p-6 rounded-3xl bg-gradient-to-br from-cyan-950/20 to-transparent border border-cyan-500/10">
                    <h3 class="text-sm font-black uppercase tracking-wider text-cyan-400 mb-3">📁 Git Integration</h3>
                    <p class="text-xs text-slate-500 leading-relaxed">
                        Connect any Git repository and Archie will clone, index, and watch it for changes. Supports filtering by file extension and directory. Push new docs and they're automatically processed.
                    </p>
                </div>
                <div class="p-6 rounded-3xl bg-gradient-to-br from-purple-950/20 to-transparent border border-purple-500/10">
                    <h3 class="text-sm font-black uppercase tracking-wider text-purple-400 mb-3">💬 Conversation Memory</h3>
                    <p class="text-xs text-slate-500 leading-relaxed">
                        Full conversation history per user. Resume any previous chat, delete conversations you no longer need, and start fresh anytime. Context is carried through the entire thread.
                    </p>
                </div>
                <div class="p-6 rounded-3xl bg-gradient-to-br from-amber-950/20 to-transparent border border-amber-500/10">
                    <h3 class="text-sm font-black uppercase tracking-wider text-amber-400 mb-3">⚡ Conflict Detection</h3>
                    <p class="text-xs text-slate-500 leading-relaxed">
                        When documents are updated, the knowledge graph detects conflicting claims. Old facts are retired, new ones take their place, and contradictions are flagged for review.
                    </p>
                </div>
            </div>
        </div>
    </section>

    <!-- ===== SECTION 6: CTA ===== -->
    <section data-section="6" class="relative min-h-[60vh] flex items-center justify-center px-6 py-32">
        <div class="text-center space-y-8 relative z-10">
            <div class="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-[#0E3A2F] to-[#78FAAE] flex items-center justify-center shadow-2xl shadow-[#0E3A2F]/60 animate-float">
                <Bot class="w-10 h-10 text-[#0E3A2F]" />
            </div>
            <h2 class="text-3xl md:text-4xl font-black tracking-tight">Ready to explore your knowledge?</h2>
            <p class="text-slate-500 max-w-md mx-auto">Start a conversation with Archie or explore the knowledge graph to see the connections in your data.</p>
            <div class="flex flex-wrap justify-center gap-4">
                <a href="/" class="inline-flex items-center gap-2 px-8 py-3 rounded-2xl bg-[#0E3A2F] border border-[#78FAAE]/30 text-[#78FAAE] font-black text-sm uppercase tracking-wider hover:bg-[#78FAAE] hover:text-[#0E3A2F] transition-all duration-300 shadow-lg shadow-[#0E3A2F]/40 hover:shadow-[#78FAAE]/20">
                    <MessageSquare class="w-4 h-4" />
                    Start Chatting
                </a>
                <a href="/knowledge" class="inline-flex items-center gap-2 px-8 py-3 rounded-2xl bg-[#0a0a0a] border border-slate-800 text-white font-black text-sm uppercase tracking-wider hover:border-cyan-500/50 hover:text-cyan-400 transition-all duration-300">
                    <Network class="w-4 h-4" />
                    Knowledge Graph
                </a>
            </div>
        </div>
    </section>

    <!-- Footer -->
    <footer class="border-t border-slate-800/30 py-8 text-center">
        <p class="text-[10px] font-bold text-slate-700 uppercase tracking-[0.2em]">
            Built with SvelteKit, SQLite & Gemini AI
        </p>
    </footer>

    <!-- Progress dots (fixed) -->
    <div class="fixed right-6 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-2">
        {#each ['Hero', 'Overview', 'Pipeline', 'Graph', 'Extraction', 'Tech', 'Start'] as label, i}
            <button
                onclick={() => {
                    const el = document.querySelector(`[data-section="${i}"]`);
                    el?.scrollIntoView({ behavior: 'smooth' });
                }}
                class="group relative w-2.5 h-2.5 rounded-full transition-all duration-300 {activeSection === i ? 'bg-[#78FAAE] scale-125 shadow-[0_0_8px_rgba(120,250,174,0.5)]' : 'bg-slate-800 hover:bg-slate-600'}"
                aria-label="Go to {label}"
            >
                <span class="absolute right-6 top-1/2 -translate-y-1/2 text-[9px] font-bold uppercase tracking-wider whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 pointer-events-none">
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

    .particle {
        animation: float-particle linear infinite;
    }

    @keyframes float-particle {
        0% { transform: translateY(0) translateX(0); opacity: 0; }
        10% { opacity: var(--tw-opacity, 0.3); }
        90% { opacity: var(--tw-opacity, 0.3); }
        100% { transform: translateY(-100vh) translateX(20px); opacity: 0; }
    }

    .animate-pulse-slow {
        animation: pulse-slow 4s ease-in-out infinite;
    }

    @keyframes pulse-slow {
        0%, 100% { opacity: 0.3; transform: scale(1); }
        50% { opacity: 0.7; transform: scale(1.05); }
    }

    .animate-float {
        animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-10px); }
    }

    .vector-bar {
        animation: vector-wave 2s ease-in-out infinite;
    }

    @keyframes vector-wave {
        0%, 100% { transform: scaleY(1); }
        50% { transform: scaleY(0.7); }
    }

    /* Custom scrollbar matching the app */
    :global(.custom-scrollbar::-webkit-scrollbar) {
        width: 4px;
    }
    :global(.custom-scrollbar::-webkit-scrollbar-track) {
        background: transparent;
    }
    :global(.custom-scrollbar::-webkit-scrollbar-thumb) {
        background: #1e293b;
        border-radius: 4px;
    }
</style>
