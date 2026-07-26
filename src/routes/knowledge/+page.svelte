<script lang="ts">
    /**
     * Knowledge explorer.
     *
     * Everything on this page is server-paged. It previously loaded the entire
     * graph — every topic with its description, every relationship, every claim —
     * in one request and filtered, counted and grouped it in the browser, so it got
     * slower with every ingested document. The per-card counts were the worst of
     * it: each rendered topic card ran `claims.filter(...)` and
     * `relationships.filter(...)` over the full arrays, making a page of N cards
     * cost N × (claims + relationships).
     *
     * Now: 20 rows per request, counts computed by SQLite, and the graph fetched as
     * a bounded connected subgraph (see lib/server/knowledge-queries.ts and
     * lib/server/knowledge-graph.ts).
     */
    import { onMount } from 'svelte';
    import Search from '@lucide/svelte/icons/search';
    import FileCheck from '@lucide/svelte/icons/file-check';
    import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
    import Tag from '@lucide/svelte/icons/tag';
    import ChevronRight from '@lucide/svelte/icons/chevron-right';
    import ChevronLeft from '@lucide/svelte/icons/chevron-left';
    import GitBranch from '@lucide/svelte/icons/git-branch';
    import Loader2 from '@lucide/svelte/icons/loader-2';
    import { fade, slide } from 'svelte/transition';
    import KnowledgeGraph from '$lib/components/KnowledgeGraph.svelte';
    import Pagination from '$lib/components/Pagination.svelte';

    interface Topic {
        id: number;
        name: string;
        description: string | null;
        category: string | null;
        claim_count: number;
        rel_count: number;
    }
    interface Claim {
        id: number;
        topic_id: number;
        topic_name: string;
        topic_category: string | null;
        claim_text: string;
        claim_type: string;
        status: string;
        doc_name: string | null;
    }
    interface Stats {
        topics: number;
        relationships: number;
        claims: number;
        categories: { category: string; count: number }[];
    }

    type Tab = 'topics' | 'claims' | 'graph';

    let activeTab = $state<Tab>('topics');
    let searchQuery = $state('');
    let selectedCategory = $state('All');
    let categories = $state<string[]>([]);
    let stats = $state<Stats | null>(null);

    let topics = $state<Topic[]>([]);
    let topicPage = $state(1);
    let topicPageSize = $state(20);
    let topicTotal = $state(0);
    let topicTotalPages = $state(1);
    let topicSort = $state('connections');
    let topicsLoading = $state(true);

    let claims = $state<Claim[]>([]);
    let claimPage = $state(1);
    let claimPageSize = $state(20);
    let claimTotal = $state(0);
    let claimTotalPages = $state(1);
    let claimsLoading = $state(false);
    let claimsLoaded = false;

    /** Topic filter for the claims tab: id is authoritative, name is for display. */
    let topicFilter = $state<{ id: number; name: string } | null>(null);

    onMount(() => {
        loadStats();
        loadTopics();
    });

    async function loadStats() {
        try {
            const res = await fetch('/api/knowledge/stats');
            if (res.ok) {
                stats = await res.json();
                categories = (stats?.categories ?? [])
                    .map(c => c.category)
                    .filter(c => c && c !== 'Uncategorized');
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function loadTopics() {
        topicsLoading = true;
        try {
            const params = new URLSearchParams({
                page: String(topicPage),
                pageSize: String(topicPageSize),
                sort: topicSort
            });
            if (searchQuery.trim()) params.set('search', searchQuery.trim());
            if (selectedCategory !== 'All') params.set('category', selectedCategory);

            const res = await fetch(`/api/knowledge/topics?${params}`);
            if (res.ok) {
                const payload = await res.json();
                topics = payload.topics;
                topicTotal = payload.total;
                topicTotalPages = payload.totalPages;
                if (payload.categories?.length) categories = payload.categories;
            }
        } catch (err) {
            console.error(err);
        } finally {
            topicsLoading = false;
        }
    }

    async function loadClaims() {
        claimsLoading = true;
        claimsLoaded = true;
        try {
            const params = new URLSearchParams({
                page: String(claimPage),
                pageSize: String(claimPageSize)
            });
            if (searchQuery.trim()) params.set('search', searchQuery.trim());
            if (selectedCategory !== 'All') params.set('category', selectedCategory);
            if (topicFilter) params.set('topicId', String(topicFilter.id));

            const res = await fetch(`/api/knowledge/claims?${params}`);
            if (res.ok) {
                const payload = await res.json();
                claims = payload.claims;
                claimTotal = payload.total;
                claimTotalPages = payload.totalPages;
            }
        } catch (err) {
            console.error(err);
        } finally {
            claimsLoading = false;
        }
    }

    /** Reloads whichever list the user is looking at. The graph reloads itself. */
    function reloadActive() {
        if (activeTab === 'topics') loadTopics();
        else if (activeTab === 'claims') loadClaims();
    }

    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    function onSearchInput() {
        if (searchTimer) clearTimeout(searchTimer);
        // Debounced so a typed query is one request, not one per keystroke —
        // each of these now costs a SQL round trip rather than an array filter.
        searchTimer = setTimeout(() => {
            topicPage = 1;
            claimPage = 1;
            reloadActive();
        }, 280);
    }

    function pickCategory(cat: string) {
        selectedCategory = cat;
        topicPage = 1;
        claimPage = 1;
        reloadActive();
    }

    function switchTab(tab: Tab) {
        activeTab = tab;
        if (tab === 'claims' && !claimsLoaded) loadClaims();
    }

    function showClaimsFor(topicId: number, topicName: string) {
        topicFilter = { id: topicId, name: topicName };
        claimPage = 1;
        activeTab = 'claims';
        loadClaims();
    }

    function clearTopicFilter() {
        topicFilter = null;
        claimPage = 1;
        loadClaims();
    }

    const CATEGORY_SLUGS: Record<string, string> = {
        Technical: 'technical',
        Architecture: 'architecture',
        'Best Practice': 'practice',
        'Organizational Norm': 'norm'
    };
    function categorySlug(cat: string | null | undefined): string {
        return (cat && CATEGORY_SLUGS[cat]) || 'other';
    }
</script>

<div class="min-h-screen p-6 max-w-7xl mx-auto">
    <nav class="mb-5">
        <a href="/" class="btn btn-ghost btn-sm -ml-2.5">
            <ChevronLeft class="w-4 h-4" />
            Back to chat
        </a>
    </nav>

    <header class="mb-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
            <h1 class="page-title">Knowledge graph</h1>
            <p class="page-subtitle mt-1 max-w-xl">
                Structured, interconnected knowledge extracted from your documents.
            </p>
            {#if stats}
                <p class="text-xs text-faint mt-2 tabular-nums" in:fade>
                    {stats.topics} topics · {stats.relationships} relationships · {stats.claims} claims
                </p>
            {/if}
        </div>

        <div class="tabs flex-shrink-0">
            <button onclick={() => switchTab('topics')} class="tab {activeTab === 'topics' ? 'tab-active' : ''}">
                Topics
            </button>
            <button onclick={() => switchTab('claims')} class="tab {activeTab === 'claims' ? 'tab-active' : ''}">
                Claims
            </button>
            <button onclick={() => switchTab('graph')} class="tab {activeTab === 'graph' ? 'tab-active' : ''}">
                Graph
            </button>
        </div>
    </header>

    {#if activeTab !== 'graph'}
        <div class="flex flex-col md:flex-row gap-2 mb-5" transition:slide>
            <div class="relative flex-1">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
                <input
                    type="text"
                    bind:value={searchQuery}
                    oninput={onSearchInput}
                    placeholder="Search topics and claims…"
                    class="field pl-9 py-2.5"
                />
            </div>

            {#if activeTab === 'topics'}
                <label class="flex items-center gap-1.5">
                    <span class="eyebrow whitespace-nowrap">Sort</span>
                    <select
                        bind:value={topicSort}
                        onchange={() => { topicPage = 1; loadTopics(); }}
                        class="field w-auto text-xs py-2"
                    >
                        <option value="connections">Most connected</option>
                        <option value="claims">Most claims</option>
                        <option value="name">Name</option>
                        <option value="recent">Newest</option>
                    </select>
                </label>
            {/if}

            <div class="flex gap-1.5 overflow-x-auto pb-1 md:pb-0">
                {#each ['All', ...categories] as cat}
                    <button
                        onclick={() => pickCategory(cat)}
                        class="btn btn-sm whitespace-nowrap {selectedCategory === cat ? 'btn-secondary' : 'btn-ghost'}"
                        aria-pressed={selectedCategory === cat}
                    >
                        {cat}
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    {#if activeTab === 'topics'}
        <div in:fade>
            {#if topicsLoading && topics.length === 0}
                <div class="flex flex-col items-center justify-center py-24 gap-3">
                    <div class="spinner w-7 h-7"></div>
                    <p class="text-[13px] text-mute">Loading topics…</p>
                </div>
            {:else if topics.length === 0}
                <div class="card p-10 text-center">
                    <p class="text-[13px] text-mute">
                        No topics match {searchQuery ? `“${searchQuery}”` : 'these filters'}.
                    </p>
                </div>
            {:else}
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 {topicsLoading ? 'opacity-60 transition-opacity' : ''}">
                    {#each topics as topic (topic.id)}
                        <div class="card card-hover p-4 flex flex-col gap-3">
                            <div class="flex justify-between items-start gap-2">
                                <span class="tag-cat" data-cat={categorySlug(topic.category)}>
                                    {topic.category ?? 'Uncategorized'}
                                </span>
                                <span class="chip flex-shrink-0" title="Related topics">
                                    <GitBranch class="w-3 h-3" />
                                    {topic.rel_count}
                                </span>
                            </div>

                            <div>
                                <h3 class="text-sm font-semibold text-strong">{topic.name}</h3>
                                <p class="text-[13px] text-mute leading-relaxed line-clamp-3 mt-1">
                                    {topic.description}
                                </p>
                            </div>

                            <div class="mt-auto pt-3 border-t border-line-subtle flex items-center justify-between">
                                <span class="flex items-center gap-1.5 text-xs text-faint tabular-nums">
                                    <FileCheck class="w-3.5 h-3.5" />
                                    {topic.claim_count} claims
                                </span>
                                <button onclick={() => showClaimsFor(topic.id, topic.name)} class="btn btn-ghost btn-sm">
                                    View
                                    <ChevronRight class="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    {/each}
                </div>

                <div class="mt-4">
                    <Pagination
                        page={topicPage}
                        totalPages={topicTotalPages}
                        total={topicTotal}
                        pageSize={topicPageSize}
                        label="topics"
                        onPage={(p) => { topicPage = p; loadTopics(); }}
                        onPageSize={(size) => { topicPageSize = size; topicPage = 1; loadTopics(); }}
                    />
                </div>
            {/if}
        </div>
    {:else if activeTab === 'claims'}
        <div class="space-y-2" in:fade>
            {#if topicFilter}
                <div class="well flex items-center justify-between gap-3 p-3" in:slide>
                    <div class="flex items-center gap-2.5 min-w-0">
                        <Tag class="w-4 h-4 text-faint flex-shrink-0" />
                        <p class="text-[13px] text-dim truncate">
                            Filtered to <strong class="font-semibold text-body">{topicFilter.name}</strong>
                        </p>
                    </div>
                    <button onclick={clearTopicFilter} class="btn btn-secondary btn-sm flex-shrink-0">
                        Clear filter
                    </button>
                </div>
            {/if}

            {#if claimsLoading && claims.length === 0}
                <div class="flex flex-col items-center justify-center py-24 gap-3">
                    <div class="spinner w-7 h-7"></div>
                    <p class="text-[13px] text-mute">Loading claims…</p>
                </div>
            {:else if claims.length === 0}
                <div class="card p-10 text-center">
                    <p class="text-[13px] text-mute">
                        No claims match {searchQuery ? `“${searchQuery}”` : 'these filters'}.
                    </p>
                </div>
            {:else}
                <div class="space-y-2 {claimsLoading ? 'opacity-60 transition-opacity' : ''}">
                    {#each claims as claim (claim.id)}
                        <div class="card card-hover p-4 flex flex-col md:flex-row gap-4 md:items-center">
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <button class="chip" onclick={() => showClaimsFor(claim.topic_id, claim.topic_name)}>
                                        {claim.topic_name}
                                    </button>
                                    {#if claim.status === 'conflicting'}
                                        <span class="badge badge-danger">
                                            <AlertTriangle class="w-3 h-3" /> Conflict
                                        </span>
                                    {/if}
                                </div>
                                <p class="text-sm text-body leading-relaxed mt-2">
                                    {claim.claim_text}
                                </p>
                            </div>

                            <div class="md:text-right md:min-w-[9rem] flex-shrink-0">
                                <p class="eyebrow">Source</p>
                                <p class="text-xs text-mute font-mono truncate mt-1" title={claim.doc_name ?? ''}>
                                    {claim.doc_name ?? '—'}
                                </p>
                            </div>
                        </div>
                    {/each}
                </div>

                <div class="pt-2">
                    <Pagination
                        page={claimPage}
                        totalPages={claimTotalPages}
                        total={claimTotal}
                        pageSize={claimPageSize}
                        label="claims"
                        onPage={(p) => { claimPage = p; loadClaims(); }}
                        onPageSize={(size) => { claimPageSize = size; claimPage = 1; loadClaims(); }}
                    />
                </div>
            {/if}
        </div>
    {:else}
        <div in:fade>
            <KnowledgeGraph {categories} onViewClaims={showClaimsFor} />
        </div>
    {/if}
</div>
