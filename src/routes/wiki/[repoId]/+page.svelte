<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/state';
    import { BookOpen, FileText, Plus, Loader2 } from 'lucide-svelte';

    let { params }: {
        params: { repoId: string };
    } = $props();

    // Capture params reactively
    let repoId = $derived(parseInt(params.repoId));
    let loading = $state(true);
    let defaultPath = $state<string | null>(null);
    let repoName = $state('');
    let showCreateForm = $state(false);
    let newFileName = $state('');

    onMount(async () => {
        // Fetch the tree to check for README.md
        try {
            const treeRes = await fetch(`/api/wiki/${repoId}/tree`);
            if (!treeRes.ok) {
                loading = false;
                return;
            }

            // Check if README.md exists at the root
            const tree = await treeRes.json();
            const hasReadme = tree.some((item: any) => item.name === 'README.md');
            const hasIndex = tree.some((item: any) => item.name === 'index.md');

            if (hasReadme) {
                defaultPath = 'README.md';
            } else if (hasIndex) {
                defaultPath = 'index.md';
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
        }

        // Get repo name
        try {
            const res = await fetch('/api/wiki');
            if (res.ok) {
                const repos = await res.json();
                const repo = repos.find((r: any) => r.id === repoId);
                if (repo) {
                    const parts = repo.url.split('/');
                    repoName = parts[parts.length - 1] || repo.url;
                }
            }
        } catch (err) {}
    });

    async function handleCreateDefault() {
        let name = newFileName.trim() || 'README.md';
        if (!name.endsWith('.md')) name += '.md';
        try {
            const res = await fetch(`/api/wiki/${repoId}/file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    path: name, 
                    content: `# ${repoName || 'Wiki'}\n\nWelcome to the wiki.\n` 
                })
            });
            if (res.ok) {
                window.location.href = `/wiki/${repoId}/${name}`;
            }
        } catch (err) {
            console.error(err);
        }
    }

    // Redirect to default file if found
    $effect(() => {
        if (!loading && defaultPath) {
            window.location.href = `/wiki/${repoId}/${defaultPath}`;
        }
    });
</script>

<div class="h-full flex items-center justify-center p-8">
    {#if loading}
        <div class="w-6 h-6 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
    {:else if !defaultPath}
        <div class="max-w-md text-center">
            <div class="inline-flex p-4 bg-slate-900 rounded-2xl border border-slate-800 mb-6">
                <BookOpen class="w-10 h-10 text-slate-600" />
            </div>
            <h2 class="text-2xl font-bold text-white mb-3">No documents yet</h2>
            <p class="text-slate-400 mb-8">
                This repository doesn't have any markdown documents yet. Create your first one to get started.
            </p>

            {#if showCreateForm}
                <form onsubmit={(e) => { e.preventDefault(); handleCreateDefault(); }} class="flex flex-col gap-3">
                    <input 
                        type="text" 
                        bind:value={newFileName}
                        placeholder="README.md"
                        class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-[#78FAAE]/50"
                    />
                    <div class="flex gap-2 justify-center">
                        <button type="submit" class="px-6 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 rounded-xl font-bold text-sm transition-all">
                            Create Page
                        </button>
                        <button type="button" onclick={() => showCreateForm = false} class="px-4 py-3 hover:bg-slate-800 rounded-xl text-sm transition-all">
                            Cancel
                        </button>
                    </div>
                </form>
            {:else}
                <button onclick={() => showCreateForm = true} class="inline-flex items-center gap-2 px-6 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 rounded-xl font-bold text-sm transition-all">
                    <Plus class="w-4 h-4" />
                    Create First Page
                </button>
            {/if}
        </div>
    {/if}
</div>