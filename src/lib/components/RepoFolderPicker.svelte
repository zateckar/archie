<script lang="ts" module>
    export type RepoTarget = { id: number; name: string; folders: string[] };
</script>

<script lang="ts">
    import FolderPlus from '@lucide/svelte/icons/folder-plus';

    /**
     * Repository + folder chooser with an inline "new folder" field. `folder` is
     * the final target (existing folder joined with the new folder name, if one
     * is being created); `incomplete` is true while the new-folder field is open
     * but empty, so the caller can hold its submit button.
     */
    let {
        repos,
        repoId = $bindable(null),
        folder = $bindable(''),
        incomplete = $bindable(false),
        disabled = false,
        idPrefix = 'picker',
        onchange
    }: {
        repos: RepoTarget[];
        repoId?: number | null;
        folder?: string;
        incomplete?: boolean;
        disabled?: boolean;
        idPrefix?: string;
        onchange?: () => void;
    } = $props();

    let baseFolder = $state('');
    let creatingFolder = $state(false);
    let newFolderName = $state('');
    let newFolderInputEl = $state<HTMLInputElement>();

    let repo = $derived(repos.find(r => r.id === repoId) ?? null);

    $effect(() => {
        const extra = creatingFolder ? newFolderName.trim().replace(/^[\\/]+|[\\/]+$/g, '') : '';
        folder = [baseFolder, extra].filter(Boolean).join('/');
        incomplete = creatingFolder && extra === '';
    });

    // Default to the first repository; drop a selection that no longer exists.
    $effect(() => {
        if (!repos.some(r => r.id === repoId)) repoId = repos[0]?.id ?? null;
    });

    function startNewFolder() {
        creatingFolder = true;
        onchange?.();
        queueMicrotask(() => newFolderInputEl?.focus());
    }

    function cancelNewFolder() {
        creatingFolder = false;
        newFolderName = '';
        onchange?.();
    }
</script>

<div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-repo" class="eyebrow">Repository</label>
    <select
        id="{idPrefix}-repo"
        class="field"
        bind:value={repoId}
        onchange={() => { baseFolder = ''; onchange?.(); }}
        {disabled}
    >
        {#each repos as r (r.id)}
            <option value={r.id}>{r.name}</option>
        {/each}
    </select>
</div>

<div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-folder" class="eyebrow">
        {creatingFolder ? 'Create new folder inside' : 'Folder'}
    </label>
    <select
        id="{idPrefix}-folder"
        class="field font-mono text-sm"
        bind:value={baseFolder}
        onchange={() => onchange?.()}
        {disabled}
    >
        <option value="">/ (repository root)</option>
        {#each repo?.folders ?? [] as f (f)}
            <option value={f}>/{f}</option>
        {/each}
    </select>

    {#if creatingFolder}
        <div class="flex items-center gap-2 mt-1">
            <input
                bind:this={newFolderInputEl}
                type="text"
                class="field font-mono text-sm"
                placeholder="New folder name"
                aria-label="New folder name"
                bind:value={newFolderName}
                oninput={() => onchange?.()}
                {disabled}
            />
            <button type="button" class="btn btn-ghost btn-sm" onclick={cancelNewFolder} {disabled}>Cancel</button>
        </div>
        <p class="text-xs text-[var(--text-faint)]">
            Use / for nested folders. The folder is created when the first document is committed.
        </p>
    {:else}
        <button type="button" class="btn btn-ghost btn-sm self-start" onclick={startNewFolder} {disabled}>
            <FolderPlus class="w-4 h-4" />
            <span>New folder</span>
        </button>
    {/if}
</div>
