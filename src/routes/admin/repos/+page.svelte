<script lang="ts">
    import { onMount } from 'svelte';
    import GitBranch from '@lucide/svelte/icons/git-branch';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Plus from '@lucide/svelte/icons/plus';
import Loader2 from '@lucide/svelte/icons/loader-2';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Key from '@lucide/svelte/icons/key';
import Clock from '@lucide/svelte/icons/clock';

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

<div class="p-6">
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
            <h1 class="page-title">Git Repositories</h1>
            <p class="page-subtitle mt-1">Connect and sync source code repositories.</p>
        </div>
        
        <button 
            onclick={() => showAddForm = !showAddForm}
            class="btn btn-primary"
        >
            <Plus class="w-4 h-4" />
            <span>Add Repository</span>
        </button>
    </header>

    {#if showAddForm}
        <div class="card p-5 mb-4">
            <h2 class="text-sm font-semibold text-body mb-4 flex items-center gap-2">
                <GitBranch class="w-4 h-4 text-faint" />
                Connect New Repository
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label for="repo-url" class="block text-[13px] font-medium text-dim mb-1.5">Repository URL</label>
                    <input 
                        id="repo-url"
                        type="text" 
                        bind:value={newRepoUrl} 
                        placeholder="https://github.com/user/repo" 
                        class="field"
                    />
                </div>
                <div>
                    <label for="repo-pat" class="block text-[13px] font-medium text-dim mb-1.5">Personal Access Token (Optional)</label>
                    <div class="relative">
                        <Key class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
                        <input 
                            id="repo-pat"
                            type="password" 
                            bind:value={newRepoPat} 
                            placeholder="ghp_xxxxxxxxxxxx" 
                            class="field pl-10"
                        />
                    </div>
                </div>
                <div>
                    <label for="repo-sync-interval" class="block text-[13px] font-medium text-dim mb-1.5">Sync Interval (Hours)</label>
                    <div class="relative">
                        <Clock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
                        <input 
                            id="repo-sync-interval"
                            type="number" 
                            min="1"
                            bind:value={newRepoSyncInterval} 
                            placeholder="1" 
                            class="field pl-10"
                        />
                    </div>
                </div>
            </div>
            <div class="mt-5 flex justify-end gap-2">
                <button onclick={() => showAddForm = false} class="btn btn-ghost">Cancel</button>
                <button 
                    onclick={handleAddRepo} 
                    disabled={isAddingRepo || !newRepoUrl}
                    class="btn btn-primary"
                >
                    {#if isAddingRepo}
                        <Loader2 class="w-4 h-4 animate-spin" />
                    {/if}
                    Connect Repo
                </button>
            </div>
        </div>
    {/if}

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {#if loading}
            <div class="col-span-full p-12 text-center">
                <Loader2 class="w-8 h-8 animate-spin mx-auto text-[var(--text-faint)]" />
            </div>
        {:else if gitRepos.length === 0}
            <div class="col-span-full card p-10 text-center text-[13px] text-mute">
                No repositories connected yet.
            </div>
        {:else}
            {#each gitRepos as repo}
                <div class="card card-hover p-5 group">
                    <div class="flex items-start justify-between gap-2 mb-4">
                        <div class="flex items-start gap-2.5 overflow-hidden">
                            <GitBranch class="w-4 h-4 text-faint flex-shrink-0 mt-0.5" />
                            <div class="overflow-hidden">
                                <h3 class="text-sm font-medium text-body truncate">{repo.url.split('/').pop()}</h3>
                                <p class="text-xs text-[var(--text-faint)] font-mono truncate">{repo.url}</p>
                            </div>
                        </div>
                        <button 
                            onclick={() => handleDeleteRepo(repo.id)}
                            class="btn btn-ghost btn-icon hover:text-danger"
                        >
                            <Trash2 class="w-4 h-4" />
                        </button>
                    </div>

                    <div class="grid grid-cols-2 gap-2 mb-4">
                        <div class="well p-3">
                            <span class="eyebrow block mb-1">Last Sync</span>
                            <span class="text-sm text-[var(--text-secondary)]">{repo.last_sync_at ? new Date(repo.last_sync_at).toLocaleString() : 'Never'}</span>
                        </div>
                        <div class="well p-3">
                            <span class="eyebrow block mb-1">Last Commit</span>
                            <span class="text-sm text-[var(--text-secondary)] font-mono">{repo.last_commit ? repo.last_commit.slice(0, 7) : 'N/A'}</span>
                        </div>
                        <div class="well p-3 col-span-2">
                            <div class="flex items-center justify-between mb-1">
                                <span class="eyebrow block">Sync Interval</span>
                                <span class="text-xs text-mute tabular-nums">{repo.sync_interval / 3600000}h</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <input 
                                    type="range" 
                                    min="1" 
                                    max="168" 
                                    step="1"
                                    value={repo.sync_interval / 3600000}
                                    onchange={(e) => handleUpdateInterval(repo.id, parseInt(e.currentTarget.value))}
                                    class="flex-1 cursor-pointer accent-[var(--accent-quiet)]"
                                />
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center gap-3">
                        <button 
                            onclick={() => handleSyncRepo(repo.id)}
                            disabled={isSyncing === repo.id}
                            class="btn btn-secondary flex-1"
                        >
                            <RefreshCw class="w-4 h-4 {isSyncing === repo.id ? 'animate-spin' : ''}" />
                            {isSyncing === repo.id ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <a 
                            href={repo.url} 
                            target="_blank" 
                            class="btn btn-secondary btn-icon"
                        >
                            <ExternalLink class="w-4 h-4" />
                        </a>
                    </div>
                </div>
            {/each}
        {/if}
    </div>
</div>
