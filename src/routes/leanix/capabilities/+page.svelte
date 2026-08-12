<script lang="ts">
    /**
     * Capability map — the LeanIX portfolio projected onto two frames:
     * the Škoda Auto business capability map, and the technology tower model.
     *
     * The technical frame draws the FACTSHEETS themselves, not a count of them:
     * a landscape map whose cells read "4 factsheets" makes an architect click
     * every cell to find out what is in the estate, which is the one thing a map
     * is supposed to save them. Names in the cells, colour by lifecycle, detail
     * on click.
     *
     * The empty cells are load-bearing too. A map that only drew what is covered
     * would answer "what do we have", which the factsheet list already answers.
     * Drawing the whole taxonomy answers "where is nothing".
     */
    import ChevronLeft from '@lucide/svelte/icons/chevron-left';
    import ExternalLink from '@lucide/svelte/icons/external-link';
    import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
    import Search from '@lucide/svelte/icons/search';
    import X from '@lucide/svelte/icons/x';
    import { fade } from 'svelte/transition';

    let { data } = $props();

    type Frame = 'business' | 'technical';
    let frame = $state<Frame>('technical');
    let query = $state('');
    let onlyCovered = $state(false);

    type Selection =
        | { kind: 'factsheet'; id: string }
        | {
              kind: 'list';
              title: string;
              subtitle: string;
              factsheets: { id: string; name: string; fs_type: string }[];
          };
    let selected = $state<Selection | null>(null);

    function openFactsheet(id: string) {
        selected = selected?.kind === 'factsheet' && selected.id === id ? null : { kind: 'factsheet', id };
    }
    function openList(title: string, subtitle: string, factsheets: { id: string; name: string; fs_type: string }[]) {
        selected =
            selected?.kind === 'list' && selected.title === title && selected.subtitle === subtitle
                ? null
                : { kind: 'list', title, subtitle, factsheets };
    }

    const detail = $derived(selected?.kind === 'factsheet' ? data.details[selected.id] : null);

    const matches = (name: string | null | undefined) =>
        !query.trim() || (name ?? '').toLowerCase().includes(query.trim().toLowerCase());

    /**
     * Colour carries lifecycle, because on a landscape map that is the fact an
     * architect is scanning for — what is on the way out and what is not.
     */
    const LIFECYCLE_TONE: Record<string, string> = {
        active: 'border-l-success',
        phaseIn: 'border-l-info',
        plan: 'border-l-accent',
        phaseOut: 'border-l-warning',
        endOfLife: 'border-l-danger'
    };
    const tone = (state: string | null) => LIFECYCLE_TONE[state ?? ''] ?? 'border-l-line-strong';

    const LIFECYCLE_LABEL: Record<string, string> = {
        active: 'Active',
        phaseIn: 'Phase in',
        plan: 'Plan',
        phaseOut: 'Phase out',
        endOfLife: 'End of life'
    };
    const lifecycleLabel = (s: string | null) => (s ? (LIFECYCLE_LABEL[s] ?? s) : 'Lifecycle not set');

    /** A sub-tower is shown when anything inside it survives the filter. */
    function subTowerMatches(sub: { name: string; capabilities: { name: string; factsheets: { name: string }[] }[] }, towerName: string) {
        if (!query.trim()) return true;
        return (
            matches(sub.name) ||
            matches(towerName) ||
            sub.capabilities.some((c) => matches(c.name) || c.factsheets.some((f) => matches(f.name)))
        );
    }

    const businessVisible = $derived(
        data.business.domains.filter(
            (d) =>
                (!onlyCovered || d.total > 0) &&
                (!query.trim() ||
                    matches(d.name) ||
                    d.groups.some((g) => matches(g.name) || g.capabilities.some((c) => matches(c.name))) ||
                    d.factsheets.some((f) => matches(f.name)))
        )
    );

    const technicalVisible = $derived(
        data.technical.towers.filter(
            (t) => (!onlyCovered || t.total > 0) && t.subTowers.some((s) => subTowerMatches(s, t.name))
        )
    );
</script>

<svelte:head><title>Capability map</title></svelte:head>

{#snippet factsheetTile(
    f: { id: string; name: string; fs_type: string; lifecycle_state: string | null },
    via: string[] = []
)}
    <button
        onclick={() => openFactsheet(f.id)}
        class="w-full text-left pl-2 pr-2 py-1.5 rounded border border-l-2 bg-raised hover:border-accent transition-colors {tone(
            f.lifecycle_state
        )} {selected?.kind === 'factsheet' && selected.id === f.id ? 'border-accent' : 'border-line-subtle'}"
        title="{f.name} — {f.fs_type}, {lifecycleLabel(f.lifecycle_state)}{via.length > 0
            ? `\n${via.join(', ')}`
            : ''}"
    >
        <span class="block text-[11px] text-body leading-snug line-clamp-2">{f.name}</span>
    </button>
{/snippet}

<div class="min-h-screen p-6 max-w-7xl mx-auto">
    <nav class="mb-5 flex gap-1">
        <a href="/leanix" class="btn btn-ghost btn-sm -ml-2.5">
            <ChevronLeft class="w-4 h-4" />
            Portfolio
        </a>
    </nav>

    <header class="mb-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
            <h1 class="page-title">Capability map</h1>
            <p class="page-subtitle mt-1 max-w-2xl">
                The {data.status.total} Enterprise-tagged LeanIX factsheets, placed on the technology tower model and
                the Škoda Auto business capability map.
            </p>
        </div>
        <div class="tabs flex-shrink-0">
            <button onclick={() => { frame = 'technical'; selected = null; }} class="tab {frame === 'technical' ? 'tab-active' : ''}">
                Technical
            </button>
            <button onclick={() => { frame = 'business'; selected = null; }} class="tab {frame === 'business' ? 'tab-active' : ''}">
                Business
            </button>
        </div>
    </header>

    <div class="flex flex-col md:flex-row gap-2 mb-5">
        <div class="relative flex-1">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
            <input type="text" bind:value={query} placeholder="Filter by capability or factsheet name…" class="field pl-9 py-2.5" />
        </div>
        <button class="btn btn-sm {onlyCovered ? 'btn-secondary' : 'btn-ghost'}" onclick={() => (onlyCovered = !onlyCovered)} aria-pressed={onlyCovered}>
            {onlyCovered ? 'Showing covered only' : 'Show all, including gaps'}
        </button>
    </div>

    {#if frame === 'technical'}
        {@const s = data.technical.stats}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4" in:fade>
            {#each [
                { label: 'Towers', value: `${s.towers}`, hint: 'one axis, no nested layers' },
                { label: 'Sub-towers', value: `${s.subTowers}`, hint: `${s.subTowersCovered} with factsheets` },
                { label: 'Capabilities placed', value: `${s.placed}/${s.referenced}`, hint: 'LeanIX technology stack values' },
                { label: 'Unmapped', value: `${s.unmapped}`, hint: 'need an alias entry' }
            ] as kpi}
                <div class="card p-4">
                    <p class="eyebrow">{kpi.label}</p>
                    <p class="text-2xl font-semibold text-strong tabular-nums mt-1">{kpi.value}</p>
                    <p class="text-[11px] text-faint mt-0.5">{kpi.hint}</p>
                </div>
            {/each}
        </div>

        <div class="well p-4 mb-4">
            <p class="text-[12px] text-dim leading-relaxed">
                <span class="text-strong">One axis:</span> a tower is a kind of technology capability and owns it
                end to end, from raw resource to the abstraction an application consumes. No tower is the “platform
                layer” of another — Compute holds servers, virtualization, containers <em>and</em> runtimes, and
                Data&nbsp;&amp;&nbsp;Storage holds raw storage, database platforms <em>and</em> caches, symmetrically.
                Adapted from the TBM Technology Resource Towers layer, which mixes the two; the towers and the LeanIX
                mapping live in <code>capability-taxonomy.ts</code>.
            </p>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
                <span class="eyebrow">Lifecycle</span>
                {#each [['active', 'Active'], ['phaseIn', 'Phase in'], ['plan', 'Plan'], ['phaseOut', 'Phase out'], ['endOfLife', 'End of life'], ['', 'Not set']] as [key, label]}
                    <span class="flex items-center gap-1.5 text-[11px] text-mute">
                        <span class="w-2.5 h-2.5 rounded-sm border-l-2 {tone(key)} bg-raised"></span>
                        {label}
                    </span>
                {/each}
            </div>
        </div>

        <div class="flex flex-col gap-3" in:fade>
            {#each technicalVisible as tower (tower.name)}
                <section class="card p-5">
                    <div class="flex items-baseline justify-between gap-3 mb-1">
                        <h2 class="text-sm font-semibold text-strong">{tower.name}</h2>
                        <span class="text-[11px] text-faint tabular-nums shrink-0">
                            {tower.total} component{tower.total === 1 ? '' : 's'}
                        </span>
                    </div>
                    <p class="text-xs text-faint mb-3">{tower.description}</p>

                    <div class="grid md:grid-cols-2 xl:grid-cols-4 gap-3 items-start">
                        {#each tower.subTowers as sub (sub.name)}
                            {#if (!onlyCovered || sub.total > 0) && subTowerMatches(sub, tower.name)}
                                <div class="rounded-lg border {sub.total > 0 ? 'border-line' : 'border-line-subtle border-dashed'} p-2.5">
                                    <div class="flex items-baseline justify-between gap-2 mb-2">
                                        <p class="eyebrow">{sub.name}</p>
                                        <span class="text-[10px] tabular-nums {sub.total > 0 ? 'text-mute' : 'text-ghost'}">
                                            {sub.total || '–'}
                                        </span>
                                    </div>

                                    {#if sub.factsheets.length === 0}
                                        <p class="text-[11px] text-ghost italic py-1">No factsheets</p>
                                    {:else}
                                        <!-- The LeanIX capability values behind this cell, as a caption
                                             rather than as repeated groupings: a component tagged both
                                             "Databases" and "Relational Database" belongs in the cell
                                             once. Each is clickable for the capability's own list. -->
                                        <p class="text-[10px] text-faint mb-1.5 leading-snug">
                                            {#each sub.capabilities as cap, i (cap.name)}<button
                                                    class="hover:text-accent"
                                                    onclick={() => openList(cap.name, `${tower.name} › ${sub.name}`, cap.factsheets)}
                                                    title="Show factsheets for this capability"
                                                >{cap.name}</button>{#if i < sub.capabilities.length - 1}<span class="text-ghost">&nbsp;·&nbsp;</span>{/if}{/each}
                                        </p>
                                        <div class="flex flex-col gap-1">
                                            {#each sub.factsheets as f (f.id)}
                                                {#if !query.trim() || matches(f.name) || matches(sub.name) || matches(tower.name) || f.via.some((v) => matches(v))}
                                                    {@render factsheetTile(f, f.via)}
                                                {/if}
                                            {/each}
                                        </div>
                                    {/if}
                                </div>
                            {/if}
                        {/each}
                    </div>
                </section>
            {/each}
        </div>

        {#if data.technical.unmapped.length > 0}
            <section class="card p-5 mt-4 border-warning/40">
                <h2 class="text-sm font-semibold text-strong mb-1">Not placed on a tower</h2>
                <p class="text-xs text-faint mb-3">
                    LeanIX technology-stack values with no matching tower and no alias entry.
                </p>
                <div class="flex flex-wrap gap-1.5">
                    {#each data.technical.unmapped as u (u.name)}
                        <button class="chip" onclick={() => openList(u.name, 'Unmapped', u.factsheets)}>
                            {u.name}
                            <span class="text-faint tabular-nums ml-1">{u.factsheets.length}</span>
                        </button>
                    {/each}
                </div>
            </section>
        {/if}
    {:else}
        {@const s = data.business.stats}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4" in:fade>
            {#each [
                { label: 'Domains', value: `${s.domains}`, hint: `${s.stubDomains} without detail in the workbook` },
                { label: 'Capabilities', value: `${s.capabilities}`, hint: 'level 3, from the workbook' },
                { label: 'Capabilities covered', value: `${s.capabilitiesCovered}`, hint: 'with at least one factsheet' },
                { label: 'Placed', value: `${s.placed}/${s.referenced}`, hint: `${s.unmapped} could not be placed` }
            ] as kpi}
                <div class="card p-4">
                    <p class="eyebrow">{kpi.label}</p>
                    <p class="text-2xl font-semibold text-strong tabular-nums mt-1">{kpi.value}</p>
                    <p class="text-[11px] text-faint mt-0.5">{kpi.hint}</p>
                </div>
            {/each}
        </div>

        <div class="well p-4 mb-5 flex gap-3">
            <TriangleAlert class="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div class="text-[12px] text-dim leading-relaxed">
                <p>
                    <span class="text-strong">The workbook does not cover the domains these factsheets sit in.</span>
                    Its detail is the commercial side — Sales, Marketing, Partner Network, Customer Management,
                    After Sales, Communication, Product Management, Digital &amp; Mobility Service Provisioning.
                    <span class="text-strong">IT, Finance, HR &amp; General Affairs, Manufacturing, R&amp;D, Procurement
                    and Supply Chain are level-1 stubs with no capabilities beneath them</span>, and that is where
                    almost every Enterprise-tagged application lands.
                </p>
                <p class="mt-2">
                    None of the {s.referenced} capability names LeanIX uses appears in the workbook at any level, so
                    the placements below are to the <em>domain</em> only and were assigned by hand in
                    <code>capability-taxonomy.ts</code>. Supply the missing branches and the map deepens without any
                    other change.
                </p>
                <p class="mt-2 text-faint">Source: {data.business.source}</p>
            </div>
        </div>

        <div class="flex flex-col gap-3" in:fade>
            {#each businessVisible as domain (domain.name)}
                <section class="card p-5">
                    <div class="flex items-baseline justify-between gap-3 mb-3">
                        <h2 class="text-sm font-semibold text-strong">{domain.name}</h2>
                        <span class="text-[11px] text-faint tabular-nums shrink-0">
                            {domain.total} factsheet{domain.total === 1 ? '' : 's'}
                            {#if domain.groups.length > 0}
                                · {domain.groups.reduce((n, g) => n + g.capabilities.length, 0)} capabilities
                            {/if}
                        </span>
                    </div>

                    {#if domain.stub}
                        <p class="text-[11px] text-faint italic mb-3">
                            No level-2 or level-3 detail for this domain in the source workbook — factsheets are
                            placed on the domain itself.
                        </p>
                    {/if}

                    {#if domain.factsheets.length > 0}
                        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-3">
                            {#each [...new Map(domain.factsheets.map((f) => [f.id, f])).values()] as f (f.id)}
                                {#if matches(f.name)}
                                    {@render factsheetTile(f)}
                                {/if}
                            {/each}
                        </div>
                    {/if}

                    {#each domain.groups as group (group.name)}
                        {#if !onlyCovered || group.total > 0}
                            <div class="mb-4 last:mb-0">
                                <div class="flex items-baseline justify-between gap-2 mb-2">
                                    <p class="eyebrow">{group.name}</p>
                                    <span class="text-[10px] text-faint tabular-nums">{group.total}</span>
                                </div>
                                <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                                    {#each group.capabilities as cap (cap.name)}
                                        {#if matches(cap.name) || matches(group.name) || matches(domain.name)}
                                            <button
                                                onclick={() => openList(cap.name, `${domain.name} › ${group.name}`, cap.factsheets)}
                                                class="text-left px-2.5 py-2 rounded-lg border transition-colors hover:border-accent {cap
                                                    .factsheets.length > 0
                                                    ? 'bg-accent-quiet/25 border-accent-quiet/60 text-body'
                                                    : 'bg-well border-line-subtle text-faint'}"
                                                title={cap.groupRef ?? cap.name}
                                            >
                                                <span class="block text-[11px] leading-snug line-clamp-2">{cap.name}</span>
                                                <span class="block text-[10px] tabular-nums mt-1 opacity-70">
                                                    {cap.factsheets.length === 0
                                                        ? 'no factsheets'
                                                        : `${cap.factsheets.length} factsheet${cap.factsheets.length === 1 ? '' : 's'}`}
                                                </span>
                                            </button>
                                        {/if}
                                    {/each}
                                </div>
                            </div>
                        {/if}
                    {/each}
                </section>
            {/each}
        </div>

        {#if data.business.unmapped.length > 0}
            <section class="card p-5 mt-4 border-warning/40">
                <h2 class="text-sm font-semibold text-strong mb-1">Not placed on the map</h2>
                <p class="text-xs text-faint mb-3">
                    LeanIX capability names with no home in the taxonomy and no entry in the alias table. Listed
                    rather than dropped — each is a line to add to <code>capability-taxonomy.ts</code>.
                </p>
                <div class="flex flex-wrap gap-1.5">
                    {#each data.business.unmapped as u (u.name)}
                        <button class="chip" onclick={() => openList(u.name, 'Unmapped', u.factsheets)}>
                            {u.name}
                            <span class="text-faint tabular-nums ml-1">{u.factsheets.length}</span>
                        </button>
                    {/each}
                </div>
            </section>
        {/if}
    {/if}
</div>

<!-- Detail panel: a single factsheet, or the factsheets under one capability -->
{#if selected}
    <aside
        class="fixed right-4 bottom-4 w-[24rem] max-h-[72vh] overflow-y-auto bg-raised border border-line rounded-2xl shadow-xl p-4 z-40"
        transition:fade={{ duration: 120 }}
    >
        {#if detail}
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <p class="text-sm font-semibold text-strong">{detail.name}</p>
                    <p class="text-[11px] text-faint">
                        {detail.fs_type}{detail.category ? ` · ${detail.category}` : ''}
                    </p>
                </div>
                <button class="btn btn-ghost btn-icon shrink-0" onclick={() => (selected = null)} aria-label="Close">
                    <X class="w-4 h-4" />
                </button>
            </div>

            {#if detail.description}
                <p class="text-[12px] text-dim mt-3 leading-relaxed line-clamp-6">{detail.description}</p>
            {/if}

            <dl class="mt-3 divide-y divide-[var(--line-subtle)]">
                {#each [
                    { k: 'Lifecycle', v: lifecycleLabel(detail.lifecycle_state) },
                    { k: 'Technical fit', v: detail.technical_fit ?? 'Not set' },
                    { k: 'Business criticality', v: detail.business_criticality ?? 'Not set' },
                    { k: 'Vendor', v: detail.vendor ?? '—' },
                    { k: 'Organisation', v: detail.org ?? '—' },
                    { k: 'End of life', v: detail.end_of_life_date ?? '—' },
                    { k: 'Used by', v: detail.app_count > 0 ? `${detail.app_count} applications` : '—' },
                    { k: 'Completeness', v: detail.completion != null ? `${Math.round(detail.completion * 100)}%` : '—' }
                ] as row}
                    <div class="flex items-baseline justify-between gap-3 py-1.5">
                        <dt class="text-[11px] text-faint shrink-0">{row.k}</dt>
                        <dd class="text-[12px] text-dim text-right">{row.v}</dd>
                    </div>
                {/each}
            </dl>

            {#if detail.capabilities}
                <div class="mt-3">
                    <p class="eyebrow mb-1">Technology capabilities</p>
                    <p class="text-[11px] text-mute leading-relaxed">{detail.capabilities}</p>
                </div>
            {/if}

            {#if detail.url}
                <a href={detail.url} target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm mt-4 w-full justify-center">
                    <ExternalLink class="w-3.5 h-3.5" />
                    Open in LeanIX
                </a>
            {/if}
        {:else if selected.kind === 'list'}
            <div class="flex items-start justify-between gap-2 mb-1">
                <div class="min-w-0">
                    <p class="text-sm font-semibold text-strong">{selected.title}</p>
                    <p class="text-[11px] text-faint">{selected.subtitle}</p>
                </div>
                <button class="btn btn-ghost btn-icon shrink-0" onclick={() => (selected = null)} aria-label="Close">
                    <X class="w-4 h-4" />
                </button>
            </div>

            {#if selected.factsheets.length === 0}
                <p class="text-[12px] text-mute mt-3">
                    No factsheet supports this capability. That is the finding, not an error.
                </p>
            {:else}
                <div class="flex flex-col gap-1 mt-3">
                    {#each [...new Map(selected.factsheets.map((f) => [f.id, f])).values()] as f (f.id)}
                        <div class="flex items-start justify-between gap-2 py-1.5 border-b border-line-subtle last:border-0">
                            <button class="text-left min-w-0 hover:text-accent" onclick={() => openFactsheet(f.id)}>
                                <span class="block text-[12px] text-body truncate">{f.name}</span>
                                <span class="block text-[10px] text-faint">
                                    {f.fs_type} · {lifecycleLabel(data.details[f.id]?.lifecycle_state ?? null)}
                                </span>
                            </button>
                            {#if data.details[f.id]?.url}
                                <a
                                    href={data.details[f.id].url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="text-faint hover:text-accent shrink-0 mt-0.5"
                                    title="Open in LeanIX"
                                >
                                    <ExternalLink class="w-3 h-3" />
                                </a>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        {/if}
    </aside>
{/if}
