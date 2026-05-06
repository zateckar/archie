<script lang="ts">
    import { onMount } from 'svelte';
    import { GitBranch, Trash2, Plus, Loader2, RefreshCw, ExternalLink, Key, Clock } from 'lucide-svelte';

    let gitRepos: any[] = $state([]);
    let loading = $state(true);
    let showAddForm = $state(false);
    let isAddingRepo = $state(false);
    let isSyncing = $state<number | null>(null);
    let newRepoUrl = $state('');
    let newRepoPat = $state('');
    let newRepoSyncInterval = $state(1); // Default 1 hour

    onMount(async () => {
        await loadGitRepos();
    });

    async function loadGitRepos() {
        loading = true;
        try {
            const res = await fetch('/api/git');
            if (res.ok) {
                gitRepos = await res.json();
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
        }
    }

    async function handleAddRepo() {
        if (!newRepoUrl) return;
        isAddingRepo = true;
        try {
            const res = await fetch('/api/git', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    url: newRepoUrl, 
                    pat: newRepoPat, 
                    sync_interval: newRepoSyncInterval * 3600000 
                })
            });
            if (res.ok) {
                newRepoUrl = '';
                newRepoPat = '';
                newRepoSyncInterval = 1;
                showAddForm = false;
                await loadGitRepos();
            }
        } catch (err) {
            console.error(err);
        } finally {
            isAddingRepo = false;
        }
    }

    async function handleSyncRepo(id: number) {
        isSyncing = id;
        try {
            const res = await fetch(`/api/git/${id}/sync`, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Sync failed');
            }
            await loadGitRepos();
        } catch (err: any) {
            alert('Sync failed: ' + err.message);
        } finally {
            isSyncing = null;
        }
    }

    async function handleDeleteRepo(id: number) {
        if (!confirm('Are you sure? This will remove the repo but keep already imported documents.')) return;
        try {
            await fetch(`/api/git/${id}`, { method: 'DELETE' });
            await loadGitRepos();
        } catch (err) {
            console.error(err);
        }
    }

    async function handleUpdateInterval(id: number, hours: number) {
        try {
            await fetch(`/api/git/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sync_interval: hours * 3600000 })
            });
            await loadGitRepos();
        } catch (err) {
            console.error(err);
        }
    }
</script>

<div class="p-8">
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
            <h1 class="text-3xl font-bold text-white mb-2">Git Repositories</h1>
            <p class="text-slate-400">Connect and sync source code repositories.</p>
        </div>
        
        <button 
            onclick={() => showAddForm = !showAddForm}
            class="flex items-center justify-center gap-2 px-6 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 rounded-2xl font-bold transition-all shadow-lg shadow-[#0E3A2F]/20"
        >
            <Plus class="w-5 h-5" />
            <span>Add Repository</span>
        </button>
    </header>

    {#if showAddForm}
        <div class="mb-8 p-8 bg-slate-900 border border-slate-800 rounded-3xl shadow-xl animate-in fade-in slide-in-from-top-4 duration-300">
            <h2 class="text-xl font-bold mb-6 flex items-center gap-2">
                <GitBranch class="w-6 h-6 text-[#78FAAE]" />
                Connect New Repository
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                    <label for="repo-url" class="block text-sm font-medium text-slate-400 mb-2">Repository URL</label>
                    <input 
                        id="repo-url"
                        type="text" 
                        bind:value={newRepoUrl} 
                        placeholder="https://github.com/user/repo" 
                        class="w-full bg-slate-950 border border-slate-800 rounded-2xl p-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all"
                    />
                </div>
                <div>
                    <label for="repo-pat" class="block text-sm font-medium text-slate-400 mb-2">Personal Access Token (Optional)</label>
                    <div class="relative">
                        <Key class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                        <input 
                            id="repo-pat"
                            type="password" 
                            bind:value={newRepoPat} 
                            placeholder="ghp_xxxxxxxxxxxx" 
                            class="w-full bg-slate-950 border border-slate-800 rounded-2xl py-4 pl-12 pr-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all"
                        />
                    </div>
                </div>
                <div>
                    <label for="repo-sync-interval" class="block text-sm font-medium text-slate-400 mb-2">Sync Interval (Hours)</label>
                    <div class="relative">
                        <Clock class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                        <input 
                            id="repo-sync-interval"
                            type="number" 
                            min="1"
                            bind:value={newRepoSyncInterval} 
                            placeholder="1" 
                            class="w-full bg-slate-950 border border-slate-800 rounded-2xl py-4 pl-12 pr-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all"
                        />
                    </div>
                </div>
            </div>
            <div class="mt-8 flex justify-end gap-4">
                <button onclick={() => showAddForm = false} class="px-6 py-3 text-slate-400 hover:text-white transition-colors">Cancel</button>
                <button 
                    onclick={handleAddRepo} 
                    disabled={isAddingRepo || !newRepoUrl}
                    class="px-8 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 disabled:bg-slate-800 rounded-2xl font-bold transition-all flex items-center gap-2"
                >
                    {#if isAddingRepo}
                        <Loader2 class="w-5 h-5 animate-spin" />
                    {/if}
                    Connect Repo
                </button>
            </div>
        </div>
    {/if}

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {#if loading}
            <div class="col-span-full p-12 text-center">
                <Loader2 class="w-8 h-8 animate-spin mx-auto text-slate-500" />
            </div>
        {:else if gitRepos.length === 0}
            <div class="col-span-full p-12 bg-slate-900 border border-slate-800 rounded-3xl text-center text-slate-500 italic">
                No repositories connected yet.
            </div>
        {:else}
            {#each gitRepos as repo}
                <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl hover:border-slate-700 transition-all group">
                    <div class="flex items-start justify-between mb-6">
                        <div class="flex items-center gap-4 overflow-hidden">
                            <div class="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center text-[#78FAAE] flex-shrink-0">
                                <GitBranch class="w-6 h-6" />
                            </div>
                            <div class="overflow-hidden">
                                <h3 class="font-bold text-lg text-slate-200 truncate">{repo.url.split('/').pop()}</h3>
                                <p class="text-xs text-slate-500 font-mono truncate">{repo.url}</p>
                            </div>
                        </div>
                        <button 
                            onclick={() => handleDeleteRepo(repo.id)}
                            class="p-2 hover:bg-red-900/30 rounded-xl text-slate-500 hover:text-red-400 transition-all"
                        >
                            <Trash2 class="w-5 h-5" />
                        </button>
                    </div>

                    <div class="grid grid-cols-2 gap-4 mb-6">
                        <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800">
                            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Last Sync</span>
                            <span class="text-sm text-slate-300">{repo.last_sync_at ? new Date(repo.last_sync_at).toLocaleString() : 'Never'}</span>
                        </div>
                        <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800">
                            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Last Commit</span>
                            <span class="text-sm text-slate-300 font-mono">{repo.last_commit ? repo.last_commit.slice(0, 7) : 'N/A'}</span>
                        </div>
                        <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800 col-span-2">
                            <div class="flex items-center justify-between mb-1">
                                <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold">Sync Interval</span>
                                <span class="text-[10px] text-[#78FAAE] font-bold">{repo.sync_interval / 3600000}h</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <input 
                                    type="range" 
                                    min="1" 
                                    max="168" 
                                    step="1"
                                    value={repo.sync_interval / 3600000}
                                    onchange={(e) => handleUpdateInterval(repo.id, parseInt(e.currentTarget.value))}
                                    class="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-[#78FAAE]"
                                />
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center gap-3">
                        <button 
                            onclick={() => handleSyncRepo(repo.id)}
                            disabled={isSyncing === repo.id}
                            class="flex-1 flex items-center justify-center gap-2 py-3 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 rounded-2xl text-sm font-bold transition-all"
                        >
                            <RefreshCw class="w-4 h-4 {isSyncing === repo.id ? 'animate-spin' : ''}" />
                            {isSyncing === repo.id ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <a 
                            href={repo.url} 
                            target="_blank" 
                            class="p-3 bg-slate-800 hover:bg-slate-700 rounded-2xl text-slate-400 hover:text-white transition-all"
                        >
                            <ExternalLink class="w-5 h-5" />
                        </a>
                    </div>
                </div>
            {/each}
        {/if}
    </div>
</div>
