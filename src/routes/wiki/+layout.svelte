<script lang="ts">
    import { setContext } from 'svelte';
    import { page } from '$app/state';
    import MessageSquare from '@lucide/svelte/icons/message-square';
import BookOpen from '@lucide/svelte/icons/book-open';
import Plus from '@lucide/svelte/icons/plus';
    import WikiTreeItem from '$lib/components/WikiTreeItem.svelte';

    let { children, data } = $props();
    let user = $derived(data?.user);
    let canEdit = $derived(user?.role === 'admin' || user?.role === 'contributor');

    interface FileTreeItem {
        name: string;
        path: string;
        type: 'file' | 'dir';
        children?: FileTreeItem[];
    }

    let fileTree = $state<FileTreeItem[]>([]);
    let selectedRepoId = $state<number | null>(null);
    let treeLoading = $state(false);
    let showNewPageForm = $state(false);
    let newPagePath = $state('');
    let newItemType = $state<'file' | 'folder'>('file');
    let expandedDirs = $state<Record<string, boolean>>({});
    let repos: any[] = $state([]);
    let dirsInitialized = $state(false);
    let lastRepoId = $state<number | null>(null);
    let lastFilePath = $state('');

    // ── Provide reactive context for all WikiTreeItem descendants ──────────────
    // Using getter functions ensures Svelte 5 tracks the $state variables through
    // context, so nested recursive WikiTreeItem components react to changes.
    setContext('wikiTree', {
        get expandedDirs() { return expandedDirs; },
        toggleDir,
        getFileUrl,
        isActiveFile,
    });

    // ── Reload tree whenever repository changes ──────────────────────────────
    $effect(() => {
        const pathname = page.url.pathname;
        const match = pathname.match(/^\/wiki\/(\d+)/);
        if (match) {
            const id = parseInt(match[1]);
            selectedRepoId = id;
            if (id !== lastRepoId) {
                lastRepoId = id;
                loadFileTree(id);
            }
        } else {
            selectedRepoId = null;
            lastRepoId = null;
            fileTree = [];
        }
    });

    // ── Listen for explicit tree-refresh events (fired after in-place saves) ───
    $effect(() => {
        const handler = () => {
            if (selectedRepoId) loadFileTree(selectedRepoId);
        };
        window.addEventListener('wiki:tree:refresh', handler);
        return () => window.removeEventListener('wiki:tree:refresh', handler);
    });

    // ── Load repos for the landing page ────────────────────────────────────────
    $effect(() => {
        if (!selectedRepoId && repos.length === 0) {
            loadRepos();
        }
    });

    async function loadRepos() {
        try {
            const res = await fetch('/api/wiki');
            if (res.ok) repos = await res.json();
        } catch {
            // Ignore — may be aborted during navigation
        }
    }

    async function loadFileTree(repoId: number) {
        treeLoading = true;
        dirsInitialized = false;
        try {
            const res = await fetch(`/api/wiki/${repoId}/tree`);
            if (res.ok) {
                fileTree = await res.json();
            }
        } catch {
            // Ignore — may be aborted during navigation
        } finally {
            treeLoading = false;
        }
    }

    function toggleDir(path: string) {
        expandedDirs[path] = !expandedDirs[path];
    }

    function getFileUrl(filePath: string): string {
        if (!selectedRepoId) return '#';
        const encoded = filePath.split('/').map(encodeURIComponent).join('/');
        return `/wiki/${selectedRepoId}/${encoded}`;
    }

    function isActiveFile(filePath: string): boolean {
        const currentPath = page.url.pathname;
        return currentPath.endsWith(encodeURIComponent(filePath)) || currentPath.endsWith(filePath);
    }

    function getRepoName(repo: any): string {
        const parts = repo.url.split('/');
        return parts[parts.length - 1] || repo.url;
    }

    async function handleCreateNewPage() {
        if (!newPagePath.trim() || !selectedRepoId) return;
        const rawPath = newPagePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');

        // For folders: create {folderPath}/README.md automatically.
        // For files:   ensure the path ends with .md.
        let filePath: string;
        let folderPath: string | null = null;

        if (newItemType === 'folder') {
            folderPath = rawPath;
            filePath = `${rawPath}/README.md`;
        } else {
            filePath = rawPath.endsWith('.md') ? rawPath : `${rawPath}.md`;
        }

        const title = filePath.replace(/\.md$/, '').split('/').pop() ?? 'Untitled';

        try {
            const res = await fetch(`/api/wiki/${selectedRepoId}/file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath, content: `# ${title}\n\n` })
            });
            if (res.ok) {
                newPagePath = '';
                showNewPageForm = false;
                await loadFileTree(selectedRepoId);
                // Auto-expand the new folder in the tree
                if (folderPath) {
                    // Expand every ancestor segment of the new folder
                    const parts = folderPath.split('/');
                    let current = '';
                    for (const part of parts) {
                        current = current ? `${current}/${part}` : part;
                        expandedDirs[current] = true;
                    }
                }
                window.location.href = getFileUrl(filePath);
            }
        } catch (err) {
            console.error(err);
        }
    }

    // ── Expand directories along the active file path ──────────────────────────
    $effect(() => {
        const match = page.url.pathname.match(/^\/wiki\/(\d+)\/(.+)/);
        if (match) {
            const filePath = decodeURIComponent(match[2]);
            // Reset flag when file path changes
            if (filePath !== lastFilePath) {
                lastFilePath = filePath;
                dirsInitialized = false;
            }
            if (!dirsInitialized) {
                const parts = filePath.split('/');
                let current = '';
                for (let i = 0; i < parts.length - 1; i++) {
                    if (current) current += '/';
                    current += parts[i];
                    expandedDirs[current] = true;
                }
                dirsInitialized = true;
            }
        }
    });
</script>

<div class="flex h-screen bg-page text-body font-sans overflow-hidden">
    <!-- Sidebar — w-80 gives a bit more breathing room than w-72 -->
    <aside class="w-80 bg-surface border-r border-line flex flex-col flex-shrink-0">
        <!-- Header -->
        <div class="h-14 px-4 border-b border-line-subtle flex items-center justify-between">
            <div class="flex items-center gap-2">
                <BookOpen class="w-4 h-4 text-accent" />
                <h1 class="text-sm font-semibold text-body">Wiki</h1>
            </div>
            <a href="/" class="btn btn-ghost btn-sm" title="Back to chat">
                <MessageSquare class="w-4 h-4" />
                Chat
            </a>
        </div>

        <!-- Repo selector (when no repo is selected) -->
        {#if !selectedRepoId}
            <div class="flex-1 overflow-y-auto p-2">
                <p class="eyebrow px-3 py-2">Repositories</p>
                <div class="space-y-0.5">
                    {#each repos as repo}
                        <a href={`/wiki/${repo.id}`} class="nav-item">
                            <BookOpen class="w-4 h-4 text-faint flex-shrink-0" />
                            <div class="overflow-hidden">
                                <p class="truncate">{getRepoName(repo)}</p>
                                <p class="text-xs text-faint truncate font-mono">{repo.url}</p>
                            </div>
                        </a>
                    {/each}
                    {#if repos.length === 0}
                        <p class="text-[13px] text-mute px-3 py-4">No repositories yet. Add one in the admin panel.</p>
                    {/if}
                </div>
            </div>
        {:else}
            <!-- Tree sidebar -->
            <div class="flex-1 overflow-y-auto p-2">
                <div class="flex items-center justify-between px-3 py-2">
                    <p class="eyebrow">Documents</p>
                    {#if canEdit}
                        <button
                            onclick={() => showNewPageForm = !showNewPageForm}
                            class="btn btn-ghost btn-icon"
                            title="New page"
                            aria-label="New page"
                        >
                            <Plus class="w-4 h-4" />
                        </button>
                    {/if}
                </div>

                {#if canEdit && showNewPageForm}
                    <div class="mb-3 px-2">
                        <form onsubmit={(e) => { e.preventDefault(); handleCreateNewPage(); }} class="flex flex-col gap-2">
                            <!-- File / Folder toggle -->
                            <div class="tabs w-full">
                                <button
                                    type="button"
                                    onclick={() => { newItemType = 'file'; newPagePath = ''; }}
                                    class="tab flex-1 {newItemType === 'file' ? 'tab-active' : ''}"
                                >
                                    File
                                </button>
                                <button
                                    type="button"
                                    onclick={() => { newItemType = 'folder'; newPagePath = ''; }}
                                    class="tab flex-1 {newItemType === 'folder' ? 'tab-active' : ''}"
                                >
                                    Folder
                                </button>
                            </div>

                            <input
                                type="text"
                                bind:value={newPagePath}
                                placeholder={newItemType === 'folder' ? 'folder-name or path/to/folder' : 'page.md or path/to/page.md'}
                                class="field text-xs"
                            />

                            {#if newItemType === 'folder'}
                                <p class="text-xs text-faint px-1">A <span class="text-mute font-mono">README.md</span> is created inside automatically.</p>
                            {/if}

                            <div class="flex gap-2">
                                <button type="submit" class="btn btn-primary btn-sm">
                                    Create {newItemType === 'folder' ? 'folder' : 'file'}
                                </button>
                                <button type="button" onclick={() => { showNewPageForm = false; newPagePath = ''; newItemType = 'file'; }} class="btn btn-ghost btn-sm">Cancel</button>
                            </div>
                        </form>
                    </div>
                {/if}

                {#if treeLoading}
                    <div class="flex items-center justify-center py-8">
                        <div class="spinner w-5 h-5"></div>
                    </div>
                {:else if fileTree.length === 0}
                    <p class="text-xs text-mute px-3 py-4">No markdown files in this repository.</p>
                {:else}
                    <div class="space-y-0.5">
                        {#each fileTree as item (item.path)}
                            <WikiTreeItem {item} level={0} />
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}
    </aside>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto bg-page">
        {@render children()}
    </main>
</div>
