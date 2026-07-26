<script lang="ts">
    import BookOpen from '@lucide/svelte/icons/book-open';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import GitBranch from '@lucide/svelte/icons/git-branch';
import ExternalLink from '@lucide/svelte/icons/external-link';

    let repos = $state<any[]>([]);
    let loading = $state(true);

    $effect(() => {
        loadRepos();
    });

    async function loadRepos() {
        loading = true;
        try {
            const res = await fetch('/api/wiki');
            if (res.ok) repos = await res.json();
        } catch {
            // Ignore — may be aborted during navigation
        } finally {
            loading = false;
        }
    }

    function getRepoName(repo: any): string {
        const parts = repo.url.split('/');
        return parts[parts.length - 1] || repo.url;
    }
</script>

<div class="h-full flex flex-col items-center justify-center p-8">
    <div class="max-w-xl w-full">
        <div class="mb-6">
            <h1 class="page-title">Wiki</h1>
            <p class="page-subtitle mt-1">Browse and edit markdown from your connected repositories.</p>
        </div>

        {#if loading}
            <div class="flex justify-center py-12">
                <div class="spinner w-6 h-6"></div>
            </div>
        {:else if repos.length === 0}
            <div class="card p-8 text-center">
                <GitBranch class="w-8 h-8 text-ghost mx-auto" />
                <h2 class="text-sm font-semibold text-body mt-3">No repositories connected</h2>
                <p class="text-[13px] text-mute mt-1.5 max-w-sm mx-auto">
                    Connect a git repository in the admin panel to start browsing wiki documents.
                </p>
                <a href="/admin/repos" class="btn btn-secondary btn-sm mt-4">Open admin panel</a>
            </div>
        {:else}
            <div class="space-y-2">
                {#each repos as repo}
                    <a href={`/wiki/${repo.id}`} class="card card-hover flex items-center gap-3 p-4 group">
                        <BookOpen class="w-4 h-4 text-faint flex-shrink-0" />
                        <div class="flex-1 min-w-0">
                            <h2 class="text-sm font-medium text-body truncate">{getRepoName(repo)}</h2>
                            <p class="text-xs text-faint font-mono truncate mt-0.5">{repo.url}</p>
                        </div>
                        <ChevronRight class="w-4 h-4 text-ghost group-hover:text-mute transition-colors flex-shrink-0" />
                    </a>
                {/each}
            </div>
        {/if}
    </div>
</div>