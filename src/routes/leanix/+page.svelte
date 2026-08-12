<script lang="ts">
    /**
     * IT platform portfolio — the LeanIX datasource, read as an overview rather
     * than as a list of factsheets.
     *
     * Every number on this page came out of SQLite in the page's server load
     * (lib/server/leanix-queries.ts). Opening, filtering or sorting it never
     * contacts LeanIX: the daily sync is the only thing that does.
     *
     * The cuts are chosen for domain and enterprise architects — where the load
     * is concentrated, which suppliers the estate depends on, what runs out of
     * runway, and where the record itself is too thin to answer those questions.
     */
    import ChevronLeft from '@lucide/svelte/icons/chevron-left';
    import Search from '@lucide/svelte/icons/search';
    import ExternalLink from '@lucide/svelte/icons/external-link';
    import Layers from '@lucide/svelte/icons/layers';
    import Building2 from '@lucide/svelte/icons/building-2';
    import CalendarClock from '@lucide/svelte/icons/calendar-clock';
    import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
    import { fade } from 'svelte/transition';

    let { data } = $props();

    // ── Table state ──────────────────────────────────────────────────────────
    let query = $state('');
    let typeFilter = $state<'All' | 'Application' | 'ITComponent'>('All');
    let sortKey = $state<'name' | 'app_count' | 'completion' | 'end_of_life_date'>('name');
    let sortDir = $state<'asc' | 'desc'>('asc');

    const filtered = $derived.by(() => {
        const q = query.trim().toLowerCase();
        let rows = data.factsheets.filter((r) => {
            if (typeFilter !== 'All' && r.fs_type !== typeFilter) return false;
            if (!q) return true;
            return [r.name, r.description, r.capabilities, r.vendor, r.org, r.tags, r.category_label]
                .some((v) => v && String(v).toLowerCase().includes(q));
        });

        const dir = sortDir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => {
            const av = a[sortKey];
            const bv = b[sortKey];
            // Nulls always sort last, whichever direction is active: a factsheet
            // with no end-of-life date is not "the soonest".
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
            return String(av).localeCompare(String(bv)) * dir;
        });
    });

    function toggleSort(key: typeof sortKey) {
        if (sortKey === key) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            sortKey = key;
            // Counts and dates are almost always wanted biggest/soonest first.
            sortDir = key === 'name' ? 'asc' : 'desc';
        }
    }

    function relativeTime(ms: number | null): string {
        if (!ms) return 'never';
        const diff = Date.now() - ms;
        const hours = Math.floor(diff / 3_600_000);
        if (hours < 1) return 'just now';
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    const LIFECYCLE_TONE: Record<string, string> = {
        Active: 'bg-success',
        'Phase in': 'bg-info',
        'Phase out': 'bg-warning',
        'End of life': 'bg-danger',
        Plan: 'bg-accent'
    };
</script>

<svelte:head><title>IT platform portfolio</title></svelte:head>

{#snippet bars(items: { label: string; count: number; url?: string | null }[], unit: string, tone = 'bg-accent')}
    {@const max = Math.max(1, ...items.map((i) => i.count))}
    <div class="flex flex-col gap-2">
        {#each items as item}
            <div class="flex items-center gap-3">
                {#if item.url}
                    <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-[12px] text-dim hover:text-accent w-44 shrink-0 truncate"
                        title="{item.label} — open in LeanIX"
                    >{item.label}</a>
                {:else}
                    <span class="text-[12px] text-dim w-44 shrink-0 truncate" title={item.label}>{item.label}</span>
                {/if}
                <div class="flex-1 h-2 rounded-full bg-well overflow-hidden">
                    <div class="h-full rounded-full {tone}" style="width: {(item.count / max) * 100}%"></div>
                </div>
                <span class="text-[12px] text-mute tabular-nums w-20 text-right shrink-0">
                    {item.count.toLocaleString()} {unit}
                </span>
            </div>
        {/each}
    </div>
{/snippet}

<div class="min-h-screen p-6 max-w-7xl mx-auto">
    <nav class="mb-5">
        <a href="/" class="btn btn-ghost btn-sm -ml-2.5">
            <ChevronLeft class="w-4 h-4" />
            Back to chat
        </a>
    </nav>

    <header class="mb-6 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
            <h1 class="page-title">IT platform portfolio</h1>
            <p class="page-subtitle mt-1 max-w-2xl">
                Applications and IT components tagged <span class="text-dim">SKODA Strategic IT Product: Enterprise</span>,
                synced read-only from LeanIX once a day.
            </p>
            <p class="text-xs text-faint mt-2 tabular-nums">
                {data.summary.total} factsheets · {data.summary.components} IT components ·
                {data.summary.applications} applications · synced {relativeTime(data.status.lastSyncAt)}
            </p>
        </div>

        <a href="/leanix/capabilities" class="btn btn-secondary btn-sm shrink-0">
            <Layers class="w-4 h-4" />
            Capability map
        </a>
    </header>

    {#if data.summary.total === 0}
        <div class="card p-10 text-center" in:fade>
            <p class="text-[13px] text-mute">
                No LeanIX factsheets have been synced yet.
            </p>
            <p class="text-xs text-faint mt-2">
                {#if data.status.configured}
                    The first sync runs shortly after startup, or an admin can trigger it from the dashboard.
                {:else}
                    Set <code>LEANIX_TOKEN_URL</code>, <code>LEANIX_TOKEN_CREDENTIALS</code> and
                    <code>LEANIX_API_URL</code> to enable the datasource.
                {/if}
            </p>
        </div>
    {:else}
        <!-- ── KPI row ────────────────────────────────────────────────────── -->
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6" in:fade>
            {#each [
                { label: 'Factsheets', value: data.summary.total, hint: `${data.summary.components} components · ${data.summary.applications} apps` },
                { label: 'Active', value: data.summary.active, hint: `${data.summary.phasing_out} phasing out` },
                { label: 'Tech capabilities', value: data.summary.distinct_capabilities, hint: 'distinct' },
                { label: 'Vendors', value: data.summary.distinct_vendors, hint: 'distinct' },
                { label: 'Avg completeness', value: `${Math.round(data.summary.avg_completion * 100)}%`, hint: 'LeanIX data quality' }
            ] as kpi}
                <div class="card p-4">
                    <p class="eyebrow">{kpi.label}</p>
                    <p class="text-2xl font-semibold text-strong tabular-nums mt-1">{kpi.value}</p>
                    <p class="text-[11px] text-faint mt-0.5">{kpi.hint}</p>
                </div>
            {/each}
        </div>

        <!-- ── Platform load ──────────────────────────────────────────────── -->
        {#if data.platformLoad.length > 0}
            <section class="card p-5 mb-4">
                <div class="flex items-center gap-2 mb-1">
                    <Layers class="w-4 h-4 text-faint" />
                    <h2 class="text-sm font-semibold text-strong">Platform load</h2>
                </div>
                <p class="text-xs text-faint mb-4">
                    Applications depending on each IT component — where an outage or a migration would be felt hardest.
                </p>
                {@render bars(
                    data.platformLoad.map((p) => ({ label: p.name, count: p.app_count, url: p.url })),
                    'apps'
                )}
            </section>
        {/if}

        <div class="grid lg:grid-cols-2 gap-4 mb-4">
            <!-- ── Vendors ────────────────────────────────────────────────── -->
            {#if data.vendors.length > 0}
                <section class="card p-5">
                    <div class="flex items-center gap-2 mb-1">
                        <Building2 class="w-4 h-4 text-faint" />
                        <h2 class="text-sm font-semibold text-strong">Vendor concentration</h2>
                    </div>
                    <p class="text-xs text-faint mb-4">IT components per supplier.</p>
                    {@render bars(
                        data.vendors.map((v) => ({ label: v.vendor, count: v.component_count })),
                        'components'
                    )}
                </section>
            {/if}

            <!-- ── Capabilities ───────────────────────────────────────────── -->
            {#if data.capabilities.length > 0}
                <section class="card p-5">
                    <h2 class="text-sm font-semibold text-strong mb-1">Technology capability coverage</h2>
                    <p class="text-xs text-faint mb-4">
                        How many components serve each capability — thin coverage and duplication both show here.
                    </p>
                    {@render bars(
                        data.capabilities.map((c) => ({ label: c.capability, count: c.component_count })),
                        'components'
                    )}
                </section>
            {/if}
        </div>

        <!-- ── Distributions ──────────────────────────────────────────────── -->
        <div class="grid md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
            {#each [
                { title: 'Lifecycle state', items: data.lifecycle, unit: '' },
                { title: 'Technical fit', items: data.technicalFit, unit: '' },
                { title: 'Component category', items: data.categories, unit: '' },
                { title: 'TIME classification', items: data.time, unit: '' }
            ] as panel}
                {#if panel.items.length > 0}
                    <section class="card p-5">
                        <h2 class="text-sm font-semibold text-strong mb-3">{panel.title}</h2>
                        <div class="flex flex-col gap-2">
                            {#each panel.items as item}
                                {@const max = Math.max(1, ...panel.items.map((i) => i.count))}
                                <div class="flex items-center gap-2">
                                    <span class="text-[12px] w-28 shrink-0 truncate {item.label === 'Not set' ? 'text-faint italic' : 'text-dim'}"
                                          title={item.label}>{item.label}</span>
                                    <div class="flex-1 h-2 rounded-full bg-well overflow-hidden">
                                        <div class="h-full rounded-full {LIFECYCLE_TONE[item.label] ?? (item.label === 'Not set' ? 'bg-muted' : 'bg-accent')}"
                                             style="width: {(item.count / max) * 100}%"></div>
                                    </div>
                                    <span class="text-[12px] text-mute tabular-nums w-8 text-right">{item.count}</span>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {/each}
        </div>

        <div class="grid lg:grid-cols-2 gap-4 mb-4">
            <!-- ── Roadmap ────────────────────────────────────────────────── -->
            <section class="card p-5">
                <div class="flex items-center gap-2 mb-1">
                    <CalendarClock class="w-4 h-4 text-faint" />
                    <h2 class="text-sm font-semibold text-strong">End-of-life runway</h2>
                </div>
                <p class="text-xs text-faint mb-4">Factsheets carrying a dated end-of-life phase, soonest first.</p>
                {#if data.roadmap.length === 0}
                    <p class="text-[13px] text-mute">No factsheet in the portfolio carries an end-of-life date.</p>
                {:else}
                    <div class="flex flex-col gap-1.5">
                        {#each data.roadmap as item}
                            <div class="flex items-center justify-between gap-3 py-1.5 border-b border-line-subtle last:border-0">
                                <div class="min-w-0">
                                    {#if item.url}
                                        <a
                                            href={item.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="text-[13px] text-body hover:text-accent truncate flex items-center gap-1"
                                        >
                                            {item.name}
                                            <ExternalLink class="w-3 h-3 text-faint shrink-0" />
                                        </a>
                                    {:else}
                                        <p class="text-[13px] text-body truncate">{item.name}</p>
                                    {/if}
                                    <p class="text-[11px] text-faint">{item.fs_type} · {item.lifecycle_label}</p>
                                </div>
                                <span class="badge badge-warning shrink-0 tabular-nums">{item.end_of_life_date}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            </section>

            <!-- ── Ownership ──────────────────────────────────────────────── -->
            <section class="card p-5">
                <h2 class="text-sm font-semibold text-strong mb-1">Ownership</h2>
                <p class="text-xs text-faint mb-4">Owning organisations, and which responsible roles are staffed.</p>
                <div class="grid sm:grid-cols-2 gap-4">
                    <div>
                        <p class="eyebrow mb-2">Organisation</p>
                        {#if data.ownership.orgs.length === 0}
                            <p class="text-[13px] text-mute">Not recorded.</p>
                        {:else}
                            <div class="flex flex-col gap-1">
                                {#each data.ownership.orgs as o}
                                    <div class="flex justify-between gap-2 text-[12px]">
                                        <span class="text-dim truncate" title={o.org}>{o.org}</span>
                                        <span class="text-mute tabular-nums">{o.factsheet_count}</span>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                    <div>
                        <p class="eyebrow mb-2">Responsible role</p>
                        {#if data.ownership.roles.length === 0}
                            <p class="text-[13px] text-mute">Not recorded.</p>
                        {:else}
                            <div class="flex flex-col gap-1">
                                {#each data.ownership.roles as r}
                                    <div class="flex justify-between gap-2 text-[12px]">
                                        <span class="text-dim truncate" title={r.role}>{r.role}</span>
                                        <span class="text-mute tabular-nums">{r.factsheet_count}</span>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                </div>
            </section>
        </div>

        <!-- ── Criticality × data class ───────────────────────────────────── -->
        {#if data.criticality.rows.length > 0}
            <section class="card p-5 mb-4">
                <h2 class="text-sm font-semibold text-strong mb-1">Business criticality against data classification</h2>
                <p class="text-xs text-faint mb-4">Applications only — where the portfolio's exposure concentrates.</p>
                <div class="overflow-x-auto">
                    <table class="w-full text-[12px]">
                        <thead>
                            <tr class="text-left">
                                <th class="eyebrow pb-2 pr-4">Criticality</th>
                                {#each data.criticality.columns as col}
                                    <th class="eyebrow pb-2 px-3 text-center">{col}</th>
                                {/each}
                            </tr>
                        </thead>
                        <tbody>
                            {#each data.criticality.rows as row}
                                <tr class="border-t border-line-subtle">
                                    <td class="py-2 pr-4 text-dim">{row.label}</td>
                                    {#each row.cells as cell}
                                        <td class="py-2 px-3 text-center tabular-nums {cell.count > 0 ? 'text-strong' : 'text-ghost'}">
                                            {cell.count || '–'}
                                        </td>
                                    {/each}
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </section>
        {/if}

        <!-- ── Data quality ───────────────────────────────────────────────── -->
        <section class="well p-5 mb-6">
            <div class="flex items-center gap-2 mb-1">
                <TriangleAlert class="w-4 h-4 text-warning" />
                <h2 class="text-sm font-semibold text-strong">Record gaps</h2>
            </div>
            <p class="text-xs text-faint mb-4">
                What the portfolio record cannot currently answer, out of {data.dataQuality.total} factsheets.
            </p>
            <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                {#each [
                    { label: 'No technical fit', value: data.dataQuality.no_technical_fit },
                    { label: 'No description', value: data.dataQuality.no_description },
                    { label: 'No responsible owner', value: data.dataQuality.no_responsible_owner },
                    { label: 'No tech capability', value: data.dataQuality.no_tech_capability },
                    { label: 'No lifecycle state', value: data.dataQuality.no_lifecycle }
                ] as gap}
                    <div>
                        <p class="text-xl font-semibold tabular-nums {gap.value > 0 ? 'text-warning' : 'text-mute'}">
                            {gap.value}
                        </p>
                        <p class="text-[11px] text-faint">{gap.label}</p>
                    </div>
                {/each}
            </div>
        </section>

        <!-- ── Table ──────────────────────────────────────────────────────── -->
        <section class="card p-5">
            <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
                <h2 class="text-sm font-semibold text-strong">All factsheets</h2>
                <div class="flex gap-2 items-center">
                    <div class="relative">
                        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
                        <input
                            type="text"
                            bind:value={query}
                            placeholder="Search name, capability, vendor…"
                            class="field pl-9 py-2 text-xs w-64"
                        />
                    </div>
                    <div class="flex gap-1">
                        {#each ['All', 'ITComponent', 'Application'] as t}
                            <button
                                onclick={() => (typeFilter = t as typeof typeFilter)}
                                class="btn btn-sm {typeFilter === t ? 'btn-secondary' : 'btn-ghost'}"
                                aria-pressed={typeFilter === t}
                            >
                                {t === 'ITComponent' ? 'Components' : t === 'Application' ? 'Applications' : 'All'}
                            </button>
                        {/each}
                    </div>
                </div>
            </div>

            <div class="overflow-x-auto">
                <table class="w-full text-[12px]">
                    <thead>
                        <tr class="text-left">
                            {#each [
                                { key: 'name', label: 'Name' },
                                { key: null, label: 'Type' },
                                { key: null, label: 'Lifecycle' },
                                { key: null, label: 'Technical fit' },
                                { key: 'app_count', label: 'Apps' },
                                { key: null, label: 'Capabilities' },
                                { key: null, label: 'Vendor' },
                                { key: 'end_of_life_date', label: 'EOL' },
                                { key: 'completion', label: 'Complete' }
                            ] as col}
                                <th class="eyebrow pb-2 pr-3 whitespace-nowrap">
                                    {#if col.key}
                                        <button class="hover:text-body" onclick={() => toggleSort(col.key as typeof sortKey)}>
                                            {col.label}{sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                                        </button>
                                    {:else}
                                        {col.label}
                                    {/if}
                                </th>
                            {/each}
                        </tr>
                    </thead>
                    <tbody>
                        {#each filtered as row (row.id)}
                            <tr class="border-t border-line-subtle align-top">
                                <td class="py-2 pr-3 max-w-[16rem]">
                                    <div class="flex items-start gap-1.5">
                                        <span class="text-body">{row.name}</span>
                                        {#if row.url}
                                            <a href={row.url} target="_blank" rel="noopener noreferrer"
                                               class="text-faint hover:text-accent shrink-0 mt-0.5"
                                               title="Open in LeanIX">
                                                <ExternalLink class="w-3 h-3" />
                                            </a>
                                        {/if}
                                    </div>
                                    {#if row.description}
                                        <p class="text-[11px] text-faint line-clamp-2 mt-0.5">{row.description}</p>
                                    {/if}
                                </td>
                                <td class="py-2 pr-3 text-mute whitespace-nowrap">
                                    {row.fs_type === 'ITComponent' ? row.category_label : 'Application'}
                                </td>
                                <td class="py-2 pr-3 whitespace-nowrap {row.lifecycle_label === 'Not set' ? 'text-faint italic' : 'text-dim'}">
                                    {row.lifecycle_label}
                                </td>
                                <td class="py-2 pr-3 whitespace-nowrap {row.technical_fit_label === 'Not set' ? 'text-faint italic' : 'text-dim'}">
                                    {row.technical_fit_label}
                                </td>
                                <td class="py-2 pr-3 text-mute tabular-nums">{row.app_count || '–'}</td>
                                <td class="py-2 pr-3 text-mute max-w-[14rem]">
                                    <span class="line-clamp-2">{row.capabilities ?? '–'}</span>
                                </td>
                                <td class="py-2 pr-3 text-mute max-w-[10rem] truncate">{row.vendor ?? '–'}</td>
                                <td class="py-2 pr-3 tabular-nums {row.end_of_life_date ? 'text-warning' : 'text-ghost'}">
                                    {row.end_of_life_date ?? '–'}
                                </td>
                                <td class="py-2 pr-3 text-mute tabular-nums">
                                    {row.completion != null ? `${Math.round(row.completion * 100)}%` : '–'}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
                {#if filtered.length === 0}
                    <p class="text-[13px] text-mute text-center py-10">
                        No factsheet matches {query ? `“${query}”` : 'this filter'}.
                    </p>
                {/if}
            </div>
        </section>
    {/if}
</div>
