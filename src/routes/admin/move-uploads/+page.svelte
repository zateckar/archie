<script lang="ts">
    import { onMount } from 'svelte';
    import Loader2 from '@lucide/svelte/icons/loader-2';
    import GitBranch from '@lucide/svelte/icons/git-branch';
    import CheckCircle from '@lucide/svelte/icons/check-circle';
    import AlertCircle from '@lucide/svelte/icons/alert-circle';
    import RepoFolderPicker, { type RepoTarget } from '$lib/components/RepoFolderPicker.svelte';

    type Move = {
        id: number;
        filename: string;
        status: 'ready' | 'conflict' | 'invalid';
        path: string | null;
        renamed: boolean;
        reason?: string;
        created_at: string;
        size: number;
    };
    type Outcome = { filename: string; status: 'moved' | 'skipped' | 'failed'; path?: string; reason?: string };

    let repos = $state<RepoTarget[]>([]);
    let repoId = $state<number | null>(null);
    let folder = $state('');
    let folderIncomplete = $state(false);

    let loading = $state(true);
    let planLoading = $state(false);
    let pageError = $state<string | null>(null);
    let planError = $state<string | null>(null);
    let moves = $state<Move[]>([]);
    // Tracks what the admin UNticked, so a plan reload (folder change) keeps
    // their choice while newly-ready documents start ticked.
    let deselected = $state(new Set<number>());

    let running = $state(false);
    let stopRequested = $state(false);
    let progress = $state({ done: 0, total: 0, current: '' });
    let outcomes = $state<Outcome[]>([]);

    let ready = $derived(moves.filter(m => m.status === 'ready'));
    let selected = $derived(ready.filter(m => !deselected.has(m.id)));
    let blocked = $derived(moves.length - ready.length);
    let allSelected = $derived(ready.length > 0 && selected.length === ready.length);
    let repoName = $derived(repos.find(r => r.id === repoId)?.name ?? '');

    onMount(loadTargets);

    async function loadTargets() {
        try {
            const res = await fetch('/api/documents/targets');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            repos = (await res.json()).repos;
        } catch (err) {
            pageError = `Could not load repositories: ${(err as Error).message}`;
        } finally {
            loading = false;
        }
    }

    // Re-plan whenever the destination changes; debounced so typing a new
    // folder name doesn't fire a request per keystroke.
    let planTimer: ReturnType<typeof setTimeout> | null = null;
    $effect(() => {
        const r = repoId;
        const f = folder;
        if (r === null || folderIncomplete) return;
        if (planTimer) clearTimeout(planTimer);
        planTimer = setTimeout(() => loadPlan(r, f), 250);
        return () => { if (planTimer) clearTimeout(planTimer); };
    });

    async function loadPlan(r: number, f: string) {
        planLoading = true;
        try {
            const res = await fetch(`/api/documents/migrate?repoId=${r}&folder=${encodeURIComponent(f)}`);
            const data = await res.json();
            if (!res.ok) {
                planError = data.error || `HTTP ${res.status}`;
                moves = [];
            } else {
                planError = null;
                moves = data.moves;
            }
        } catch (err) {
            planError = (err as Error).message;
        } finally {
            planLoading = false;
        }
    }

    function toggle(id: number) {
        const next = new Set(deselected);
        if (next.has(id)) next.delete(id); else next.add(id);
        deselected = next;
    }

    function toggleAll() {
        deselected = allSelected ? new Set(ready.map(m => m.id)) : new Set();
    }

    async function run() {
        if (repoId === null || selected.length === 0) return;
        const target = `${repoName}/${folder ? folder + '/' : ''}`;
        if (!confirm(`Move ${selected.length} document(s) into ${target}?\n\nEach document is committed and pushed separately. This cannot be undone from the app.`)) return;

        const batch = [...selected];
        const r = repoId;
        const f = folder;
        running = true;
        stopRequested = false;
        outcomes = [];
        progress = { done: 0, total: batch.length, current: '' };

        for (const m of batch) {
            if (stopRequested) break;
            progress.current = m.filename;
            try {
                const res = await fetch('/api/documents/migrate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ docId: m.id, repoId: r, folder: f })
                });
                const data = await res.json().catch(() => ({ status: 'failed', reason: `HTTP ${res.status}` }));
                outcomes.push({ filename: m.filename, status: data.status ?? 'failed', path: data.path, reason: data.reason ?? data.error });
            } catch (err) {
                outcomes.push({ filename: m.filename, status: 'failed', reason: (err as Error).message });
            }
            progress.done++;
        }

        running = false;
        progress.current = '';
        // New folders now exist, and moved documents drop out of the plan.
        await loadTargets();
        await loadPlan(r, f);
    }

    function formatSize(n: number) {
        return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
    }

    let moved = $derived(outcomes.filter(o => o.status === 'moved').length);
    let notMoved = $derived(outcomes.filter(o => o.status !== 'moved'));
</script>

<div class="p-6 max-w-5xl">
    <header class="mb-8">
        <h1 class="page-title">Move uploads to Git</h1>
        <p class="page-subtitle mt-1">
            Documents uploaded before uploads went to Git are stored only in the app's database. Move them into a
            repository so they get version history and a wiki page.
        </p>
    </header>

    {#if loading}
        <div class="p-12 flex justify-center"><Loader2 class="w-8 h-8 animate-spin text-[var(--text-faint)]" /></div>
    {:else if pageError}
        <p class="text-sm text-danger">{pageError}</p>
    {:else if repos.length === 0}
        <p class="text-sm text-[var(--text-muted)]">
            No repositories are connected. <a href="/admin/repos" class="text-accent underline">Add a repository</a> first.
        </p>
    {:else}
        <div class="card p-6 mb-6 grid gap-5 md:grid-cols-2">
            <RepoFolderPicker
                {repos}
                bind:repoId
                bind:folder
                bind:incomplete={folderIncomplete}
                disabled={running}
                idPrefix="move"
            />
            <div class="md:col-span-2 text-xs text-[var(--text-faint)] flex flex-col gap-1">
                <p>
                    The app never kept the original files, so what is committed is the cleaned text the app indexed.
                    <code>.txt</code> files are renamed to <code>.md</code>, because Git sync ignores <code>.txt</code>.
                </p>
                <p>
                    Search results, facts and links stay as they are: nothing is re-indexed, and each document just
                    points at its new Git path.
                </p>
            </div>
        </div>

        {#if outcomes.length > 0 && !running}
            <div class="card p-4 mb-6 text-sm flex flex-col gap-2" role="status">
                <p class="flex items-center gap-2 text-[var(--text-secondary)]">
                    <CheckCircle class="w-4 h-4 text-accent" />
                    Moved {moved} of {outcomes.length} document(s).
                </p>
                {#each notMoved as o}
                    <p class="flex items-start gap-2 text-danger">
                        <AlertCircle class="w-4 h-4 mt-0.5 shrink-0" />
                        <span><span class="font-medium">{o.filename}</span> — {o.status}: {o.reason}</span>
                    </p>
                {/each}
            </div>
        {/if}

        <div class="card overflow-hidden">
            <div class="p-4 border-b border-[var(--border-primary)] flex flex-wrap items-center justify-between gap-4">
                <p class="text-sm text-[var(--text-muted)]">
                    {#if planLoading}
                        <Loader2 class="w-4 h-4 animate-spin inline" /> Checking destination…
                    {:else}
                        {moves.length} app-only document(s){#if blocked > 0}, {blocked} can't go to this folder{/if}.
                    {/if}
                </p>
                <div class="flex items-center gap-2">
                    {#if running}
                        <span class="text-sm text-[var(--text-muted)]">
                            Moving {progress.done + 1} of {progress.total}: <span class="font-mono">{progress.current}</span>
                        </span>
                        <button type="button" class="btn btn-secondary btn-sm" onclick={() => (stopRequested = true)} disabled={stopRequested}>
                            {stopRequested ? 'Stopping…' : 'Stop'}
                        </button>
                    {:else}
                        <button
                            type="button"
                            class="btn btn-primary"
                            onclick={run}
                            disabled={selected.length === 0 || planLoading || folderIncomplete || !!planError}
                        >
                            <GitBranch class="w-4 h-4" />
                            <span>Move {selected.length} document(s)</span>
                        </button>
                    {/if}
                </div>
            </div>

            {#if planError}
                <p class="p-6 text-sm text-danger">{planError}</p>
            {:else if moves.length === 0 && !planLoading}
                <p class="p-12 text-center text-[var(--text-faint)] italic">
                    Nothing to move — every document is already in a repository.
                </p>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-[var(--bg-muted-30)]">
                                <th class="px-4 py-3 w-10">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all"
                                        checked={allSelected}
                                        onchange={toggleAll}
                                        disabled={running || ready.length === 0}
                                    />
                                </th>
                                <th class="eyebrow px-4 py-3">Document</th>
                                <th class="eyebrow px-4 py-3">Will be committed as</th>
                                <th class="eyebrow px-4 py-3">Added</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-[var(--border-primary)]">
                            {#each moves as m (m.id)}
                                <tr class:opacity-60={m.status !== 'ready'}>
                                    <td class="px-4 py-3">
                                        <input
                                            type="checkbox"
                                            aria-label="Move {m.filename}"
                                            checked={m.status === 'ready' && !deselected.has(m.id)}
                                            onchange={() => toggle(m.id)}
                                            disabled={running || m.status !== 'ready'}
                                        />
                                    </td>
                                    <td class="px-4 py-3">
                                        <span class="font-medium text-[var(--text-secondary)]">{m.filename}</span>
                                        <span class="block text-xs text-[var(--text-faint)]">{formatSize(m.size)}</span>
                                    </td>
                                    <td class="px-4 py-3">
                                        {#if m.path}
                                            <span class="text-xs font-mono text-[var(--text-secondary)] break-all">{repoName}/{m.path}</span>
                                        {/if}
                                        {#if m.status === 'ready' && m.renamed}
                                            <span class="block text-xs text-[var(--text-faint)]">renamed for Git</span>
                                        {/if}
                                        {#if m.status !== 'ready'}
                                            <span class="block text-xs text-danger">{m.reason}</span>
                                        {/if}
                                    </td>
                                    <td class="px-4 py-3 text-sm text-[var(--text-faint)]">
                                        {new Date(m.created_at).toLocaleDateString()}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </div>
    {/if}
</div>
