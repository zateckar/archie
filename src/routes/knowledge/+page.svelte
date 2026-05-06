<script lang="ts">
    import { onMount } from 'svelte';
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
        ChevronLeft
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

    onMount(async () => {
        await loadKnowledge();
    });

    async function loadKnowledge() {
        loading = true;
        try {
            const res = await fetch('/api/knowledge');
            if (res.ok) {
                data = await res.json();
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
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
        </div>
    </header>

    <!-- Search & Filters -->
    <div class="flex flex-col md:flex-row gap-4 mb-8">
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
        {/if}
    {/if}
</div>
