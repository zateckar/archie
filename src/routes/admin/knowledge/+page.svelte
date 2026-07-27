<script lang="ts">
    /**
     * Admin knowledge review.
     *
     * Rewritten off the whole-corpus endpoint for the same reason as the public
     * explorer: this page used to fetch every topic, relationship and claim
     * (including superseded ones) and derive its four review tabs, its stats row
     * and its graph from that one array in the browser. Each tab now asks SQLite
     * for the rows it actually reviews, 20 at a time.
     *
     * The graph is the shared KnowledgeGraph component — this file previously held
     * a second, drifting copy of the canvas force-layout code.
     */
    import { onMount } from 'svelte';
    import Network from '@lucide/svelte/icons/network';
    import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
    import CheckCircle from '@lucide/svelte/icons/check-circle';
    import XCircle from '@lucide/svelte/icons/x-circle';
    import ChevronDown from '@lucide/svelte/icons/chevron-down';
    import ChevronRight from '@lucide/svelte/icons/chevron-right';
    import Eye from '@lucide/svelte/icons/eye';
    import Tag from '@lucide/svelte/icons/tag';
    import FileCheck from '@lucide/svelte/icons/file-check';
    import Layers from '@lucide/svelte/icons/layers';
    import GitBranch from '@lucide/svelte/icons/git-branch';
    import RefreshCw from '@lucide/svelte/icons/refresh-cw';
    import Wand2 from '@lucide/svelte/icons/wand-2';
    import Loader2 from '@lucide/svelte/icons/loader-2';
    import History from '@lucide/svelte/icons/history';
    import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
    import { fade, slide } from 'svelte/transition';
    import KnowledgeGraph from '$lib/components/KnowledgeGraph.svelte';
    import Pagination from '$lib/components/Pagination.svelte';

    // ── Types ──
    interface Claim {
        id: number;
        topic_id: number;
        topic_name: string;
        topic_category: string | null;
        claim_text: string;
        claim_type: string;
        status: string;
        created_at: string;
        doc_name: string | null;
        superseded_by: number | null;
        superseded_at: string | null;
        successor_text: string | null;
    }
    interface Stats {
        topics: number;
        relationships: number;
        claims: number;
        conflicting: number;
        flagged: number;
        superseded: number;
        categories: { category: string; count: number }[];
        orphanTopics: number;
    }
    interface TreeRow {
        id: number;
        name: string;
        category: string | null;
        parent_topic_id: number | null;
        claim_count: number;
        rel_count: number;
    }

    type Tab = 'graph' | 'conflicts' | 'flagged' | 'superseded' | 'hierarchy';

    let activeTab = $state<Tab>('graph');
    let stats = $state<Stats | null>(null);
    let statsLoading = $state(true);
    let categories = $derived((stats?.categories ?? []).map(c => c.category).filter(c => c !== 'Uncategorized'));

    /** One review tab's paged claim list. */
    interface ReviewList {
        claims: Claim[];
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
        loading: boolean;
        loaded: boolean;
    }
    const emptyList = (): ReviewList => ({
        claims: [], page: 1, pageSize: 20, total: 0, totalPages: 1, loading: false, loaded: false
    });

    let conflicts = $state<ReviewList>(emptyList());
    let flagged = $state<ReviewList>(emptyList());
    let superseded = $state<ReviewList>(emptyList());

    let expandedTopic = $state<number | null>(null);
    /** Active claims for the expanded conflict topic, fetched on demand. */
    let comparisonClaims = $state<Claim[]>([]);
    let comparisonLoading = $state(false);
    let resolving = $state<number | null>(null);

    let tree = $state<TreeRow[]>([]);
    let treeLoaded = false;
    let treeLoading = $state(false);
    let expandedTreeNodes = $state(new Set<number>());

    let rebuildingTaxonomy = $state(false);
    let taxonomyResult = $state<{ total: number; updated: number } | null>(null);
    let backfillingEmbeddings = $state(false);
    let backfillResult = $state<{ topicsEmbedded: number; claimsEmbedded: number } | null>(null);

    // ── Automatic rebuild schedule ──
    /** Mirrors TaxonomyScheduleStatus in $lib/server/knowledge. */
    interface TaxonomySchedule {
        intervalMs: number;
        source: 'ui' | 'env' | 'default';
        envConfigured: boolean;
        lastRebuildAt: number | null;
        nextDueAt: number | null;
        due: boolean;
        orphanTopics: number;
    }
    let schedule = $state<TaxonomySchedule | null>(null);
    let scheduleLoading = $state(false);
    let savingSchedule = $state(false);
    let scheduleError = $state<string | null>(null);

    const HOUR_MS = 3600000;
    const DAY_MS = 24 * HOUR_MS;

    /**
     * Offered intervals. Days, not milliseconds: the stored unit is ms because
     * that is what the scheduler compares against, but nobody reasons about a
     * rebuild cadence in milliseconds.
     *
     * The floor the server enforces is 1 hour; the shortest option here is a day,
     * because anything tighter re-approaches the per-sync rebuild this schedule
     * replaced. An operator who genuinely wants hourly can still set the env var.
     */
    const INTERVAL_PRESETS = [
        { ms: 0, label: 'Off — manual rebuilds only' },
        { ms: 1 * DAY_MS, label: 'Every day' },
        { ms: 3 * DAY_MS, label: 'Every 3 days' },
        { ms: 7 * DAY_MS, label: 'Every 7 days (default)' },
        { ms: 14 * DAY_MS, label: 'Every 14 days' },
        { ms: 30 * DAY_MS, label: 'Every 30 days' }
    ];

    /**
     * Presets plus, when the value in force is not one of them, the actual value.
     *
     * Without this the select would silently snap an env-configured or
     * hand-edited interval to the nearest option and misreport what is running.
     */
    let intervalOptions = $derived.by(() => {
        const current = schedule?.intervalMs;
        if (current === undefined || INTERVAL_PRESETS.some(p => p.ms === current)) return INTERVAL_PRESETS;
        return [...INTERVAL_PRESETS, { ms: current, label: `${formatDuration(current)} (current)` }]
            .sort((a, b) => a.ms - b.ms);
    });

    function formatDuration(ms: number): string {
        if (ms <= 0) return 'Off';
        if (ms % DAY_MS === 0) {
            const days = ms / DAY_MS;
            return days === 1 ? 'Every day' : `Every ${days} days`;
        }
        if (ms % HOUR_MS === 0) {
            const hours = ms / HOUR_MS;
            return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
        }
        return `Every ${ms} ms`;
    }

    /** "3 days ago" / "in 4 days". Coarse on purpose — this is a weekly-ish cadence. */
    function formatRelative(epochMs: number): string {
        const diff = epochMs - Date.now();
        const future = diff > 0;
        const abs = Math.abs(diff);
        const unit = abs < HOUR_MS ? 'minute' : abs < DAY_MS ? 'hour' : 'day';
        const size = unit === 'minute' ? 60000 : unit === 'hour' ? HOUR_MS : DAY_MS;
        const n = Math.max(1, Math.round(abs / size));
        const plural = n === 1 ? unit : `${unit}s`;
        return future ? `in ${n} ${plural}` : `${n} ${plural} ago`;
    }

    async function loadSchedule() {
        scheduleLoading = true;
        scheduleError = null;
        try {
            const res = await fetch('/api/knowledge/taxonomy-schedule');
            if (res.ok) {
                schedule = await res.json();
            } else {
                scheduleError = 'Could not load the rebuild schedule.';
            }
        } catch (err) {
            console.error(err);
            scheduleError = 'Could not load the rebuild schedule.';
        } finally {
            scheduleLoading = false;
        }
    }

    async function saveInterval(intervalMs: number) {
        savingSchedule = true;
        scheduleError = null;
        try {
            const res = await fetch('/api/knowledge/taxonomy-schedule', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ intervalMs })
            });
            const result = await res.json().catch(() => null);
            if (res.ok) {
                // Render what the server stored, not what was submitted.
                schedule = result;
            } else {
                scheduleError = result?.error ?? 'Could not save the interval.';
                await loadSchedule(); // put the control back in sync with reality
            }
        } catch (err) {
            console.error(err);
            scheduleError = 'Could not save the interval.';
        } finally {
            savingSchedule = false;
        }
    }

    onMount(() => {
        loadStats();
    });

    async function loadStats() {
        statsLoading = true;
        try {
            const res = await fetch('/api/knowledge/stats');
            if (res.ok) stats = await res.json();
        } catch (err) {
            console.error(err);
        } finally {
            statsLoading = false;
        }
    }

    async function loadReview(status: 'conflicting' | 'flagged' | 'superseded') {
        const list = status === 'conflicting' ? conflicts : status === 'flagged' ? flagged : superseded;
        list.loading = true;
        list.loaded = true;
        try {
            const params = new URLSearchParams({
                status,
                page: String(list.page),
                pageSize: String(list.pageSize),
                sort: status === 'superseded' ? 'retired' : 'topic'
            });
            const res = await fetch(`/api/knowledge/claims?${params}`);
            if (res.ok) {
                const payload = await res.json();
                list.claims = payload.claims;
                list.total = payload.total;
                list.totalPages = payload.totalPages;
            }
        } catch (err) {
            console.error(err);
        } finally {
            list.loading = false;
        }
    }

    async function loadTree() {
        treeLoading = true;
        treeLoaded = true;
        try {
            const res = await fetch('/api/knowledge/topics?view=tree');
            if (res.ok) {
                const payload = await res.json();
                tree = payload.topics;
            }
        } catch (err) {
            console.error(err);
        } finally {
            treeLoading = false;
        }
    }

    function switchTab(tab: Tab) {
        activeTab = tab;
        expandedTopic = null;
        if (tab === 'conflicts' && !conflicts.loaded) loadReview('conflicting');
        if (tab === 'flagged' && !flagged.loaded) loadReview('flagged');
        if (tab === 'superseded' && !superseded.loaded) loadReview('superseded');
        if (tab === 'hierarchy' && !treeLoaded) loadTree();
        // The schedule panel lives on this tab; it is cheap and its "due in N days"
        // reading goes stale, so it is refetched on every visit rather than cached.
        if (tab === 'hierarchy') loadSchedule();
    }

    /** Groups the claims on the current page by topic — a page, not a corpus. */
    function groupByTopic(claims: Claim[]): { topicId: number; name: string; category: string | null; claims: Claim[] }[] {
        const groups = new Map<number, { topicId: number; name: string; category: string | null; claims: Claim[] }>();
        for (const c of claims) {
            if (!groups.has(c.topic_id)) {
                groups.set(c.topic_id, { topicId: c.topic_id, name: c.topic_name, category: c.topic_category, claims: [] });
            }
            groups.get(c.topic_id)!.claims.push(c);
        }
        return [...groups.values()];
    }

    let conflictGroups = $derived(groupByTopic(conflicts.claims));
    let flaggedGroups = $derived(groupByTopic(flagged.claims));
    let supersededGroups = $derived(groupByTopic(superseded.claims));

    /**
     * Expanding a conflict pulls that topic's *active* claims — the "current
     * truth" half of the comparison. Fetched per expansion rather than held for
     * every topic in the corpus, which is what the old full payload was for.
     */
    async function toggleTopic(topicId: number, withComparison = false) {
        if (expandedTopic === topicId) {
            expandedTopic = null;
            comparisonClaims = [];
            return;
        }
        expandedTopic = topicId;
        comparisonClaims = [];
        if (!withComparison) return;

        comparisonLoading = true;
        try {
            const res = await fetch(`/api/knowledge/claims?topicId=${topicId}&status=active&pageSize=50`);
            if (res.ok) comparisonClaims = (await res.json()).claims;
        } catch (err) {
            console.error(err);
        } finally {
            comparisonLoading = false;
        }
    }

    async function resolveConflict(claimId: number, action: 'accept' | 'reject' | 'dismiss' | 'restore') {
        resolving = claimId;
        try {
            const res = await fetch('/api/knowledge', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ claimId, action })
            });
            if (res.ok) {
                // Refresh the counts and the list being reviewed; the other tabs
                // reload lazily when opened.
                await loadStats();
                if (activeTab === 'conflicts') await loadReview('conflicting');
                if (activeTab === 'flagged') await loadReview('flagged');
                if (activeTab === 'superseded') await loadReview('superseded');
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
                await loadStats();
                if (treeLoaded) await loadTree();
                // A manual rebuild stamps the schedule, so "last rebuilt" and
                // "next due" both just changed.
                if (schedule) await loadSchedule();
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
                await loadStats();
            }
        } catch (err) {
            console.error(err);
        } finally {
            backfillingEmbeddings = false;
        }
    }

    function refreshAll() {
        loadStats();
        conflicts = emptyList();
        flagged = emptyList();
        superseded = emptyList();
        treeLoaded = false;
        switchTab(activeTab);
    }

    // ── Hierarchy derivations (over the slim tree rows) ──
    interface HierarchyNode { topic: TreeRow; children: HierarchyNode[]; depth: number; expanded: boolean }

    let byCategory = $derived.by(() => {
        const grouped = new Map<string, TreeRow[]>();
        for (const t of tree) {
            const cat = t.category || 'Uncategorized';
            if (!grouped.has(cat)) grouped.set(cat, []);
            grouped.get(cat)!.push(t);
        }
        return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
    });

    let treeRoots = $derived.by(() => {
        const children = new Map<number | null, TreeRow[]>();
        const ids = new Set(tree.map(t => t.id));
        for (const t of tree) {
            // A parent that no longer exists would make its children invisible;
            // treat those as roots.
            const parent = t.parent_topic_id !== null && ids.has(t.parent_topic_id) ? t.parent_topic_id : null;
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent)!.push(t);
        }
        const build = (topic: TreeRow, depth: number): HierarchyNode => ({
            topic,
            // Depth cap: a cycle introduced by a bad taxonomy rebuild would
            // otherwise recurse until the stack overflows.
            children: depth < 12 ? (children.get(topic.id) ?? []).map(c => build(c, depth + 1)) : [],
            depth,
            expanded: expandedTreeNodes.has(topic.id)
        });
        return (children.get(null) ?? []).map(t => build(t, 0));
    });

    function toggleTreeNode(id: number) {
        if (expandedTreeNodes.has(id)) expandedTreeNodes.delete(id);
        else expandedTreeNodes.add(id);
        expandedTreeNodes = new Set(expandedTreeNodes);
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

<div class="p-6">
    <!-- Header -->
    <header class="mb-5 flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div>
            <h1 class="page-title">Knowledge graph</h1>
            <p class="page-subtitle mt-1">Review the extracted graph and resolve conflicts.</p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
            <button onclick={refreshAll} class="btn btn-ghost btn-icon" title="Refresh" aria-label="Refresh">
                <RefreshCw class="w-4 h-4 {statsLoading ? 'animate-spin' : ''}" />
            </button>
            <button
                onclick={triggerTaxonomyRebuild}
                disabled={rebuildingTaxonomy}
                class="btn btn-secondary"
                title="The model reviews all topics and builds an optimal hierarchy"
            >
                {#if rebuildingTaxonomy}
                    <Loader2 class="w-4 h-4 animate-spin" /> Rebuilding
                {:else}
                    <Wand2 class="w-4 h-4" /> Rebuild taxonomy
                {/if}
            </button>
            <button
                onclick={triggerBackfill}
                disabled={backfillingEmbeddings}
                class="btn btn-secondary"
                title="Generate embeddings for topics and claims that are missing them"
            >
                {#if backfillingEmbeddings}
                    <Loader2 class="w-4 h-4 animate-spin" /> Backfilling
                {:else}
                    <RefreshCw class="w-4 h-4" /> Backfill embeddings
                {/if}
            </button>
            <a href="/knowledge" class="btn btn-ghost">
                <Eye class="w-4 h-4" /> Public view
            </a>
        </div>
    </header>

    {#if backfillResult}
        <div class="well p-3 mb-4 text-[13px] text-dim" transition:slide>
            Embedded {backfillResult.topicsEmbedded} topic(s) and {backfillResult.claimsEmbedded} claim(s).
        </div>
    {/if}

    <!-- Stats Row -->
    <!-- The number is the content, so it gets the weight; the icon is a quiet
         locator and only conflict/flagged counts take a status colour, and
         only when they are non-zero. -->
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mb-5">
        {#each [
            { label: 'Topics', value: stats?.topics, icon: Tag, tone: '' },
            { label: 'Relationships', value: stats?.relationships, icon: GitBranch, tone: '' },
            { label: 'Claims', value: stats?.claims, icon: FileCheck, tone: '' },
            { label: 'Conflicts', value: stats?.conflicting, icon: AlertTriangle, tone: (stats?.conflicting ?? 0) > 0 ? 'text-danger' : '' },
            { label: 'Flagged', value: stats?.flagged, icon: Eye, tone: (stats?.flagged ?? 0) > 0 ? 'text-warning' : '' },
            { label: 'Categories', value: stats?.categories?.length, icon: Layers, tone: '' }
        ] as stat}
            <div class="card p-3.5">
                <div class="flex items-center justify-between">
                    <stat.icon class="w-3.5 h-3.5 {stat.tone || 'text-faint'}" />
                    <p class="text-xl font-semibold tracking-tight tabular-nums {stat.tone || 'text-strong'}">
                        {stat.value ?? '—'}
                    </p>
                </div>
                <p class="text-xs text-faint mt-2">{stat.label}</p>
            </div>
        {/each}
    </div>

    <!-- Tab Navigation -->
    <div class="tabs mb-5">
        <button onclick={() => switchTab('graph')} class="tab {activeTab === 'graph' ? 'tab-active' : ''}">
            <Network class="w-4 h-4 inline mr-1.5 -mt-0.5" />Graph
        </button>
        <button onclick={() => switchTab('conflicts')} class="tab {activeTab === 'conflicts' ? 'tab-active' : ''}">
            <AlertTriangle class="w-4 h-4 inline mr-1.5 -mt-0.5" />Conflicts
            {#if (stats?.conflicting ?? 0) > 0}
                <span class="badge badge-danger ml-1.5">{stats?.conflicting}</span>
            {/if}
        </button>
        <button onclick={() => switchTab('flagged')} class="tab {activeTab === 'flagged' ? 'tab-active' : ''}">
            <Eye class="w-4 h-4 inline mr-1.5 -mt-0.5" />Flagged
            {#if (stats?.flagged ?? 0) > 0}
                <span class="badge badge-warning ml-1.5">{stats?.flagged}</span>
            {/if}
        </button>
        <button onclick={() => switchTab('superseded')} class="tab {activeTab === 'superseded' ? 'tab-active' : ''}">
            <History class="w-4 h-4 inline mr-1.5 -mt-0.5" />Superseded
            {#if (stats?.superseded ?? 0) > 0}
                <span class="badge badge-neutral ml-1.5">{stats?.superseded}</span>
            {/if}
        </button>
        <button onclick={() => switchTab('hierarchy')} class="tab {activeTab === 'hierarchy' ? 'tab-active' : ''}">
            <Layers class="w-4 h-4 inline mr-1.5 -mt-0.5" />Hierarchy
        </button>
    </div>

    <!-- ═══ GRAPH TAB ═══ -->
    {#if activeTab === 'graph'}
        <div in:fade>
            <KnowledgeGraph {categories} height="560px" />
        </div>

    <!-- ═══ CONFLICTS TAB ═══ -->
    {:else if activeTab === 'conflicts'}
        <div class="space-y-4" in:fade>
            {#if conflicts.loading && conflicts.claims.length === 0}
                <div class="flex justify-center py-16"><div class="spinner w-7 h-7"></div></div>
            {:else if conflicts.total === 0}
                <div class="card p-10 text-center">
                    <CheckCircle class="w-8 h-8 text-success mx-auto" />
                    <h3 class="text-sm font-semibold text-body mt-3">No conflicts</h3>
                    <p class="text-[13px] text-mute mt-1">All knowledge claims are consistent. No resolution needed.</p>
                </div>
            {:else}
                <div class="well flex items-start gap-3 p-4">
                    <AlertTriangle class="w-4 h-4 text-danger shrink-0 mt-0.5" />
                    <p class="text-[13px] text-dim leading-relaxed">
                        <strong>{conflicts.total}</strong> conflicting claim{conflicts.total !== 1 ? 's' : ''} need review.
                        Expanding a topic loads its active claims for comparison.
                    </p>
                </div>

                {#each conflictGroups as group (group.topicId)}
                    <div class="card overflow-hidden">
                        <button
                            onclick={() => toggleTopic(group.topicId, true)}
                            class="w-full flex items-center justify-between gap-3 p-4 hover:bg-[var(--hover-surface)] transition-colors text-left"
                        >
                            <div class="flex items-center gap-3 min-w-0">
                                {#if expandedTopic === group.topicId}
                                    <ChevronDown class="w-4 h-4 text-faint flex-shrink-0" />
                                {:else}
                                    <ChevronRight class="w-4 h-4 text-faint flex-shrink-0" />
                                {/if}
                                <div class="min-w-0">
                                    <h3 class="text-sm font-medium text-body truncate">{group.name}</h3>
                                    <span class="tag-cat mt-1" data-cat={categorySlug(group.category)}>
                                        {group.category ?? 'Uncategorized'}
                                    </span>
                                </div>
                            </div>
                            <span class="badge badge-danger flex-shrink-0">
                                {group.claims.length} conflict{group.claims.length !== 1 ? 's' : ''}
                            </span>
                        </button>

                        {#if expandedTopic === group.topicId}
                            <div class="border-t border-line-subtle p-4 space-y-4" transition:slide>
                                <div>
                                    <h4 class="eyebrow text-success mb-2 flex items-center gap-1.5">
                                        <CheckCircle class="w-3.5 h-3.5" /> Active claims (current truth)
                                    </h4>
                                    {#if comparisonLoading}
                                        <p class="text-xs text-faint">Loading active claims…</p>
                                    {:else if comparisonClaims.length === 0}
                                        <p class="text-xs text-faint">This topic has no active claims.</p>
                                    {:else}
                                        <div class="space-y-2">
                                            {#each comparisonClaims as claim (claim.id)}
                                                <div class="rounded-lg border border-[color-mix(in_oklab,var(--success)_28%,transparent)] bg-[color-mix(in_oklab,var(--success)_10%,transparent)] p-3">
                                                    <p class="text-[13px] text-dim leading-relaxed">{claim.claim_text}</p>
                                                    <p class="mt-2 text-xs text-faint font-mono">Source: {claim.doc_name ?? '—'}</p>
                                                </div>
                                            {/each}
                                        </div>
                                    {/if}
                                </div>

                                <div>
                                    <h4 class="eyebrow text-danger mb-2 flex items-center gap-1.5">
                                        <AlertTriangle class="w-3.5 h-3.5" /> Conflicting claims (need resolution)
                                    </h4>
                                    <div class="space-y-3">
                                        {#each group.claims as claim (claim.id)}
                                            <div class="rounded-lg border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] p-4">
                                                <p class="text-[13px] text-dim leading-relaxed mb-3">{claim.claim_text}</p>
                                                <div class="flex flex-wrap items-center justify-between gap-2">
                                                    <span class="text-xs text-faint font-mono truncate">Source: {claim.doc_name ?? '—'}</span>
                                                    <div class="flex items-center gap-2">
                                                        <button
                                                            onclick={() => resolveConflict(claim.id, 'accept')}
                                                            disabled={resolving === claim.id}
                                                            class="btn btn-sm btn-secondary text-success"
                                                        >
                                                            <CheckCircle class="w-3 h-3" /> Accept
                                                        </button>
                                                        <button
                                                            onclick={() => resolveConflict(claim.id, 'dismiss')}
                                                            disabled={resolving === claim.id}
                                                            class="btn btn-sm btn-secondary"
                                                        >
                                                            <Eye class="w-3 h-3" /> Dismiss
                                                        </button>
                                                        <button
                                                            onclick={() => resolveConflict(claim.id, 'reject')}
                                                            disabled={resolving === claim.id}
                                                            class="btn btn-sm btn-danger"
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

                <Pagination
                    page={conflicts.page}
                    totalPages={conflicts.totalPages}
                    total={conflicts.total}
                    pageSize={conflicts.pageSize}
                    label="conflicting claims"
                    onPage={(p) => { conflicts.page = p; expandedTopic = null; loadReview('conflicting'); }}
                    onPageSize={(size) => { conflicts.pageSize = size; conflicts.page = 1; loadReview('conflicting'); }}
                />
            {/if}
        </div>

    <!-- ═══ FLAGGED TAB ═══ -->
    {:else if activeTab === 'flagged'}
        <div class="space-y-4" in:fade>
            {#if flagged.loading && flagged.claims.length === 0}
                <div class="flex justify-center py-16"><div class="spinner w-7 h-7"></div></div>
            {:else if flagged.total === 0}
                <div class="card p-10 text-center">
                    <CheckCircle class="w-8 h-8 text-success mx-auto" />
                    <h3 class="text-sm font-semibold text-body mt-3">No flagged claims</h3>
                    <p class="text-[13px] text-mute mt-1">Every extracted claim passed the claim-topic alignment check.</p>
                </div>
            {:else}
                <div class="well flex items-start gap-3 p-4">
                    <Eye class="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <p class="text-[13px] text-dim leading-relaxed">
                        <strong>{flagged.total}</strong> claim{flagged.total !== 1 ? 's' : ''} failed the automatic
                        claim-topic alignment check and are hidden from search and chat until reviewed. Accept to restore
                        them to active use, or reject to delete.
                    </p>
                </div>

                {#each flaggedGroups as group (group.topicId)}
                    <div class="card overflow-hidden">
                        <button
                            onclick={() => toggleTopic(group.topicId)}
                            class="w-full flex items-center justify-between gap-3 p-4 hover:bg-[var(--hover-surface)] transition-colors text-left"
                        >
                            <div class="flex items-center gap-3 min-w-0">
                                {#if expandedTopic === group.topicId}
                                    <ChevronDown class="w-4 h-4 text-faint flex-shrink-0" />
                                {:else}
                                    <ChevronRight class="w-4 h-4 text-faint flex-shrink-0" />
                                {/if}
                                <div class="min-w-0">
                                    <h3 class="text-sm font-medium text-body truncate">{group.name}</h3>
                                    <span class="tag-cat mt-1" data-cat={categorySlug(group.category)}>
                                        {group.category ?? 'Uncategorized'}
                                    </span>
                                </div>
                            </div>
                            <span class="badge badge-warning flex-shrink-0">{group.claims.length} flagged</span>
                        </button>

                        {#if expandedTopic === group.topicId}
                            <div class="border-t border-line-subtle p-4 space-y-3" transition:slide>
                                {#each group.claims as claim (claim.id)}
                                    <div class="rounded-lg border border-[color-mix(in_oklab,var(--warning)_28%,transparent)] bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] p-4">
                                        <p class="text-[13px] text-dim leading-relaxed mb-3">{claim.claim_text}</p>
                                        <div class="flex flex-wrap items-center justify-between gap-2">
                                            <span class="text-xs text-faint font-mono truncate">Source: {claim.doc_name ?? '—'}</span>
                                            <div class="flex items-center gap-2">
                                                <button
                                                    onclick={() => resolveConflict(claim.id, 'accept')}
                                                    disabled={resolving === claim.id}
                                                    class="btn btn-sm btn-secondary text-success"
                                                >
                                                    <CheckCircle class="w-3 h-3" /> Accept
                                                </button>
                                                <button
                                                    onclick={() => resolveConflict(claim.id, 'reject')}
                                                    disabled={resolving === claim.id}
                                                    class="btn btn-sm btn-danger"
                                                >
                                                    <XCircle class="w-3 h-3" /> Reject
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {/each}

                <Pagination
                    page={flagged.page}
                    totalPages={flagged.totalPages}
                    total={flagged.total}
                    pageSize={flagged.pageSize}
                    label="flagged claims"
                    onPage={(p) => { flagged.page = p; expandedTopic = null; loadReview('flagged'); }}
                    onPageSize={(size) => { flagged.pageSize = size; flagged.page = 1; loadReview('flagged'); }}
                />
            {/if}
        </div>

    <!-- ═══ SUPERSEDED TAB ═══ -->
    {:else if activeTab === 'superseded'}
        <div class="space-y-3" in:fade>
            {#if superseded.loading && superseded.claims.length === 0}
                <div class="flex justify-center py-16"><div class="spinner w-7 h-7"></div></div>
            {:else if superseded.total === 0}
                <div class="card p-10 text-center">
                    <History class="w-8 h-8 text-faint mx-auto" />
                    <h3 class="text-sm font-semibold text-body mt-3">No superseded claims</h3>
                    <p class="text-[13px] text-mute mt-1">No claim has been retired by a newer version yet.</p>
                </div>
            {:else}
                <div class="well flex items-start gap-3 p-4">
                    <History class="w-4 h-4 text-faint shrink-0 mt-0.5" />
                    <p class="text-[13px] text-dim leading-relaxed">
                        <strong class="font-semibold text-body">{superseded.total}</strong>
                        claim{superseded.total !== 1 ? 's' : ''} {superseded.total !== 1 ? 'were' : 'was'} replaced by a
                        newer version and {superseded.total !== 1 ? 'are' : 'is'} excluded from search and chat. Nothing
                        was deleted — restore any claim the checker retired in error.
                    </p>
                </div>

                {#each supersededGroups as group (group.topicId)}
                    <div class="card overflow-hidden">
                        <button
                            onclick={() => toggleTopic(group.topicId)}
                            class="w-full flex items-center justify-between gap-3 p-4 hover:bg-[var(--hover-surface)] transition-colors text-left"
                        >
                            <div class="flex items-center gap-2.5 min-w-0">
                                {#if expandedTopic === group.topicId}
                                    <ChevronDown class="w-4 h-4 text-faint flex-shrink-0" />
                                {:else}
                                    <ChevronRight class="w-4 h-4 text-faint flex-shrink-0" />
                                {/if}
                                <div class="min-w-0">
                                    <h3 class="text-sm font-medium text-body truncate">{group.name}</h3>
                                    <span class="tag-cat mt-1" data-cat={categorySlug(group.category)}>
                                        {group.category ?? 'Uncategorized'}
                                    </span>
                                </div>
                            </div>
                            <span class="badge badge-neutral flex-shrink-0">{group.claims.length} superseded</span>
                        </button>

                        {#if expandedTopic === group.topicId}
                            <div class="border-t border-line-subtle p-4 space-y-2.5" transition:slide>
                                {#each group.claims as claim (claim.id)}
                                    <div class="well p-4">
                                        <p class="text-[13px] text-mute leading-relaxed line-through decoration-[var(--line-strong)]">
                                            {claim.claim_text}
                                        </p>

                                        {#if claim.successor_text}
                                            <div class="mt-3 rounded-lg border border-[color-mix(in_oklab,var(--success)_28%,transparent)] bg-[color-mix(in_oklab,var(--success)_10%,transparent)] p-3">
                                                <p class="eyebrow text-success">Replaced by</p>
                                                <p class="text-[13px] text-dim leading-relaxed mt-1">{claim.successor_text}</p>
                                            </div>
                                        {:else if claim.superseded_by}
                                            <p class="mt-3 text-xs text-warning">
                                                Replacement claim #{claim.superseded_by} is no longer present (deleted or itself superseded).
                                            </p>
                                        {/if}

                                        <div class="flex items-center justify-between gap-3 mt-3">
                                            <p class="text-xs text-faint font-mono truncate">
                                                {claim.doc_name ?? '—'}{#if claim.superseded_at} · retired {claim.superseded_at}{/if}
                                            </p>
                                            <button
                                                onclick={() => resolveConflict(claim.id, 'restore')}
                                                disabled={resolving === claim.id}
                                                class="btn btn-secondary btn-sm flex-shrink-0"
                                            >
                                                <RotateCcw class="w-3.5 h-3.5" /> Restore
                                            </button>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {/each}

                <Pagination
                    page={superseded.page}
                    totalPages={superseded.totalPages}
                    total={superseded.total}
                    pageSize={superseded.pageSize}
                    label="superseded claims"
                    onPage={(p) => { superseded.page = p; expandedTopic = null; loadReview('superseded'); }}
                    onPageSize={(size) => { superseded.pageSize = size; superseded.page = 1; loadReview('superseded'); }}
                />
            {/if}
        </div>

    <!-- ═══ HIERARCHY TAB ═══ -->
    {:else if activeTab === 'hierarchy'}
        {#if treeLoading && tree.length === 0}
            <div class="flex justify-center py-16"><div class="spinner w-7 h-7"></div></div>
        {:else}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4" in:fade>
                <!-- By category -->
                <div class="card p-5">
                    <h3 class="text-sm font-semibold text-strong mb-4 flex items-center gap-2">
                        <Layers class="w-4 h-4 text-faint" />
                        By category
                    </h3>
                    <div class="space-y-4 max-h-[32rem] overflow-y-auto pr-1">
                        {#each byCategory as [category, rows]}
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    <span class="tag-cat" data-cat={categorySlug(category)}>{category}</span>
                                    <span class="text-xs text-faint tabular-nums">{rows.length} topic{rows.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div class="space-y-0.5">
                                    {#each rows.slice(0, 25) as topic (topic.id)}
                                        <div class="flex items-center justify-between gap-3 py-1.5 px-3 rounded-lg hover:bg-[var(--hover-surface)] transition-colors">
                                            <span class="text-[13px] text-dim truncate">{topic.name}</span>
                                            <span class="flex-shrink-0 text-[11px] text-faint tabular-nums">
                                                {topic.claim_count} claims · {topic.rel_count} rels
                                            </span>
                                        </div>
                                    {/each}
                                    {#if rows.length > 25}
                                        <p class="px-3 pt-1 text-[11px] text-faint">
                                            + {rows.length - 25} more — use the Topics list on the
                                            <a href="/knowledge" class="text-accent underline">public view</a> to page through them.
                                        </p>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>

                <!-- Parent/child tree -->
                <div class="card p-5">
                    <h3 class="text-sm font-semibold text-strong mb-4 flex items-center gap-2">
                        <GitBranch class="w-4 h-4 text-faint" />
                        Topic tree
                    </h3>
                    {#if treeRoots.length === 0}
                        <p class="text-[13px] text-mute">No topics yet.</p>
                    {:else}
                        <div class="space-y-0.5 max-h-[32rem] overflow-y-auto pr-1">
                            {#each treeRoots as node (node.topic.id)}
                                {@render treeNode(node)}
                            {/each}
                        </div>
                    {/if}

                    {#if taxonomyResult}
                        <div class="well p-3 mt-4" transition:slide>
                            <p class="eyebrow">Taxonomy rebuild complete</p>
                            <p class="text-[13px] text-dim mt-1">
                                <strong class="text-body">{taxonomyResult.updated}</strong> of {taxonomyResult.total} topics assigned to parents.
                            </p>
                        </div>
                    {/if}

                    <!-- Automatic rebuild schedule.
                         Surfaced here rather than buried in deployment config because
                         this interval is the app's largest single lever on token spend:
                         a full rebuild sends every topic back to the model, and it used
                         to run after every git sync. -->
                    <div class="well p-3 mt-4">
                        <div class="flex items-center justify-between gap-2">
                            <p class="eyebrow">Automatic rebuild</p>
                            {#if schedule}
                                {#if schedule.intervalMs === 0}
                                    <span class="badge badge-neutral">Off</span>
                                {:else if schedule.due}
                                    <span class="badge badge-warning">Due</span>
                                {:else}
                                    <span class="badge badge-success">Scheduled</span>
                                {/if}
                            {/if}
                        </div>

                        {#if scheduleLoading && !schedule}
                            <p class="text-xs text-mute mt-2">Loading…</p>
                        {:else if schedule}
                            <label for="rebuild-interval" class="block text-xs text-mute mt-2 mb-1.5">
                                How often the model re-derives the whole hierarchy
                            </label>
                            <select
                                id="rebuild-interval"
                                class="field"
                                disabled={savingSchedule}
                                value={schedule.intervalMs}
                                onchange={(e) => saveInterval(Number(e.currentTarget.value))}
                            >
                                {#each intervalOptions as opt (opt.ms)}
                                    <option value={opt.ms}>{opt.label}</option>
                                {/each}
                            </select>

                            <dl class="mt-2.5 space-y-1 text-xs">
                                <div class="flex items-baseline justify-between gap-2">
                                    <dt class="text-mute">Last full rebuild</dt>
                                    <dd class="text-dim text-right">
                                        {#if schedule.lastRebuildAt}
                                            {new Date(schedule.lastRebuildAt).toLocaleString()}
                                            <span class="text-faint">({formatRelative(schedule.lastRebuildAt)})</span>
                                        {:else}
                                            <span class="text-faint">Never recorded</span>
                                        {/if}
                                    </dd>
                                </div>
                                <div class="flex items-baseline justify-between gap-2">
                                    <dt class="text-mute">Next</dt>
                                    <dd class="text-dim text-right">
                                        {#if schedule.intervalMs === 0}
                                            <span class="text-faint">Disabled</span>
                                        {:else if schedule.due}
                                            On the next repo sync that changes a document
                                        {:else if schedule.nextDueAt}
                                            {formatRelative(schedule.nextDueAt)}
                                            <span class="text-faint">({new Date(schedule.nextDueAt).toLocaleDateString()})</span>
                                        {/if}
                                    </dd>
                                </div>
                                <div class="flex items-baseline justify-between gap-2">
                                    <dt class="text-mute">Parentless topics</dt>
                                    <dd class="text-dim tabular-nums">{schedule.orphanTopics}</dd>
                                </div>
                            </dl>

                            {#if schedule.source === 'ui' && schedule.envConfigured}
                                <!-- Otherwise an operator stares at TAXONOMY_FULL_REBUILD_INTERVAL_MS
                                     in their config and concludes the variable is broken. -->
                                <p class="text-xs text-mute mt-2 leading-relaxed">
                                    This setting overrides <code class="text-faint">TAXONOMY_FULL_REBUILD_INTERVAL_MS</code>
                                    from the server environment.
                                </p>
                            {:else if schedule.source === 'env'}
                                <p class="text-xs text-mute mt-2 leading-relaxed">
                                    Currently set by <code class="text-faint">TAXONOMY_FULL_REBUILD_INTERVAL_MS</code>.
                                    Changing it here overrides that.
                                </p>
                            {/if}
                        {/if}

                        {#if scheduleError}
                            <p class="text-xs text-danger mt-2" transition:slide>{scheduleError}</p>
                        {/if}
                    </div>

                    <div class="well p-3 mt-4">
                        <p class="eyebrow">How it works</p>
                        <p class="text-xs text-mute mt-1 leading-relaxed">
                            <strong class="text-body">Incremental:</strong> after each document import, new topics are
                            placed into the existing hierarchy automatically. Cheap, but it never revisits an earlier
                            placement, so the hierarchy slowly drifts toward the order documents arrived in.
                            <br />
                            <strong class="text-body">Full rebuild:</strong> the model reviews every topic and rebuilds
                            the hierarchy from scratch, correcting that drift. It sends the whole topic set to the model,
                            so it runs on the schedule above — or on demand via “Rebuild taxonomy”.
                        </p>
                    </div>
                </div>
            </div>
        {/if}
    {/if}
</div>

{#snippet treeNode(node: HierarchyNode)}
    <div style="margin-left: {node.depth * 16}px">
        <button
            onclick={() => node.children.length > 0 && toggleTreeNode(node.topic.id)}
            class="w-full flex items-center gap-2 py-1.5 px-3 rounded-lg hover:bg-[var(--hover-surface)] transition-colors text-left"
        >
            {#if node.children.length > 0}
                {#if node.expanded}
                    <ChevronDown class="w-3.5 h-3.5 text-faint flex-shrink-0" />
                {:else}
                    <ChevronRight class="w-3.5 h-3.5 text-faint flex-shrink-0" />
                {/if}
            {:else}
                <span class="w-3.5 h-3.5 flex items-center justify-center text-faint">·</span>
            {/if}
            <span class="text-[13px] text-dim flex-1 truncate">{node.topic.name}</span>
            {#if node.children.length > 0}
                <span class="text-[11px] text-faint tabular-nums flex-shrink-0">{node.children.length}</span>
            {/if}
            <span class="tag-cat flex-shrink-0" data-cat={categorySlug(node.topic.category)}>
                {node.topic.category ?? '—'}
            </span>
        </button>
        {#if node.expanded && node.children.length > 0}
            {#each node.children as child (child.topic.id)}
                {@render treeNode(child)}
            {/each}
        {/if}
    </div>
{/snippet}
