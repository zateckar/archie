<script lang="ts">
    import { onMount } from 'svelte';
    import Coins from '@lucide/svelte/icons/coins';
    import MessageSquare from '@lucide/svelte/icons/message-square';
    import FileText from '@lucide/svelte/icons/file-text';
    import Network from '@lucide/svelte/icons/network';
    import Globe from '@lucide/svelte/icons/globe';
    import CircleDashed from '@lucide/svelte/icons/circle-dashed';
    import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
    import Table from '@lucide/svelte/icons/table';
    import ChartColumn from '@lucide/svelte/icons/chart-column';

    // Types mirror the /api/usage response. Declared locally rather than imported
    // from $lib/server/usage because that module opens the database — SvelteKit
    // must never pull it into the client bundle.
    type Category = 'chat' | 'documents' | 'knowledge' | 'market' | 'other';
    type Span = '1d' | '7d' | '30d';

    interface Totals {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        calls: number;
        estimatedTokens: number;
    }
    interface SeriesPoint {
        bucket: string;
        startMs: number;
        byCategory: Record<Category, Totals>;
        total: Totals;
    }
    interface OperationRow {
        operation: string;
        category: Category;
        totals: Totals;
    }
    interface ModelRow {
        provider: string;
        model: string;
        kind: string;
        totals: Totals;
    }
    interface UsageReport {
        span: Span;
        resolution: 'hour' | '6hour' | 'day';
        bucketMinutes: number;
        from: string;
        generatedAt: string;
        series: SeriesPoint[];
        window: {
            byCategory: Record<Category, Totals>;
            total: Totals;
            byOperation: OperationRow[];
        };
        cumulative: {
            byCategory: Record<Category, Totals>;
            total: Totals;
            byOperation: OperationRow[];
            byModel: ModelRow[];
            failedCalls: number;
            firstRecordedAt: string | null;
            lastRecordedAt: string | null;
        };
        categoryLabels: Record<Category, string>;
    }

    // Stack order is fixed and matches the server's category order. Colour follows
    // the category, never its current size — a quiet week must not repaint the
    // series a reader has already learned.
    const CATEGORIES: { key: Category; label: string; hint: string; icon: typeof Coins }[] = [
        { key: 'chat', label: 'Chat', hint: 'Answering user questions', icon: MessageSquare },
        { key: 'documents', label: 'Document processing', hint: 'Cleaning, summarizing, chunking, embedding', icon: FileText },
        { key: 'knowledge', label: 'Knowledge base', hint: 'Extraction, taxonomy, communities, consistency', icon: Network },
        { key: 'market', label: 'Market research', hint: 'Web search and assessment of the portfolio', icon: Globe },
        { key: 'other', label: 'Other', hint: 'Calls outside a tracked pipeline', icon: CircleDashed }
    ];

    const SPANS: { key: Span; label: string; resolutionNote: string }[] = [
        { key: '1d', label: '24 hours', resolutionNote: 'hourly' },
        { key: '7d', label: '7 days', resolutionNote: '6-hourly' },
        { key: '30d', label: '30 days', resolutionNote: 'daily' }
    ];

    let span = $state<Span>('7d');
    let report = $state<UsageReport | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let showTable = $state(false);
    let hoverIndex = $state<number | null>(null);

    /** Plot width, measured so the SVG is responsive without distorting text. */
    let chartWidth = $state(760);

    async function load(next: Span) {
        loading = true;
        error = null;
        try {
            // Minutes to ADD to UTC for local time — the inverse of the JS API's
            // sign, matching what the server expects. Sent so buckets are floored
            // on the viewer's clock (a "day" is their day, not a UTC day).
            const tz = -new Date().getTimezoneOffset();
            const res = await fetch(`/api/usage?span=${next}&tz=${tz}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Request failed (${res.status})`);
            }
            report = await res.json();
        } catch (e) {
            error = (e as Error).message;
        } finally {
            loading = false;
        }
    }

    function selectSpan(next: Span) {
        if (next === span) return;
        span = next;
        hoverIndex = null;
        load(next);
    }

    onMount(() => load(span));

    // ── Formatting ──────────────────────────────────────────────────────────
    const fullNumber = new Intl.NumberFormat();

    /** Compact form for tiles and the hero figure: 942 / 12.9K / 4.2M. */
    function compact(n: number): string {
        if (!Number.isFinite(n)) return '0';
        if (n < 1000) return String(Math.round(n));
        if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
        if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
        return `${(n / 1e9).toFixed(1)}B`;
    }

    const hourFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    const dayHourFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit' });
    const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
    /** Matches dayHourFmt's hour style, so a range reads "Jul 26, 12 PM – 06 PM". */
    const hourOnlyFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit' });

    function axisLabel(startMs: number, resolution: string): string {
        if (resolution === 'hour') return hourFmt.format(startMs);
        if (resolution === 'day') return dayFmt.format(startMs);
        // 6-hour buckets: the labelled ones land on local midnight often enough that
        // spelling out "12 AM" on every tick is pure noise. Show the date alone at a
        // day boundary and the time only when the tick is mid-day.
        return new Date(startMs).getHours() === 0
            ? dayFmt.format(startMs)
            : dayHourFmt.format(startMs);
    }

    function bucketRangeLabel(point: SeriesPoint, minutes: number, resolution: string): string {
        const end = point.startMs + minutes * 60_000;
        if (resolution === 'day') return dayFmt.format(point.startMs);
        return `${dayHourFmt.format(point.startMs)} – ${hourOnlyFmt.format(end)}`;
    }

    /** 'extract_knowledge' → 'Extract knowledge'. */
    function prettyOperation(op: string): string {
        const words = op.replace(/_/g, ' ');
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    function share(part: number, whole: number): string {
        if (whole <= 0) return '0%';
        const pct = (part / whole) * 100;
        return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
    }

    // ── Chart geometry ──────────────────────────────────────────────────────
    const PAD_LEFT = 56;
    const PAD_RIGHT = 10;
    const PAD_TOP = 14;
    const PLOT_HEIGHT = 220;
    const X_AXIS_BAND = 30; // room for tick labels, so the card never scrolls
    const MAX_BAR = 24; // never fill the band — the leftover is air
    const SEGMENT_GAP = 2; // surface-coloured gap between stacked segments

    const svgHeight = PAD_TOP + PLOT_HEIGHT + X_AXIS_BAND;

    /** Ticks at 1/2/5 × 10ⁿ, so the axis reads in round numbers. */
    function niceTicks(max: number, count = 4): number[] {
        if (max <= 0) return [0];
        const rough = max / count;
        const mag = 10 ** Math.floor(Math.log10(rough));
        const norm = rough / mag;
        const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
        const ticks: number[] = [];
        for (let v = 0; v <= max + step / 1000; v += step) ticks.push(v);
        if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
        return ticks;
    }

    const series = $derived(report?.series ?? []);
    const plotWidth = $derived(Math.max(240, chartWidth - PAD_LEFT - PAD_RIGHT));
    const bandWidth = $derived(series.length > 0 ? plotWidth / series.length : plotWidth);
    const barWidth = $derived(Math.max(3, Math.min(MAX_BAR, bandWidth * 0.68)));
    const dataMax = $derived(series.reduce((m, p) => Math.max(m, p.total.totalTokens), 0));
    const ticks = $derived(niceTicks(dataMax));
    const yMax = $derived(Math.max(ticks[ticks.length - 1], 1));
    const baselineY = PAD_TOP + PLOT_HEIGHT;

    function yOf(value: number): number {
        return baselineY - (value / yMax) * PLOT_HEIGHT;
    }

    function bandCenter(index: number): number {
        return PAD_LEFT + bandWidth * (index + 0.5);
    }

    /**
     * Rectangle path with optional rounded top corners — the "4px rounded
     * data-end, square at the baseline" spec. A plain `rect` with `rx` would
     * round all four corners, including the end that sits on the baseline.
     */
    function segmentPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
        const r = roundTop ? Math.min(4, h / 2, w / 2) : 0;
        if (r <= 0.5) return `M${x} ${y}h${w}v${h}h${-w}Z`;
        return (
            `M${x} ${y + r}` +
            `a${r} ${r} 0 0 1 ${r} ${-r}` +
            `h${w - 2 * r}` +
            `a${r} ${r} 0 0 1 ${r} ${r}` +
            `v${h - r}h${-w}Z`
        );
    }

    interface Segment {
        category: Category;
        path: string;
    }

    /**
     * Stacked segments for one bucket, bottom-up in fixed category order.
     *
     * Zero-value categories are skipped entirely so the "is this the top
     * segment?" test (which decides the rounded cap) looks at the real top of the
     * bar rather than an invisible empty one.
     */
    function segmentsFor(point: SeriesPoint): Segment[] {
        const present = CATEGORIES.filter((c) => point.byCategory[c.key].totalTokens > 0);
        const x = bandCenter(series.indexOf(point)) - barWidth / 2;
        const out: Segment[] = [];
        let cumulative = 0;

        present.forEach((cat, idx) => {
            const value = point.byCategory[cat.key].totalTokens;
            const yBottom = yOf(cumulative);
            const yTop = yOf(cumulative + value);
            const rawHeight = yBottom - yTop;
            const isTop = idx === present.length - 1;
            // Trim the gap off the TOP of every non-top segment, which is what puts
            // surface colour between it and the segment above. Clamped so a hairline
            // segment degrades to a thin sliver instead of inverting.
            const height = isTop ? rawHeight : Math.max(rawHeight - SEGMENT_GAP, 0.75);
            const y = yTop + (rawHeight - height);
            out.push({ category: cat.key, path: segmentPath(x, y, barWidth, height, isTop) });
            cumulative += value;
        });

        return out;
    }

    /** Show ~8 x-axis labels at most, so ticks never collide. */
    const labelEvery = $derived(Math.max(1, Math.ceil(series.length / 8)));

    const hoveredPoint = $derived(hoverIndex !== null ? (series[hoverIndex] ?? null) : null);

    /** Tooltip x, clamped so it never leaves the card. */
    const tooltipLeft = $derived(
        hoverIndex === null ? 0 : Math.min(Math.max(bandCenter(hoverIndex), 120), chartWidth - 120)
    );

    const hasAnyUsage = $derived((report?.cumulative.total.calls ?? 0) > 0);
    const estimatedShare = $derived(
        report && report.cumulative.total.totalTokens > 0
            ? report.cumulative.total.estimatedTokens / report.cumulative.total.totalTokens
            : 0
    );
    const activeSpan = $derived(SPANS.find((s) => s.key === span) ?? SPANS[1]);
</script>

<div class="usage-root p-6 max-w-6xl">
    <header class="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
            <h1 class="page-title">Token usage</h1>
            <p class="page-subtitle mt-1">
                What this instance spends its model tokens on — answering questions, processing
                documents, and building the knowledge base.
            </p>
        </div>

        <!-- One filter row, above everything it scopes. -->
        <div class="tabs" role="tablist" aria-label="Time span">
            {#each SPANS as option}
                <button
                    type="button"
                    role="tab"
                    aria-selected={span === option.key}
                    class="tab {span === option.key ? 'tab-active' : ''}"
                    onclick={() => selectSpan(option.key)}
                >
                    {option.label}
                </button>
            {/each}
        </div>
    </header>

    {#if error}
        <div class="card p-5 flex items-start gap-3">
            <TriangleAlert class="w-4 h-4 text-faint mt-0.5 shrink-0" />
            <div>
                <p class="text-sm font-medium text-body">Could not load usage data</p>
                <p class="text-xs text-faint mt-1">{error}</p>
                <button type="button" class="btn btn-secondary btn-sm mt-3" onclick={() => load(span)}>
                    Retry
                </button>
            </div>
        </div>
    {:else if !report && loading}
        <div class="card p-5">
            <p class="text-sm text-faint">Loading usage data…</p>
        </div>
    {:else if report}
        <!-- Held at reduced opacity during a refetch rather than replaced by a
             skeleton, so switching span doesn't flash or jump the layout. -->
        <div class:refetching={loading}>
            <!-- ── Chart ──────────────────────────────────────────────── -->
            <section class="card p-5">
                <div class="flex flex-wrap items-baseline justify-between gap-3">
                    <div>
                        <h2 class="text-sm font-semibold text-body">
                            Tokens over the last {activeSpan.label}
                        </h2>
                        <p class="text-xs text-faint mt-0.5">
                            {activeSpan.resolutionNote} buckets ·
                            {fullNumber.format(report.window.total.totalTokens)} tokens across
                            {fullNumber.format(report.window.total.calls)} calls
                        </p>
                    </div>
                    <button
                        type="button"
                        class="btn btn-ghost btn-sm"
                        onclick={() => (showTable = !showTable)}
                        aria-pressed={showTable}
                    >
                        {#if showTable}
                            <ChartColumn class="w-3.5 h-3.5" /> Chart
                        {:else}
                            <Table class="w-3.5 h-3.5" /> Table
                        {/if}
                    </button>
                </div>

                <!-- Legend, always present, each entry carrying its window total.
                     The values are also the relief for the two light-mode fills
                     that sit under 3:1 against a white card. -->
                <ul class="legend mt-4">
                    {#each CATEGORIES as cat}
                        <li>
                            <span class="swatch" style="background: var(--series-{cat.key})"></span>
                            <span class="text-[13px] text-dim">{cat.label}</span>
                            <span class="text-[13px] font-semibold text-body tabular-nums">
                                {fullNumber.format(report.window.byCategory[cat.key].totalTokens)}
                            </span>
                        </li>
                    {/each}
                </ul>

                {#if showTable}
                    <div class="table-scroll mt-4">
                        <table class="data-table">
                            <caption class="sr-only">
                                Token usage per {activeSpan.resolutionNote} bucket, by category
                            </caption>
                            <thead>
                                <tr>
                                    <th scope="col" class="text-left">Bucket</th>
                                    {#each CATEGORIES as cat}
                                        <th scope="col" class="text-right">{cat.label}</th>
                                    {/each}
                                    <th scope="col" class="text-right">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each series as point}
                                    <tr>
                                        <th scope="row" class="text-left font-normal text-dim">
                                            {bucketRangeLabel(point, report.bucketMinutes, report.resolution)}
                                        </th>
                                        {#each CATEGORIES as cat}
                                            <td class="text-right tabular-nums">
                                                {fullNumber.format(point.byCategory[cat.key].totalTokens)}
                                            </td>
                                        {/each}
                                        <td class="text-right tabular-nums font-semibold text-body">
                                            {fullNumber.format(point.total.totalTokens)}
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {:else}
                    <div class="chart-wrap mt-3" bind:clientWidth={chartWidth}>
                        <svg
                            width="100%"
                            height={svgHeight}
                            viewBox={`0 0 ${chartWidth} ${svgHeight}`}
                            role="img"
                            aria-label={`Stacked token usage per ${activeSpan.resolutionNote} bucket over the last ${activeSpan.label}. Total ${fullNumber.format(report.window.total.totalTokens)} tokens. Use the Table button for exact values.`}
                        >
                            <!-- Gridlines: solid hairlines, one step off the surface. -->
                            {#each ticks as tick}
                                <line
                                    class="gridline"
                                    x1={PAD_LEFT}
                                    x2={PAD_LEFT + plotWidth}
                                    y1={yOf(tick)}
                                    y2={yOf(tick)}
                                />
                                <text class="axis-text" x={PAD_LEFT - 10} y={yOf(tick)} text-anchor="end" dominant-baseline="middle">
                                    {compact(tick)}
                                </text>
                            {/each}

                            <line class="baseline" x1={PAD_LEFT} x2={PAD_LEFT + plotWidth} y1={baselineY} y2={baselineY} />

                            {#each series as point, i}
                                {#each segmentsFor(point) as segment}
                                    <path d={segment.path} fill={`var(--series-${segment.category})`} />
                                {/each}

                                {#if i % labelEvery === 0}
                                    <text class="axis-text" x={bandCenter(i)} y={baselineY + 18} text-anchor="middle">
                                        {axisLabel(point.startMs, report.resolution)}
                                    </text>
                                {/if}

                                <!-- Hit target spans the whole band and the whole plot
                                     height, so hovering never requires landing on a
                                     thin bar. -->
                                <rect
                                    class="hit"
                                    x={PAD_LEFT + bandWidth * i}
                                    y={PAD_TOP}
                                    width={bandWidth}
                                    height={PLOT_HEIGHT}
                                    role="presentation"
                                    onmouseenter={() => (hoverIndex = i)}
                                    onmouseleave={() => (hoverIndex = null)}
                                />
                            {/each}

                            {#if hoverIndex !== null}
                                <line
                                    class="crosshair"
                                    x1={bandCenter(hoverIndex)}
                                    x2={bandCenter(hoverIndex)}
                                    y1={PAD_TOP}
                                    y2={baselineY}
                                />
                            {/if}
                        </svg>

                        {#if hoveredPoint}
                            <div class="tooltip" style={`left: ${tooltipLeft}px`}>
                                <p class="tooltip-title">
                                    {bucketRangeLabel(hoveredPoint, report.bucketMinutes, report.resolution)}
                                </p>
                                {#each CATEGORIES as cat}
                                    {#if hoveredPoint.byCategory[cat.key].totalTokens > 0}
                                        <p class="tooltip-row">
                                            <span class="swatch" style="background: var(--series-{cat.key})"></span>
                                            <span class="tooltip-label">{cat.label}</span>
                                            <span class="tooltip-value">
                                                {fullNumber.format(hoveredPoint.byCategory[cat.key].totalTokens)}
                                            </span>
                                        </p>
                                    {/if}
                                {/each}
                                <p class="tooltip-row tooltip-total">
                                    <span class="tooltip-label">Total</span>
                                    <span class="tooltip-value">
                                        {fullNumber.format(hoveredPoint.total.totalTokens)}
                                    </span>
                                </p>
                                {#if hoveredPoint.total.calls === 0}
                                    <p class="tooltip-empty">No model calls in this bucket</p>
                                {:else}
                                    <p class="tooltip-empty">
                                        {fullNumber.format(hoveredPoint.total.calls)} calls
                                    </p>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/if}
            </section>

            {#if !hasAnyUsage}
                <div class="card p-5 mt-4">
                    <p class="text-sm font-medium text-body">No token usage recorded yet</p>
                    <p class="text-xs text-faint mt-1">
                        Accounting starts from the moment this feature was deployed — earlier chat
                        turns and ingestion runs are not backfilled, because the token counts were
                        never captured. Ask a question or ingest a document and numbers will appear
                        here.
                    </p>
                </div>
            {/if}

            <!-- ── Cumulative ─────────────────────────────────────────── -->
            <section class="mt-6">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 class="text-sm font-semibold text-body">All-time totals</h2>
                    <p class="text-xs text-faint">
                        {#if report.cumulative.firstRecordedAt}
                            Since {report.cumulative.firstRecordedAt} UTC
                        {:else}
                            Nothing recorded yet
                        {/if}
                    </p>
                </div>

                <div class="card p-5 mt-3">
                    <div class="flex flex-wrap items-end gap-x-8 gap-y-4">
                        <div>
                            <p class="text-xs text-faint">Total tokens</p>
                            <!-- Hero figure: one per view, proportional figures. -->
                            <p class="hero mt-1">{compact(report.cumulative.total.totalTokens)}</p>
                            <p class="text-xs text-faint mt-1">
                                {fullNumber.format(report.cumulative.total.totalTokens)} across
                                {fullNumber.format(report.cumulative.total.calls)} model calls
                            </p>
                        </div>
                        <dl class="grid grid-cols-2 gap-x-8 gap-y-2">
                            <div>
                                <dt class="text-xs text-faint">Input</dt>
                                <dd class="text-sm font-semibold text-body tabular-nums">
                                    {fullNumber.format(report.cumulative.total.promptTokens)}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-faint">Output</dt>
                                <dd class="text-sm font-semibold text-body tabular-nums">
                                    {fullNumber.format(report.cumulative.total.completionTokens)}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-faint">Estimated</dt>
                                <dd class="text-sm font-semibold text-body tabular-nums">
                                    {share(report.cumulative.total.estimatedTokens, report.cumulative.total.totalTokens)}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-faint">Failed calls</dt>
                                <dd class="text-sm font-semibold text-body tabular-nums">
                                    {fullNumber.format(report.cumulative.failedCalls)}
                                </dd>
                            </div>
                        </dl>
                    </div>

                    {#if estimatedShare > 0.02}
                        <p class="note mt-4">
                            {share(report.cumulative.total.estimatedTokens, report.cumulative.total.totalTokens)}
                            of these tokens are approximated from text length because the provider
                            reported no usage figures for those calls — embeddings via Gemini report
                            none, and a gateway that ignores <code>stream_options</code> reports none
                            for streamed answers.
                        </p>
                    {/if}
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                    {#each CATEGORIES as cat}
                        {@const totals = report.cumulative.byCategory[cat.key]}
                        <div class="card p-4">
                            <div class="flex items-start justify-between gap-2">
                                <span class="swatch swatch-lg" style="background: var(--series-{cat.key})"></span>
                                <span class="text-2xl font-semibold tracking-tight text-strong">
                                    {compact(totals.totalTokens)}
                                </span>
                            </div>
                            <p class="text-[13px] font-medium text-body mt-3">{cat.label}</p>
                            <p class="text-xs text-faint mt-0.5">{cat.hint}</p>
                            <p class="text-xs text-faint mt-2 tabular-nums">
                                {share(totals.totalTokens, report.cumulative.total.totalTokens)} of total ·
                                {fullNumber.format(totals.calls)} calls
                            </p>
                        </div>
                    {/each}
                </div>
            </section>

            <!-- ── Breakdowns ─────────────────────────────────────────── -->
            {#if report.cumulative.byOperation.length > 0}
                <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
                    <div class="card p-5">
                        <h2 class="text-sm font-semibold text-body">By operation</h2>
                        <p class="text-xs text-faint mt-0.5">
                            All-time, most expensive first. Each operation is one LLM task in the
                            pipeline.
                        </p>
                        <div class="table-scroll mt-4">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th scope="col" class="text-left">Operation</th>
                                        <th scope="col" class="text-left">Category</th>
                                        <th scope="col" class="text-right">Tokens</th>
                                        <th scope="col" class="text-right">Calls</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each report.cumulative.byOperation as row}
                                        <tr>
                                            <th scope="row" class="text-left font-normal text-body">
                                                {prettyOperation(row.operation)}
                                            </th>
                                            <td class="text-left">
                                                <span class="inline-flex items-center gap-1.5">
                                                    <span class="swatch" style="background: var(--series-{row.category})"></span>
                                                    <span class="text-dim">{report.categoryLabels[row.category]}</span>
                                                </span>
                                            </td>
                                            <td class="text-right tabular-nums">
                                                {fullNumber.format(row.totals.totalTokens)}
                                            </td>
                                            <td class="text-right tabular-nums text-dim">
                                                {fullNumber.format(row.totals.calls)}
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div class="card p-5">
                        <h2 class="text-sm font-semibold text-body">By model</h2>
                        <p class="text-xs text-faint mt-0.5">
                            All-time, split by provider and call kind — the LiteLLM gateway is
                            primary, Gemini is the fallback.
                        </p>
                        <div class="table-scroll mt-4">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th scope="col" class="text-left">Model</th>
                                        <th scope="col" class="text-left">Provider</th>
                                        <th scope="col" class="text-left">Kind</th>
                                        <th scope="col" class="text-right">Tokens</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each report.cumulative.byModel as row}
                                        <tr>
                                            <th scope="row" class="text-left font-normal text-body break-all">
                                                {row.model}
                                            </th>
                                            <td class="text-left text-dim">{row.provider}</td>
                                            <td class="text-left text-dim">{row.kind}</td>
                                            <td class="text-right tabular-nums">
                                                {fullNumber.format(row.totals.totalTokens)}
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
            {/if}
        </div>
    {/if}
</div>

<style>
    /* Categorical series colours.
       Slots 1-4 of the validated categorical order (blue, orange, aqua, yellow),
       assigned to a fixed category each — colour follows the entity, so a filter
       or a quiet period never repaints a series.

       Dark values are the same hues re-stepped for the dark surface, not a flip.
       Declared under :root because this app's dark theme IS the default and
       [data-theme="light"] overrides it (see layout.css).

       Validated with the skill's validator against this app's own card surfaces
       (#ffffff light, #222a28 dark), adjacent pairlist:
         light — worst adjacent CVD ΔE 9.1, normal-vision 22.9  → PASS
         dark  — worst adjacent CVD ΔE 8.4, normal-vision 19.8  → PASS
       Light mode WARNs on contrast for aqua/yellow (2.82/2.17 vs white), so the
       relief rule applies: the legend carries each series' value and the chart has
       a table view, both shipped above.

       --series-market (slot 5, violet) was added later for the market research
       category and has NOT been through that validator, so the pairlist result
       above describes the original four only. It sits between knowledge (aqua)
       and other (yellow) in stack order, neither of which it is close to in hue;
       the pair to re-check if this is ever validated is violet against chat's
       blue, which CVD simulation pulls in the same direction. The relief rule
       already in place — labelled legend values plus the table view — is what
       carries it until then. */
    .usage-root {
        --series-chat: #3987e5;
        --series-documents: #d95926;
        --series-knowledge: #199e70;
        --series-market: #a563d8;
        --series-other: #c98500;
        --chart-grid: var(--line-subtle);
        --chart-baseline: var(--line);
    }

    :global([data-theme='light']) .usage-root {
        --series-chat: #2a78d6;
        --series-documents: #eb6834;
        --series-knowledge: #1baf7a;
        --series-market: #9450cc;
        --series-other: #eda100;
    }

    .refetching {
        opacity: 0.55;
        transition: opacity 0.15s ease;
    }

    .chart-wrap {
        position: relative;
        width: 100%;
    }

    .chart-wrap svg {
        display: block;
        overflow: visible;
    }

    /* Recessive chrome: solid hairlines, never dashed. */
    .gridline {
        stroke: var(--chart-grid);
        stroke-width: 1;
    }

    .baseline {
        stroke: var(--chart-baseline);
        stroke-width: 1;
    }

    .crosshair {
        stroke: var(--chart-baseline);
        stroke-width: 1;
        pointer-events: none;
    }

    /* Axis text wears a text token, never a series colour. */
    .axis-text {
        fill: var(--text-faint);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
    }

    .hit {
        fill: transparent;
        cursor: crosshair;
    }

    .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem 1.25rem;
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .legend li {
        display: inline-flex;
        align-items: center;
        gap: 0.4375rem;
    }

    .swatch {
        display: inline-block;
        width: 0.625rem;
        height: 0.625rem;
        border-radius: 0.1875rem;
        flex-shrink: 0;
    }

    .swatch-lg {
        width: 0.875rem;
        height: 0.875rem;
        border-radius: 0.25rem;
        margin-top: 0.25rem;
    }

    .hero {
        font-size: 3rem;
        line-height: 1.05;
        font-weight: 650;
        letter-spacing: -0.02em;
        color: var(--text-strong);
        /* Proportional figures deliberately: tabular-nums makes a large number
           look loose at this size. */
    }

    .tooltip {
        position: absolute;
        top: 0.5rem;
        transform: translateX(-50%);
        min-width: 11rem;
        padding: 0.625rem 0.75rem;
        background: var(--bg-raised);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg, 0.5rem);
        box-shadow: var(--elev-2);
        pointer-events: none;
        z-index: 5;
    }

    .tooltip-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-strong);
        margin-bottom: 0.375rem;
    }

    .tooltip-row {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        font-size: 0.75rem;
        line-height: 1.5;
    }

    .tooltip-label {
        color: var(--text-muted);
    }

    .tooltip-value {
        margin-left: auto;
        color: var(--text-primary);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .tooltip-total {
        margin-top: 0.25rem;
        padding-top: 0.25rem;
        border-top: 1px solid var(--line-subtle);
    }

    .tooltip-empty {
        margin-top: 0.25rem;
        font-size: 0.6875rem;
        color: var(--text-faint);
    }

    .note {
        font-size: 0.75rem;
        line-height: 1.6;
        color: var(--text-muted);
        padding-top: 0.75rem;
        border-top: 1px solid var(--line-subtle);
    }

    .note code {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 0.6875rem;
        padding: 0.05rem 0.25rem;
        border-radius: 0.25rem;
        background: var(--bg-muted);
    }

    /* Wide tables scroll inside their own container — the page body never
       scrolls horizontally. */
    /* Wide tables scroll inside their own container; tall ones cap out rather than
       stretching the page. The cap is sized so the operation list — bounded by the
       number of distinct LLM tasks in the pipeline, ~20 — fits without scrolling,
       so the common case doesn't show a row clipped in half at the card edge. */
    .table-scroll {
        overflow-x: auto;
        max-height: 34rem;
        overflow-y: auto;
    }

    .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.75rem;
    }

    .data-table th,
    .data-table td {
        padding: 0.375rem 0.5rem;
        white-space: nowrap;
    }

    .data-table thead th {
        position: sticky;
        top: 0;
        background: var(--bg-surface);
        font-weight: 600;
        color: var(--text-faint);
        border-bottom: 1px solid var(--line);
        text-transform: uppercase;
        font-size: 0.625rem;
        letter-spacing: 0.06em;
    }

    .data-table tbody tr + tr th,
    .data-table tbody tr + tr td {
        border-top: 1px solid var(--line-subtle);
    }

    .data-table tbody td {
        color: var(--text-primary);
    }

    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }
</style>
