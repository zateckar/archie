<script lang="ts">
    import { onMount } from 'svelte';
    import FileText from '@lucide/svelte/icons/file-text';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Users from '@lucide/svelte/icons/users';
import Activity from '@lucide/svelte/icons/activity';
import Coins from '@lucide/svelte/icons/coins';
import Network from '@lucide/svelte/icons/network';
import Globe from '@lucide/svelte/icons/globe';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';

    let stats = $state({
        documents: 0,
        repos: 0,
        users: 0,
        tokens: 0
    });

    interface LeanixStatus {
        configured: boolean;
        total: number;
        byType: Record<string, number>;
        lastSyncAt: number | null;
        lastFullFetchAt: number | null;
        syncing: boolean;
    }
    let leanix = $state<LeanixStatus | null>(null);
    let syncing = $state(false);
    let syncMessage = $state('');

    interface MarketStatus {
        configured: boolean;
        total: number;
        researched: number;
        identified: number;
        errored: number;
        alerts: number;
        urgentAlerts: number;
        lastRunAt: number | null;
        batchLimit: number;
        running: boolean;
    }
    let market = $state<MarketStatus | null>(null);
    let researching = $state(false);
    let researchMessage = $state('');

    function ago(ms: number | null): string {
        if (!ms) return 'never';
        const hours = Math.floor((Date.now() - ms) / 3_600_000);
        if (hours < 1) return 'just now';
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    async function loadLeanix() {
        const res = await fetch('/api/leanix');
        if (res.ok) leanix = await res.json();
    }

    /**
     * Forces a full fetch. Ingestion stays hash-gated on the other side, so this
     * costs two LeanIX requests and only re-processes factsheets that changed.
     */
    async function syncLeanix() {
        syncing = true;
        syncMessage = '';
        try {
            const res = await fetch('/api/leanix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force: true })
            });
            const result = await res.json();
            syncMessage = res.ok
                ? `${result.factsheets} factsheets · ${result.ingested} re-ingested · ${result.unchanged} unchanged · ${result.removed} removed`
                : (result.error ?? 'Sync failed');
            await loadLeanix();
        } catch (err) {
            syncMessage = (err as Error).message;
        } finally {
            syncing = false;
        }
    }

    async function loadMarket() {
        const res = await fetch('/api/leanix/market-research');
        if (res.ok) market = await res.json();
    }

    /**
     * Runs the next batch. Deliberately NOT forced: this button exists to move
     * the backlog along, and forcing would re-buy assessments that are still
     * fresh — every one of which costs a billed web search plus tokens.
     */
    async function runResearch() {
        researching = true;
        researchMessage = '';
        try {
            const res = await fetch('/api/leanix/market-research', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const result = await res.json();
            researchMessage = res.ok
                ? (result.status === 'skipped'
                    ? `Skipped — ${result.reason}`
                    : `${result.researched} researched · ${result.identified} identified · ${result.unidentified} not found · ${result.alerts} alert(s)` +
                      (result.due > result.researched ? ` · ${result.due - result.researched} still queued` : '') +
                      (result.failed.length ? ` · ${result.failed.length} failed` : ''))
                : (result.error ?? 'Research failed');
            await loadMarket();
        } catch (err) {
            researchMessage = (err as Error).message;
        } finally {
            researching = false;
        }
    }

    /** Compact form so a multi-million token count still fits the tile. */
    function compact(n: number): string {
        if (n < 1000) return String(Math.round(n));
        if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
        if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
        return `${(n / 1e9).toFixed(1)}B`;
    }

    onMount(async () => {
        const [docsRes, reposRes, usersRes, usageRes] = await Promise.all([
            fetch('/api/documents'),
            fetch('/api/git'),
            fetch('/api/users'),
            fetch('/api/usage?span=1d')
        ]);

        if (docsRes.ok) stats.documents = (await docsRes.json()).length;
        if (reposRes.ok) stats.repos = (await reposRes.json()).length;
        if (usersRes.ok) stats.users = (await usersRes.json()).length;
        if (usageRes.ok) stats.tokens = (await usageRes.json()).cumulative.total.totalTokens;

        await Promise.all([loadLeanix(), loadMarket()]);
    });
</script>

<div class="p-6 max-w-5xl">
    <header class="mb-6">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle mt-1">Overview of this Archie instance.</p>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {#each [
            { label: 'Documents', value: String(stats.documents), hint: 'Indexed knowledge base files', icon: FileText, href: '/admin/documents' },
            { label: 'Git repos', value: String(stats.repos), hint: 'Connected source repositories', icon: GitBranch, href: '/admin/repos' },
            { label: 'Users', value: String(stats.users), hint: 'Registered system users', icon: Users, href: '/admin/users' },
            { label: 'Tokens used', value: compact(stats.tokens), hint: 'Chat, ingestion and knowledge base', icon: Coins, href: '/admin/usage' }
        ] as stat}
            <a href={stat.href} class="card card-hover p-5 block">
                <div class="flex items-start justify-between">
                    <stat.icon class="w-4 h-4 text-faint mt-1" />
                    <span class="text-3xl font-semibold tracking-tight text-strong tabular-nums">{stat.value}</span>
                </div>
                <p class="text-sm font-medium text-body mt-4">{stat.label}</p>
                <p class="text-xs text-faint mt-0.5">{stat.hint}</p>
            </a>
        {/each}
    </div>

    {#if leanix}
        <div class="card p-5 mt-6">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <h2 class="flex items-center gap-2 text-sm font-semibold text-body">
                        <Network class="w-4 h-4 text-faint" />
                        LeanIX portfolio
                    </h2>
                    <p class="text-xs text-faint mt-1">
                        Read-only. Syncs once a day and costs two API requests when nothing changed.
                    </p>
                </div>
                <button class="btn btn-secondary btn-sm shrink-0" onclick={syncLeanix} disabled={syncing || !leanix.configured}>
                    <RefreshCw class="w-3.5 h-3.5 {syncing ? 'animate-spin' : ''}" />
                    {syncing ? 'Syncing…' : 'Sync now'}
                </button>
            </div>

            <dl class="mt-4 divide-y divide-[var(--line-subtle)]">
                {#each [
                    { name: 'Status', value: leanix.configured ? 'Configured' : 'Not configured', ok: leanix.configured },
                    { name: 'Factsheets', value: `${leanix.total}${Object.keys(leanix.byType).length ? ` (${Object.entries(leanix.byType).map(([t, c]) => `${c} ${t}`).join(', ')})` : ''}`, ok: leanix.total > 0 },
                    { name: 'Last sync', value: ago(leanix.lastSyncAt), ok: !!leanix.lastSyncAt },
                    { name: 'Last full fetch', value: ago(leanix.lastFullFetchAt), ok: !!leanix.lastFullFetchAt }
                ] as row}
                    <div class="flex items-center justify-between py-2.5">
                        <dt class="text-[13px] text-dim">{row.name}</dt>
                        <dd class="badge {row.ok ? 'badge-success' : 'badge-neutral'}">{row.value}</dd>
                    </div>
                {/each}
            </dl>

            {#if syncMessage}
                <p class="text-xs text-mute mt-3">{syncMessage}</p>
            {/if}
            <a href="/leanix" class="btn btn-ghost btn-sm mt-3 -ml-2.5">View portfolio analytics</a>
        </div>
    {/if}

    {#if market}
        <div class="card p-5 mt-6">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <h2 class="flex items-center gap-2 text-sm font-semibold text-body">
                        <Globe class="w-4 h-4 text-faint" />
                        Market research
                    </h2>
                    <p class="text-xs text-faint mt-1">
                        Searches the web about each portfolio product. Billed per search and per token, so it
                        runs {market.batchLimit} at a time and re-checks each factsheet weekly.
                    </p>
                </div>
                <button class="btn btn-secondary btn-sm shrink-0" onclick={runResearch}
                        disabled={researching || !market.configured}>
                    <RefreshCw class="w-3.5 h-3.5 {researching ? 'animate-spin' : ''}" />
                    {researching ? 'Researching…' : 'Research next batch'}
                </button>
            </div>

            <dl class="mt-4 divide-y divide-[var(--line-subtle)]">
                {#each [
                    { name: 'Status', value: market.configured ? 'Configured' : 'Not configured', ok: market.configured },
                    { name: 'Coverage', value: `${market.researched} of ${market.total} factsheets`, ok: market.researched > 0 },
                    { name: 'Identified on the web', value: `${market.identified}`, ok: market.identified > 0 },
                    { name: 'Open alerts', value: `${market.alerts}${market.urgentAlerts ? ` (${market.urgentAlerts} critical or high)` : ''}`, ok: market.alerts === 0 },
                    { name: 'Last run', value: ago(market.lastRunAt), ok: !!market.lastRunAt }
                ] as row}
                    <div class="flex items-center justify-between py-2.5">
                        <dt class="text-[13px] text-dim">{row.name}</dt>
                        <dd class="badge {row.ok ? 'badge-success' : 'badge-neutral'}">{row.value}</dd>
                    </div>
                {/each}
                {#if market.errored > 0}
                    <div class="flex items-center justify-between py-2.5">
                        <dt class="text-[13px] text-dim">Failed</dt>
                        <dd class="badge badge-warning">{market.errored} — retried automatically</dd>
                    </div>
                {/if}
            </dl>

            {#if researchMessage}
                <p class="text-xs text-mute mt-3">{researchMessage}</p>
            {/if}
            {#if !market.configured}
                <p class="text-xs text-faint mt-3">
                    Requires <code>GEMINI_API_KEY</code> — web search is the one capability the LiteLLM gateway
                    does not provide. Set <code>MARKET_RESEARCH_ENABLED=false</code> to switch it off.
                </p>
            {/if}
        </div>
    {/if}

    <div class="card p-5 mt-6">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-body">
            <Activity class="w-4 h-4 text-faint" />
            System status
        </h2>
        <dl class="mt-4 divide-y divide-[var(--line-subtle)]">
            {#each [
                { name: 'Database', state: 'Online' },
                { name: 'Vector extension', state: 'Loaded' },
                { name: 'Model provider', state: 'Connected' }
            ] as row}
                <div class="flex items-center justify-between py-2.5">
                    <dt class="text-[13px] text-dim">{row.name}</dt>
                    <dd class="badge badge-success">{row.state}</dd>
                </div>
            {/each}
        </dl>
    </div>
</div>