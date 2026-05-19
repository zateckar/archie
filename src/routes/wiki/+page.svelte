<script lang="ts">
    import { BookOpen, ChevronRight, GitBranch, ExternalLink } from 'lucide-svelte';

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
        } catch (err) {
            console.error(err);
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
    <div class="max-w-2xl w-full">
        <div class="text-center mb-12">
            <div class="inline-flex p-3 bg-[#0E3A2F]/30 rounded-2xl border border-[#0E3A2F]/50 mb-6">
                <BookOpen class="w-8 h-8 text-[#78FAAE]" />
            </div>
            <h1 class="text-4xl font-black text-white mb-3">Wiki</h1>
            <p class="text-slate-400 text-lg">Browse and edit markdown documents from your connected repositories.</p>
        </div>

        {#if loading}
            <div class="flex justify-center py-12">
                <div class="w-6 h-6 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
            </div>
        {:else if repos.length === 0}
            <div class="text-center py-12 bg-slate-900/50 border border-slate-800 rounded-3xl">
                <GitBranch class="w-12 h-12 text-slate-700 mx-auto mb-4" />
                <h3 class="text-lg font-bold text-slate-400 mb-2">No repositories connected</h3>
                <p class="text-sm text-slate-600 max-w-md mx-auto">
                    Connect git repositories in the admin panel to start browsing wiki documents.
                </p>
            </div>
        {:else}
            <div class="space-y-3">
                {#each repos as repo}
                    <a 
                        href={`/wiki/${repo.id}`}
                        class="flex items-center gap-4 p-5 bg-slate-900/50 border border-slate-800 rounded-2xl hover:border-slate-700 hover:bg-slate-900/80 transition-all group"
                    >
                        <div class="w-12 h-12 rounded-xl bg-[#0E3A2F]/30 flex items-center justify-center text-[#78FAAE] flex-shrink-0">
                            <BookOpen class="w-6 h-6" />
                        </div>
                        <div class="flex-1 min-w-0">
                            <h3 class="font-bold text-white text-lg group-hover:text-[#78FAAE] transition-colors truncate">{getRepoName(repo)}</h3>
                            <p class="text-xs text-slate-500 font-mono truncate mt-0.5">{repo.url}</p>
                        </div>
                        <ChevronRight class="w-5 h-5 text-slate-500 group-hover:text-[#78FAAE] transition-colors flex-shrink-0" />
                    </a>
                {/each}
            </div>
        {/if}
    </div>
</div>