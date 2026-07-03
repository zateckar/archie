<script lang="ts">
    import { setContext } from 'svelte';
    import { page } from '$app/state';
    import MessageSquare from 'lucide-svelte/icons/message-square';
import BookOpen from 'lucide-svelte/icons/book-open';
import Plus from 'lucide-svelte/icons/plus';
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

<div class="flex h-screen bg-[var(--bg-page)] text-slate-100 font-sans overflow-hidden">
    <!-- Sidebar — w-80 gives a bit more breathing room than w-72 -->
    <aside class="w-80 bg-[var(--bg-slate-950)]/80 border-r border-[var(--border-primary)] flex flex-col flex-shrink-0">
        <!-- Header -->
        <div class="p-4 border-b border-[var(--border-primary)] flex items-center justify-between">
            <div class="flex items-center gap-2">
                <BookOpen class="w-5 h-5 text-[#78FAAE]" />
                <h1 class="font-bold text-[var(--text-primary)] text-sm uppercase tracking-widest">Wiki</h1>
            </div>
            <a href="/" class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--bg-slate-900)] border border-[var(--border-primary)] hover:border-[#78FAAE]/50 transition-all group" title="Back to Chat">
                <MessageSquare class="w-4 h-4 text-[#78FAAE] group-hover:scale-110 transition-transform" />
                <span class="text-[10px] font-bold text-[var(--text-muted)] group-hover:text-[var(--text-primary)] uppercase tracking-widest">Chat</span>
            </a>
        </div>

        <!-- Repo selector (when no repo is selected) -->
        {#if !selectedRepoId}
            <div class="flex-1 overflow-y-auto p-3">
                <p class="text-xs text-[var(--text-faint)] uppercase tracking-wider font-bold px-2 mb-3">Repositories</p>
                <div class="space-y-1">
                    {#each repos as repo}
                        <a 
                            href={`/wiki/${repo.id}`}
                            class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[var(--hover-surface)] transition-all text-sm group"
                        >
                            <div class="w-8 h-8 rounded-lg bg-[#0E3A2F]/30 flex items-center justify-center text-[#78FAAE] flex-shrink-0">
                                <BookOpen class="w-4 h-4" />
                            </div>
                            <div class="overflow-hidden">
                                <p class="font-medium text-[var(--text-secondary)] truncate">{getRepoName(repo)}</p>
                                <p class="text-[10px] text-[var(--text-faint)] truncate font-mono">{repo.url}</p>
                            </div>
                        </a>
                    {/each}
                    {#if repos.length === 0}
                        <p class="text-[var(--text-faintest)] text-sm italic px-3 py-4">No connected repos yet. Add one in the admin panel.</p>
                    {/if}
                </div>
            </div>
        {:else}
            <!-- Tree sidebar -->
            <div class="flex-1 overflow-y-auto p-3">
                <div class="flex items-center justify-between mb-3 px-2">
                    <p class="text-xs text-[var(--text-faint)] uppercase tracking-wider font-bold">Documents</p>
                    {#if canEdit}
                        <button 
                            onclick={() => showNewPageForm = !showNewPageForm}
                            class="p-1 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-muted)] hover:text-[#78FAAE] transition-all"
                            title="New Page"
                        >
                            <Plus class="w-4 h-4" />
                        </button>
                    {/if}
                </div>

                {#if canEdit && showNewPageForm}
                    <div class="mb-3 px-2">
                        <form onsubmit={(e) => { e.preventDefault(); handleCreateNewPage(); }} class="flex flex-col gap-2">
                            <!-- File / Folder toggle -->
                            <div class="flex rounded-lg overflow-hidden border border-[var(--border-hover)] text-xs">
                                <button
                                    type="button"
                                    onclick={() => { newItemType = 'file'; newPagePath = ''; }}
                                    class="flex-1 py-1.5 font-semibold transition-all {newItemType === 'file'
                                        ? 'bg-[#0E3A2F] text-[#78FAAE]'
                                        : 'bg-[var(--bg-slate-900)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
                                >
                                    File
                                </button>
                                <button
                                    type="button"
                                    onclick={() => { newItemType = 'folder'; newPagePath = ''; }}
                                    class="flex-1 py-1.5 font-semibold transition-all {newItemType === 'folder'
                                        ? 'bg-[#0E3A2F] text-[#78FAAE]'
                                        : 'bg-[var(--bg-slate-900)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
                                >
                                    Folder
                                </button>
                            </div>

                            <input
                                type="text"
                                bind:value={newPagePath}
                                placeholder={newItemType === 'folder' ? 'folder-name or path/to/folder' : 'page.md or path/to/page.md'}
                                class="w-full bg-[var(--bg-slate-900)] border border-[var(--border-hover)] rounded-xl px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faintest)] focus:outline-none focus:border-[#78FAAE]/50"
                            />

                            {#if newItemType === 'folder'}
                                <p class="text-[10px] text-[var(--text-faint)] px-1">A <span class="text-[var(--text-muted)] font-mono">README.md</span> will be created inside automatically.</p>
                            {/if}

                            <div class="flex gap-2">
                                <button type="submit" class="px-3 py-1.5 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] rounded-lg text-xs font-bold transition-all">
                                    Create {newItemType === 'folder' ? 'Folder' : 'File'}
                                </button>
                                <button type="button" onclick={() => { showNewPageForm = false; newPagePath = ''; newItemType = 'file'; }} class="px-3 py-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-xs transition-all">Cancel</button>
                            </div>
                        </form>
                    </div>
                {/if}

                {#if treeLoading}
                    <div class="flex items-center justify-center py-8">
                        <div class="w-5 h-5 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
                    </div>
                {:else if fileTree.length === 0}
                    <p class="text-[var(--text-faintest)] text-xs italic px-3 py-4">No markdown files found in this repo.</p>
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
    <main class="flex-1 overflow-y-auto bg-[var(--bg-page)]">
        {@render children()}
    </main>
</div>
