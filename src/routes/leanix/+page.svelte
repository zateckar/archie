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
    import Globe from '@lucide/svelte/icons/globe';
    import ShieldAlert from '@lucide/svelte/icons/shield-alert';
    import Scale from '@lucide/svelte/icons/scale';
    import Target from '@lucide/svelte/icons/target';
    import X from '@lucide/svelte/icons/x';
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

    // ── Market research ──────────────────────────────────────────────────────
    // Assessments and alerts arrive with the page (see +page.server.ts), so
    // opening one costs nothing — no fetch, no spinner, no second round trip.

    /** Factsheet id whose assessment drawer is open. */
    let openAssessment = $state<string | null>(null);

    const assessment = $derived(openAssessment ? data.market.assessments[openAssessment] : null);
    const assessmentFactsheet = $derived(
        openAssessment ? data.factsheets.find((f) => f.id === openAssessment) ?? null : null
    );
    const assessmentAlerts = $derived(
        openAssessment ? data.market.alerts.filter((a) => a.factsheetId === openAssessment) : []
    );

    function toggleAssessment(id: string) {
        openAssessment = openAssessment === id ? null : id;
        // The two panels occupy the same corner; the newer question wins.
        if (openAssessment) closeDrill();
    }

    const SEVERITY_BADGE: Record<string, string> = {
        critical: 'badge-danger',
        high: 'badge-warning',
        medium: 'badge-info',
        low: 'badge-neutral'
    };

    const SEVERITY_BAR: Record<string, string> = {
        critical: 'bg-danger',
        high: 'bg-warning',
        medium: 'bg-info',
        low: 'bg-muted'
    };

    // Verdicts run good → bad, and the colour follows the meaning rather than
    // the count: "consider replacing" is red whether it applies to one factsheet
    // or forty.
    const VERDICT_TONE: Record<string, string> = {
        best_in_class: 'bg-success',
        solid: 'bg-success',
        adequate: 'bg-info',
        questionable: 'bg-warning',
        replace: 'bg-danger',
        unknown: 'bg-muted'
    };

    const VERDICT_TEXT: Record<string, string> = {
        best_in_class: 'text-success',
        solid: 'text-success',
        adequate: 'text-info',
        questionable: 'text-warning',
        replace: 'text-danger',
        unknown: 'text-faint'
    };

    /** Alerts shown before the feed collapses behind "show all". */
    const ALERT_PREVIEW = 6;
    let showAllAlerts = $state(false);
    const visibleAlerts = $derived(
        showAllAlerts ? data.market.alerts : data.market.alerts.slice(0, ALERT_PREVIEW)
    );

    // ── Drill-down ───────────────────────────────────────────────────────────
    // Every count on this page answers "how many"; clicking it asks "which ones".
    // Fetched on demand rather than shipped with the page: the relation table
    // holds ~5200 edges, and one platform alone carries 974 applications.

    interface DrillItem {
        id: string | null;
        name: string;
        type: string | null;
        lifecycle: string | null;
        url: string | null;
        note: string | null;
    }
    interface DrillResult {
        title: string;
        subtitle: string;
        total: number;
        items: DrillItem[];
        truncated: boolean;
    }

    let drill = $state<DrillResult | null>(null);
    let drillLoading = $state(false);
    let drillError = $state('');
    let drillFilter = $state('');
    /** Identifies the open drill, so clicking the same number again closes it. */
    let drillKey = $state('');

    async function openDrill(dim: string, key = '', key2 = '') {
        const identity = `${dim}|${key}|${key2}`;
        if (drillKey === identity) {
            closeDrill();
            return;
        }

        drillKey = identity;
        drillFilter = '';
        drillError = '';
        drillLoading = true;
        openAssessment = null; // see toggleAssessment — one panel, one corner
        // The previous result is cleared so a slow fetch cannot leave the panel
        // showing one question's title above another question's rows.
        drill = null;

        try {
            const params = new URLSearchParams({ dim, key, key2 });
            const res = await fetch(`/api/portfolio/drill?${params}`);
            const body = await res.json();
            // A second click while this one was in flight owns the panel now.
            if (drillKey !== identity) return;
            if (!res.ok) {
                drillError = body?.error ?? 'Could not load the details.';
            } else {
                drill = body;
            }
        } catch (e) {
            if (drillKey === identity) drillError = (e as Error).message;
        } finally {
            if (drillKey === identity) drillLoading = false;
        }
    }

    function closeDrill() {
        drillKey = '';
        drill = null;
        drillError = '';
        drillLoading = false;
        drillFilter = '';
    }

    const drillItems = $derived.by(() => {
        if (!drill) return [];
        const q = drillFilter.trim().toLowerCase();
        if (!q) return drill.items;
        return drill.items.filter(
            (i) => i.name.toLowerCase().includes(q) || (i.note ?? '').toLowerCase().includes(q)
        );
    });
</script>

<svelte:head><title>IT platform portfolio</title></svelte:head>

<!--
    A number that answers "which ones". Rendered as a button rather than a link
    because the answer arrives in a panel beside the chart — navigating away
    would lose the chart that prompted the question.
-->
{#snippet drillCount(value: string | number, dim: string, key = '', key2 = '', extra = '')}
    <button
        class="drillable {extra}"
        class:drill-open={drillKey === `${dim}|${key}|${key2}`}
        onclick={() => openDrill(dim, key, key2)}
        title="Show which factsheets make up this number"
    >{value}</button>
{/snippet}

{#snippet bars(
    items: { label: string; count: number; url?: string | null; dim?: string; key?: string }[],
    unit: string,
    tone = 'bg-accent'
)}
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
                    {#if item.dim}
                        {@render drillCount(item.count.toLocaleString(), item.dim, item.key ?? '')}
                    {:else}
                        {item.count.toLocaleString()}
                    {/if}
                    {unit}
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
                { label: 'Factsheets', value: data.summary.total, hint: `${data.summary.components} components · ${data.summary.applications} apps`, dim: 'all', key: '' },
                { label: 'Active', value: data.summary.active, hint: `${data.summary.phasing_out} phasing out`, dim: 'lifecycle', key: 'active' },
                { label: 'Tech capabilities', value: data.summary.distinct_capabilities, hint: 'distinct', dim: 'capabilities', key: '' },
                { label: 'Vendors', value: data.summary.distinct_vendors, hint: 'distinct', dim: 'vendors', key: '' },
                // Completeness is an average, not a set — there is nothing to list
                // behind it, so it is deliberately the one KPI that does not drill.
                { label: 'Avg completeness', value: `${Math.round(data.summary.avg_completion * 100)}%`, hint: 'LeanIX data quality', dim: null, key: '' }
            ] as kpi}
                <div class="card p-4">
                    <p class="eyebrow">{kpi.label}</p>
                    <p class="text-2xl font-semibold text-strong tabular-nums mt-1">
                        {#if kpi.dim}
                            {@render drillCount(kpi.value, kpi.dim, kpi.key)}
                        {:else}
                            {kpi.value}
                        {/if}
                    </p>
                    <p class="text-[11px] text-faint mt-0.5">{kpi.hint}</p>
                </div>
            {/each}
        </div>

        <!-- ── Market alerts ──────────────────────────────────────────────── -->
        <!-- Above everything else on purpose: an actively exploited vulnerability
             in a platform carrying 900 applications outranks any distribution
             chart on the page. -->
        {#if data.market.alerts.length > 0}
            <section class="card p-5 mb-4" in:fade>
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-1">
                    <div class="flex items-center gap-2">
                        <ShieldAlert class="w-4 h-4 text-danger" />
                        <h2 class="text-sm font-semibold text-strong">Market alerts</h2>
                        <span class="badge badge-neutral tabular-nums">{data.market.alerts.length}</span>
                    </div>
                    <p class="text-[11px] text-faint">
                        Found on the open web · researched {relativeTime(data.market.status.lastRunAt)}
                    </p>
                </div>
                <p class="text-xs text-faint mb-4">
                    Events reported about products in this portfolio — incidents, breaches, ownership changes,
                    strategy shifts and end-of-life announcements. Each links to the source it came from.
                </p>

                <div class="flex flex-col">
                    {#each visibleAlerts as alert (alert.id)}
                        <div class="flex items-start gap-3 py-2.5 border-b border-line-subtle last:border-0">
                            <span class="w-1 self-stretch rounded-full shrink-0 {SEVERITY_BAR[alert.severity] ?? 'bg-muted'}"
                                  aria-hidden="true"></span>
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="badge {SEVERITY_BADGE[alert.severity] ?? 'badge-neutral'} capitalize">
                                        {alert.severity}
                                    </span>
                                    <span class="text-[11px] text-mute">{alert.categoryLabel}</span>
                                    {#if alert.isNew}
                                        <span class="badge badge-info">New</span>
                                    {/if}
                                </div>
                                <p class="text-[13px] text-body mt-1">{alert.title}</p>
                                {#if alert.detail}
                                    <p class="text-[12px] text-mute mt-0.5 leading-relaxed">{alert.detail}</p>
                                {/if}
                                <div class="flex items-center gap-2 flex-wrap mt-1">
                                    <button
                                        class="text-[11px] text-dim hover:text-accent underline underline-offset-2"
                                        onclick={() => toggleAssessment(alert.factsheetId)}
                                    >{alert.factsheetName}</button>
                                    {#if alert.eventDate}
                                        <span class="text-[11px] text-faint tabular-nums">· {alert.eventDate}</span>
                                    {/if}
                                    {#if alert.sourceUrl}
                                        <a
                                            href={alert.sourceUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="text-[11px] text-faint hover:text-accent inline-flex items-center gap-1"
                                        >
                                            · {alert.sourceTitle ?? 'Source'}
                                            <ExternalLink class="w-3 h-3" />
                                        </a>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>

                {#if data.market.alerts.length > ALERT_PREVIEW}
                    <button class="btn btn-ghost btn-sm mt-3" onclick={() => (showAllAlerts = !showAllAlerts)}>
                        {showAllAlerts
                            ? 'Show fewer'
                            : `Show all ${data.market.alerts.length} alerts`}
                    </button>
                {/if}
            </section>
        {/if}

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
                    data.platformLoad.map((p) => ({
                        label: p.name, count: p.app_count, url: p.url, dim: 'platform', key: p.id
                    })),
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
                        data.vendors.map((v) => ({
                            label: v.vendor, count: v.component_count, dim: 'vendor', key: v.vendor
                        })),
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
                        data.capabilities.map((c) => ({
                            label: c.capability, count: c.component_count, dim: 'capability', key: c.capability
                        })),
                        'components'
                    )}
                </section>
            {/if}
        </div>

        <!-- ── Business capability coverage ───────────────────────────────── -->
        <!-- The sibling of the technology view above: that one is what the estate
             is built FROM, this is what it is FOR. Applications only — business
             capabilities are not a property IT components carry. -->
        {#if data.businessCapabilities.length > 0}
            <section class="card p-5 mb-4">
                <div class="flex items-center gap-2 mb-1">
                    <Target class="w-4 h-4 text-faint" />
                    <h2 class="text-sm font-semibold text-strong">Business capability coverage</h2>
                </div>
                <p class="text-xs text-faint mb-4">
                    What the tagged applications are there to do.
                    {@render drillCount(data.summary.distinct_business_capabilities, 'businessCapabilities')} capabilities
                    are supported by {data.summary.applications_with_business_capability} of
                    {data.summary.applications} applications.
                </p>

                {@render bars(
                    data.businessCapabilities.map((c) => ({
                        label: c.capability,
                        count: c.application_count,
                        dim: 'businessCapability',
                        key: c.capability
                    })),
                    'apps'
                )}

                {#if data.summary.distinct_business_capabilities > data.businessCapabilities.length}
                    <!-- The tail matters here more than usual: the distribution is
                         near-flat, so the bars below the top few are all the same
                         length and the ranking stops meaning anything. Saying how
                         many are hidden keeps the chart from reading as the whole
                         picture. -->
                    <p class="text-[11px] text-faint mt-4">
                        Showing the {data.businessCapabilities.length} most-supported. Most capabilities here are
                        served by a single application, so the ranking below the top few is nominal —
                        {@render drillCount('open the full list', 'businessCapabilities')} to see all
                        {data.summary.distinct_business_capabilities}.
                    </p>
                {/if}
            </section>
        {/if}

        <!-- ── Distributions ──────────────────────────────────────────────── -->
        <div class="grid md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
            {#each [
                { title: 'Lifecycle state', items: data.lifecycle, dim: 'lifecycle' },
                { title: 'Technical fit', items: data.technicalFit, dim: 'technicalFit' },
                { title: 'Component category', items: data.categories, dim: 'category' },
                { title: 'TIME classification', items: data.time, dim: 'time' }
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
                                    <span class="text-[12px] text-mute tabular-nums w-8 text-right">
                                        {@render drillCount(item.count, panel.dim, item.key)}
                                    </span>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {/each}
        </div>

        <!-- ── Market assessment ──────────────────────────────────────────── -->
        {#if data.market.status.configured}
            <div class="grid lg:grid-cols-2 gap-4 mb-4">
                <section class="card p-5">
                    <div class="flex items-center gap-2 mb-1">
                        <Globe class="w-4 h-4 text-faint" />
                        <h2 class="text-sm font-semibold text-strong">Market verdict</h2>
                    </div>
                    <p class="text-xs text-faint mb-4">
                        How each product stands in its own market, from public sources — not from our own
                        ratings. {data.market.status.identified} of {data.market.status.total} researched
                        successfully.
                    </p>

                    {#if data.market.verdicts.length === 0}
                        <p class="text-[13px] text-mute">
                            {#if data.market.status.researched === 0}
                                No factsheet has been researched yet. The first run happens automatically, or an
                                admin can start one from the dashboard.
                            {:else}
                                Nothing in the portfolio could be identified on the open web — expected where
                                the factsheets are in-house systems.
                            {/if}
                        </p>
                    {:else}
                        {@const max = Math.max(1, ...data.market.verdicts.map((v) => v.count))}
                        <div class="flex flex-col gap-2">
                            {#each data.market.verdicts as bucket}
                                <div class="flex items-center gap-2">
                                    <span class="text-[12px] text-dim w-32 shrink-0 truncate">{bucket.label}</span>
                                    <div class="flex-1 h-2 rounded-full bg-well overflow-hidden">
                                        <div class="h-full rounded-full {VERDICT_TONE[bucket.key] ?? 'bg-accent'}"
                                             style="width: {(bucket.count / max) * 100}%"></div>
                                    </div>
                                    <span class="text-[12px] text-mute tabular-nums w-8 text-right">
                                        {@render drillCount(bucket.count, 'verdict', bucket.key)}
                                    </span>
                                </div>
                            {/each}
                        </div>
                    {/if}

                    {#if data.market.status.researched < data.market.status.total}
                        <p class="text-[11px] text-faint mt-4">
                            {data.market.status.total - data.market.status.researched} factsheet(s) not yet
                            researched — runs spread over several days to keep the cost predictable.
                        </p>
                    {/if}
                </section>

                <!-- Where our own rating and the market disagree. The most
                     actionable cut on the page: each row is either a re-rating
                     nobody has done or a risk nobody has written down. -->
                <section class="card p-5">
                    <div class="flex items-center gap-2 mb-1">
                        <Scale class="w-4 h-4 text-faint" />
                        <h2 class="text-sm font-semibold text-strong">Where we disagree with the market</h2>
                    </div>
                    <p class="text-xs text-faint mb-4">
                        Factsheets whose recorded technical fit points the other way from the market verdict.
                    </p>

                    {#if data.market.disagreements.length === 0}
                        <p class="text-[13px] text-mute">
                            No contradictions between our technical-fit ratings and the market verdicts.
                        </p>
                    {:else}
                        <div class="flex flex-col gap-1.5">
                            {#each data.market.disagreements as row}
                                <button
                                    class="text-left py-1.5 border-b border-line-subtle last:border-0 hover:bg-well rounded px-1 -mx-1"
                                    onclick={() => toggleAssessment(row.id)}
                                >
                                    <div class="flex items-center justify-between gap-2">
                                        <span class="text-[13px] text-body truncate">{row.name}</span>
                                        <span class="text-[11px] shrink-0 {VERDICT_TEXT[row.verdict] ?? 'text-mute'}">
                                            {row.verdictLabel}
                                        </span>
                                    </div>
                                    <p class="text-[11px] text-faint">
                                        {#if row.direction === 'we_rate_higher'}
                                            We rate it {row.technicalFit}; the market is less convinced.
                                        {:else}
                                            We rate it {row.technicalFit}; the market rates it well.
                                        {/if}
                                    </p>
                                </button>
                            {/each}
                        </div>
                    {/if}
                </section>
            </div>
        {/if}

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
                                        <span class="text-mute tabular-nums">
                                            {@render drillCount(o.factsheet_count, 'org', o.org)}
                                        </span>
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
                                        <span class="text-mute tabular-nums">
                                            {@render drillCount(r.factsheet_count, 'role', r.role)}
                                        </span>
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
                                            {#if cell.count > 0}
                                                {@render drillCount(cell.count, 'criticality', cell.criticalityKey, cell.key)}
                                            {:else}
                                                –
                                            {/if}
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
                    { label: 'No technical fit', value: data.dataQuality.no_technical_fit, key: 'no_technical_fit' },
                    { label: 'No description', value: data.dataQuality.no_description, key: 'no_description' },
                    { label: 'No responsible owner', value: data.dataQuality.no_responsible_owner, key: 'no_responsible_owner' },
                    { label: 'No tech capability', value: data.dataQuality.no_tech_capability, key: 'no_tech_capability' },
                    { label: 'No lifecycle state', value: data.dataQuality.no_lifecycle, key: 'no_lifecycle' }
                ] as gap}
                    <div>
                        <p class="text-xl font-semibold tabular-nums {gap.value > 0 ? 'text-warning' : 'text-mute'}">
                            {#if gap.value > 0}
                                {@render drillCount(gap.value, 'gap', gap.key)}
                            {:else}
                                {gap.value}
                            {/if}
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
                                { key: null, label: 'Market' },
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
                            {@const market = data.market.assessments[row.id]}
                            {@const alertCounts = data.market.alertCounts[row.id]}
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
                                <td class="py-2 pr-3 whitespace-nowrap">
                                    {#if !market}
                                        <span class="text-ghost" title="Not researched yet">–</span>
                                    {:else if !market.identified}
                                        <button
                                            class="text-faint italic hover:text-accent"
                                            onclick={() => toggleAssessment(row.id)}
                                            title="No public information found for this product"
                                        >Not found</button>
                                    {:else}
                                        <button
                                            class="inline-flex items-center gap-1.5 hover:underline underline-offset-2 {VERDICT_TEXT[market.verdict] ?? 'text-dim'}"
                                            onclick={() => toggleAssessment(row.id)}
                                            title={market.headline ?? 'Open the market assessment'}
                                        >
                                            {market.verdictLabel}
                                            {#if alertCounts}
                                                <span class="badge {SEVERITY_BADGE[alertCounts.worst] ?? 'badge-neutral'} tabular-nums">
                                                    {alertCounts.total}
                                                </span>
                                            {/if}
                                        </button>
                                    {/if}
                                </td>
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

<!-- ── Drill-down panel ───────────────────────────────────────────────────── -->
{#if drillKey}
    <aside
        class="fixed right-4 bottom-4 w-[26rem] max-w-[calc(100vw-2rem)] max-h-[80vh] flex flex-col bg-raised border border-line rounded-2xl shadow-xl z-40"
        transition:fade={{ duration: 120 }}
    >
        <div class="flex items-start justify-between gap-2 p-4 pb-2">
            <div class="min-w-0">
                <p class="text-sm font-semibold text-strong truncate" title={drill?.title}>
                    {drill?.title ?? 'Loading…'}
                </p>
                <p class="text-[11px] text-faint">
                    {#if drill}
                        {drill.total.toLocaleString()} · {drill.subtitle}
                    {:else if drillError}
                        Could not load
                    {:else}
                        Fetching the detail behind this number
                    {/if}
                </p>
            </div>
            <button class="btn btn-ghost btn-icon shrink-0" onclick={closeDrill} aria-label="Close">
                <X class="w-4 h-4" />
            </button>
        </div>

        {#if drillLoading}
            <p class="text-[13px] text-mute px-4 pb-4">Loading…</p>
        {:else if drillError}
            <p class="text-[13px] text-danger px-4 pb-4">{drillError}</p>
        {:else if drill}
            {#if drill.items.length > 12}
                <div class="px-4 pb-2">
                    <input
                        type="text"
                        bind:value={drillFilter}
                        placeholder="Filter these {drill.total.toLocaleString()}…"
                        class="field py-1.5 text-xs w-full"
                    />
                </div>
            {/if}

            <div class="overflow-y-auto px-4 pb-2 flex-1">
                {#if drillItems.length === 0}
                    <p class="text-[13px] text-mute py-4">
                        {drill.items.length === 0
                            ? 'Nothing matches — the number and this list disagree, which is worth reporting.'
                            : `No match for “${drillFilter}”.`}
                    </p>
                {:else}
                    <div class="flex flex-col">
                        {#each drillItems as item (item.id ?? item.name)}
                            <div class="flex items-start justify-between gap-2 py-1.5 border-b border-line-subtle last:border-0">
                                <div class="min-w-0">
                                    {#if item.url}
                                        <a
                                            href={item.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="text-[12px] text-body hover:text-accent inline-flex items-center gap-1"
                                        >
                                            <span class="truncate">{item.name}</span>
                                            <ExternalLink class="w-3 h-3 text-faint shrink-0" />
                                        </a>
                                    {:else}
                                        <p class="text-[12px] text-body truncate">{item.name}</p>
                                    {/if}
                                    {#if item.type || item.note}
                                        <p class="text-[11px] text-faint">
                                            {[item.type, item.note].filter(Boolean).join(' · ')}
                                        </p>
                                    {/if}
                                </div>
                                {#if item.lifecycle}
                                    <span class="text-[11px] shrink-0 {item.lifecycle === 'Not set' ? 'text-ghost italic' : 'text-mute'}">
                                        {item.lifecycle}
                                    </span>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>

            {#if drill.truncated}
                <!-- Said out loud: a list silently cut at 500 would read as the
                     whole answer, and the number above it says otherwise. -->
                <p class="text-[11px] text-faint px-4 pb-3 pt-1 border-t border-line-subtle">
                    Showing the first {drill.items.length.toLocaleString()} of {drill.total.toLocaleString()}.
                </p>
            {/if}
        {/if}
    </aside>
{/if}

<!-- ── Market assessment drawer ───────────────────────────────────────────── -->
<!-- Every assessment already came down with the page, so opening one is local
     state — no fetch, no loading state, and it works with the tab closed. -->
{#if assessment}
    <aside
        class="fixed right-4 bottom-4 w-[28rem] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto bg-raised border border-line rounded-2xl shadow-xl p-4 z-40"
        transition:fade={{ duration: 120 }}
    >
        <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
                <p class="text-sm font-semibold text-strong">{assessmentFactsheet?.name ?? assessment.subject}</p>
                <p class="text-[11px] text-faint">
                    Researched as “{assessment.subject}”{assessment.researchedAt ? ` · ${assessment.researchedAt}` : ''}
                </p>
            </div>
            <button class="btn btn-ghost btn-icon shrink-0" onclick={() => (openAssessment = null)} aria-label="Close">
                <X class="w-4 h-4" />
            </button>
        </div>

        {#if assessment.error}
            <div class="well p-3 mt-3">
                <p class="text-[12px] text-danger">Research failed</p>
                <p class="text-[11px] text-mute mt-1 leading-relaxed">{assessment.error}</p>
                <p class="text-[11px] text-faint mt-1">It will be retried automatically.</p>
            </div>
        {:else if !assessment.identified}
            <p class="text-[12px] text-mute mt-3 leading-relaxed">
                No credible public information was found for this product. That is the expected answer for an
                in-house system or an internal name — it is not a finding about the product itself, and no
                verdict or alert has been recorded.
            </p>
        {:else}
            <div class="flex items-center gap-2 mt-3 flex-wrap">
                <span class="badge {assessment.verdict === 'replace' ? 'badge-danger' : assessment.verdict === 'questionable' ? 'badge-warning' : 'badge-success'}">
                    {assessment.verdictLabel}
                </span>
                {#if assessment.confidence != null}
                    <span class="text-[11px] text-faint tabular-nums">
                        {Math.round(assessment.confidence * 100)}% confidence
                    </span>
                {/if}
            </div>

            {#if assessment.headline}
                <p class="text-[13px] text-body mt-3 leading-relaxed">{assessment.headline}</p>
            {/if}
            {#if assessment.rationale}
                <p class="text-[12px] text-dim mt-2 leading-relaxed">{assessment.rationale}</p>
            {/if}
            {#if assessment.marketPosition}
                <p class="text-[11px] text-mute mt-2"><span class="eyebrow">Position</span> · {assessment.marketPosition}</p>
            {/if}

            {#if assessmentAlerts.length > 0}
                <div class="mt-4">
                    <p class="eyebrow mb-2">Alerts</p>
                    <div class="flex flex-col gap-2">
                        {#each assessmentAlerts as alert (alert.id)}
                            <div class="well p-2.5">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="badge {SEVERITY_BADGE[alert.severity] ?? 'badge-neutral'} capitalize">
                                        {alert.severity}
                                    </span>
                                    <span class="text-[11px] text-mute">{alert.categoryLabel}</span>
                                    {#if alert.eventDate}
                                        <span class="text-[11px] text-faint tabular-nums">{alert.eventDate}</span>
                                    {/if}
                                </div>
                                <p class="text-[12px] text-body mt-1">{alert.title}</p>
                                {#if alert.detail}
                                    <p class="text-[11px] text-mute mt-0.5 leading-relaxed">{alert.detail}</p>
                                {/if}
                                {#if alert.sourceUrl}
                                    <a href={alert.sourceUrl} target="_blank" rel="noopener noreferrer"
                                       class="text-[11px] text-dim hover:text-accent inline-flex items-center gap-1 mt-1">
                                        {alert.sourceTitle ?? 'Source'}
                                        <ExternalLink class="w-3 h-3" />
                                    </a>
                                {/if}
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

            {#if assessment.strengths.length > 0 || assessment.concerns.length > 0}
                <div class="grid grid-cols-2 gap-3 mt-4">
                    <div>
                        <p class="eyebrow mb-1.5">Strengths</p>
                        {#if assessment.strengths.length === 0}
                            <p class="text-[11px] text-faint">–</p>
                        {:else}
                            <ul class="flex flex-col gap-1">
                                {#each assessment.strengths as item}
                                    <li class="text-[11px] text-dim leading-snug">{item}</li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                    <div>
                        <p class="eyebrow mb-1.5">Concerns</p>
                        {#if assessment.concerns.length === 0}
                            <p class="text-[11px] text-faint">–</p>
                        {:else}
                            <ul class="flex flex-col gap-1">
                                {#each assessment.concerns as item}
                                    <li class="text-[11px] text-dim leading-snug">{item}</li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if assessment.alternatives.length > 0}
                <div class="mt-4">
                    <p class="eyebrow mb-2">Alternatives worth knowing about</p>
                    <div class="flex flex-col gap-2">
                        {#each assessment.alternatives as alt}
                            <div class="border-b border-line-subtle last:border-0 pb-2 last:pb-0">
                                <div class="flex items-center gap-2">
                                    <span class="text-[12px] text-body">{alt.name}</span>
                                    {#if alt.vendor}
                                        <span class="text-[11px] text-faint">{alt.vendor}</span>
                                    {/if}
                                    <span class="badge badge-neutral capitalize">{alt.fit}</span>
                                </div>
                                {#if alt.why}
                                    <p class="text-[11px] text-mute mt-0.5 leading-relaxed">{alt.why}</p>
                                {/if}
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

            {#if assessment.sources.length > 0}
                <div class="mt-4">
                    <p class="eyebrow mb-1.5">Sources consulted</p>
                    <div class="flex flex-col gap-1">
                        {#each assessment.sources as source}
                            <a href={source.url} target="_blank" rel="noopener noreferrer"
                               class="text-[11px] text-dim hover:text-accent truncate inline-flex items-center gap-1">
                                <ExternalLink class="w-3 h-3 shrink-0" />
                                <span class="truncate">{source.title}</span>
                            </a>
                        {/each}
                    </div>
                </div>
            {/if}

            <p class="text-[10px] text-faint mt-4 leading-relaxed">
                Written by a model from the sources above. Treat it as a lead to verify, not as a decision.
            </p>
        {/if}

        {#if assessmentFactsheet?.url}
            <a href={assessmentFactsheet.url} target="_blank" rel="noopener noreferrer"
               class="btn btn-secondary btn-sm mt-4 w-full justify-center">
                <ExternalLink class="w-3.5 h-3.5" />
                Open in LeanIX
            </a>
        {/if}
    </aside>
{/if}

<style>
    /*
       A number that can be drilled into. Deliberately understated: these appear
       on nearly every figure on the page, so a button-like treatment on each
       would turn a dense analytics page into a wall of controls. The affordance
       is a dotted underline that solidifies on hover — enough to read as
       interactive once, and quiet enough to ignore afterwards.

       Inherits colour and font from whatever it sits inside, so the same snippet
       works in a 2xl KPI figure, a 12px bar label and a table cell without
       needing a variant for each.
    */
    .drillable {
        font: inherit;
        color: inherit;
        background: none;
        border: 0;
        padding: 0;
        cursor: pointer;
        /* 75%, not less. Composited against the card background (#222a28), a 45%
           mix of the muted text colour lands at ~2.5:1 — under the 3:1 WCAG
           threshold for a non-text indicator, which left a hundred interactive
           numbers reading as plain text. 75% lands at ~4.2:1. */
        border-bottom: 1px dotted color-mix(in oklab, currentColor 75%, transparent);
        transition: color 0.12s ease, border-color 0.12s ease;
    }

    .drillable:hover,
    .drillable:focus-visible {
        color: var(--accent);
        border-bottom-color: var(--accent);
    }

    /* The number whose panel is currently open, so the page says which question
       the panel in the corner is answering. */
    .drillable.drill-open {
        color: var(--accent);
        border-bottom-style: solid;
        border-bottom-color: var(--accent);
    }
</style>
