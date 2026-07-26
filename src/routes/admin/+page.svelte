<script lang="ts">
    import { onMount } from 'svelte';
    import FileText from '@lucide/svelte/icons/file-text';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Users from '@lucide/svelte/icons/users';
import Activity from '@lucide/svelte/icons/activity';

    let stats = $state({
        documents: 0,
        repos: 0,
        users: 0
    });

    onMount(async () => {
        const [docsRes, reposRes, usersRes] = await Promise.all([
            fetch('/api/documents'),
            fetch('/api/git'),
            fetch('/api/users')
        ]);

        if (docsRes.ok) stats.documents = (await docsRes.json()).length;
        if (reposRes.ok) stats.repos = (await reposRes.json()).length;
        if (usersRes.ok) stats.users = (await usersRes.json()).length;
    });
</script>

<div class="p-6 max-w-5xl">
    <header class="mb-6">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle mt-1">Overview of this Archie instance.</p>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        {#each [
            { label: 'Documents', value: stats.documents, hint: 'Indexed knowledge base files', icon: FileText, href: '/admin/documents' },
            { label: 'Git repos', value: stats.repos, hint: 'Connected source repositories', icon: GitBranch, href: '/admin/repos' },
            { label: 'Users', value: stats.users, hint: 'Registered system users', icon: Users, href: '/admin/users' }
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