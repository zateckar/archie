<script lang="ts">
    import X from '@lucide/svelte/icons/x';
    import Upload from '@lucide/svelte/icons/upload';
    import Loader2 from '@lucide/svelte/icons/loader-2';
    import GitBranch from '@lucide/svelte/icons/git-branch';
    import AlertCircle from '@lucide/svelte/icons/alert-circle';
    import { fade, scale } from 'svelte/transition';
    import RepoFolderPicker, { type RepoTarget } from './RepoFolderPicker.svelte';

    let {
        open,
        onClose,
        onUploaded
    }: {
        open: boolean;
        onClose: () => void;
        onUploaded: (path: string, warning?: string) => void;
    } = $props();

    let repos = $state<RepoTarget[]>([]);
    let extensions = $state<string[]>(['.md', '.mdx']);
    let loadingTargets = $state(false);

    let file = $state<File | null>(null);
    let repoId = $state<number | null>(null);
    // Final target folder, maintained by RepoFolderPicker (includes a new folder being created).
    let targetFolder = $state('');
    let folderIncomplete = $state(false);

    let uploading = $state(false);
    let error = $state<string | null>(null);
    let conflictPath = $state<string | null>(null);

    let modalEl = $state<HTMLDivElement>();
    let fileInputEl = $state<HTMLInputElement>();
    let previousFocus: HTMLElement | null = null;

    let repo = $derived(repos.find(r => r.id === repoId) ?? null);
    let destination = $derived(file ? (targetFolder ? `${targetFolder}/${file.name}` : file.name) : null);
    let canUpload = $derived(!!file && repoId !== null && !uploading && !folderIncomplete);

    // Reset and (re)load targets each time the dialog opens, so folders created
    // by a previous upload or a sync show up. The picker remounts with the
    // dialog, which resets its own folder state.
    $effect(() => {
        if (open) {
            file = null;
            error = null;
            conflictPath = null;
            loadTargets();
        }
    });

    $effect(() => {
        if (open) {
            previousFocus = document.activeElement as HTMLElement;
            queueMicrotask(() => fileInputEl?.focus());
            document.addEventListener('keydown', handleKeyDown);
        } else {
            document.removeEventListener('keydown', handleKeyDown);
            previousFocus?.focus?.();
        }
        return () => document.removeEventListener('keydown', handleKeyDown);
    });

    async function loadTargets() {
        loadingTargets = true;
        try {
            const res = await fetch('/api/documents/targets');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            repos = data.repos;
            extensions = data.extensions;
        } catch (err) {
            error = `Could not load repositories: ${(err as Error).message}`;
        } finally {
            loadingTargets = false;
        }
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape' && !uploading) {
            e.preventDefault();
            onClose();
            return;
        }
        if (e.key === 'Tab' && modalEl) {
            const focusables = modalEl.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
            );
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget && !uploading) onClose();
    }

    function handleFileChange(e: Event) {
        file = (e.target as HTMLInputElement).files?.[0] ?? null;
        error = null;
        conflictPath = null;
        if (file) {
            const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
            if (!extensions.includes(ext)) {
                error = `Only ${extensions.join(', ')} files can be uploaded.`;
                file = null;
                (e.target as HTMLInputElement).value = '';
            }
        }
    }

    async function upload(overwrite = false) {
        if (!file || repoId === null) return;
        uploading = true;
        error = null;
        try {
            const content = await file.text();
            const res = await fetch('/api/documents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, content, repoId, folder: targetFolder, overwrite })
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 409 && data.exists) {
                conflictPath = data.path;
                return;
            }
            if (!res.ok) {
                error = data.error || `Upload failed (HTTP ${res.status})`;
                return;
            }
            onUploaded(data.path, data.warning);
        } catch (err) {
            error = `Upload failed: ${(err as Error).message}`;
        } finally {
            uploading = false;
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-sm flex items-center justify-center p-6"
        onclick={handleBackdropClick}
        transition:fade={{ duration: 150 }}
    >
        <div
            bind:this={modalEl}
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-dialog-title"
            class="card shadow-xl w-full max-w-lg flex flex-col overflow-hidden"
            transition:scale={{ duration: 200, start: 0.95 }}
        >
            <header class="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
                <div class="flex items-center gap-3">
                    <Upload class="w-5 h-5 text-accent" />
                    <h2 id="upload-dialog-title" class="text-sm font-semibold text-body">Upload document to Git</h2>
                </div>
                <button
                    type="button"
                    onclick={onClose}
                    disabled={uploading}
                    class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                    aria-label="Close"
                >
                    <X class="w-4 h-4" />
                </button>
            </header>

            <div class="p-5 flex flex-col gap-5">
                {#if loadingTargets && repos.length === 0}
                    <div class="py-8 flex justify-center">
                        <Loader2 class="w-6 h-6 animate-spin text-[var(--text-faint)]" />
                    </div>
                {:else if repos.length === 0}
                    <p class="text-sm text-[var(--text-muted)]">
                        No repositories are connected yet. Documents are stored in a Git repository, so
                        <a href="/admin/repos" class="text-accent underline">add a repository</a> first.
                    </p>
                {:else}
                    <div class="flex flex-col gap-1.5">
                        <label for="upload-file" class="eyebrow">File</label>
                        <input
                            bind:this={fileInputEl}
                            id="upload-file"
                            type="file"
                            accept={extensions.join(',')}
                            onchange={handleFileChange}
                            disabled={uploading}
                            class="field"
                        />
                        <p class="text-xs text-[var(--text-faint)]">Accepted: {extensions.join(', ')}</p>
                    </div>

                    <RepoFolderPicker
                        {repos}
                        bind:repoId
                        bind:folder={targetFolder}
                        bind:incomplete={folderIncomplete}
                        disabled={uploading}
                        idPrefix="upload"
                        onchange={() => (conflictPath = null)}
                    />

                    <div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-well)] px-3 py-2.5 flex items-start gap-2">
                        <GitBranch class="w-4 h-4 mt-0.5 text-[var(--text-faint)] shrink-0" />
                        <p class="text-xs font-mono text-[var(--text-secondary)] break-all">
                            {repo?.name ?? ''}/{destination ?? (targetFolder ? `${targetFolder}/…` : '…')}
                        </p>
                    </div>

                    {#if conflictPath}
                        <div class="rounded-xl border border-[var(--danger)] px-3 py-2.5 text-sm flex flex-col gap-2" role="alert">
                            <p class="text-[var(--text-secondary)]">
                                <span class="font-mono">{conflictPath}</span> already exists in this repository. Replace it?
                                The previous version stays in the Git history.
                            </p>
                            <div class="flex gap-2">
                                <button type="button" class="btn btn-danger btn-sm" onclick={() => upload(true)} disabled={uploading}>
                                    Replace file
                                </button>
                                <button type="button" class="btn btn-ghost btn-sm" onclick={() => (conflictPath = null)} disabled={uploading}>
                                    Keep existing
                                </button>
                            </div>
                        </div>
                    {/if}
                {/if}

                {#if error}
                    <div class="flex items-start gap-2 text-sm text-danger" role="alert">
                        <AlertCircle class="w-4 h-4 mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                {/if}
            </div>

            <footer class="flex justify-end gap-2 px-5 py-4 border-t border-line-subtle">
                <button type="button" class="btn btn-secondary" onclick={onClose} disabled={uploading}>Cancel</button>
                <button
                    type="button"
                    class="btn btn-primary"
                    onclick={() => upload(false)}
                    disabled={!canUpload || !!conflictPath || repos.length === 0}
                >
                    {#if uploading}
                        <Loader2 class="w-4 h-4 animate-spin" />
                        <span>Committing…</span>
                    {:else}
                        <Upload class="w-4 h-4" />
                        <span>Upload to Git</span>
                    {/if}
                </button>
            </footer>
        </div>
    </div>
{/if}
