<script lang="ts">
    import { onMount } from 'svelte';
    import FileText from '@lucide/svelte/icons/file-text';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Users from '@lucide/svelte/icons/users';
import Activity from '@lucide/svelte/icons/activity';
import Coins from '@lucide/svelte/icons/coins';

    let stats = $state({
        documents: 0,
        repos: 0,
        users: 0,
        tokens: 0
    });

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