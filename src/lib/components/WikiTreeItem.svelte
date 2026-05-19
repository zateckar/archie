<script lang="ts">
    import { getContext } from 'svelte';
    import { FileText, Folder, FolderOpen, ChevronDown, ChevronRight } from 'lucide-svelte';
    import TreeItem from './WikiTreeItem.svelte';

    interface FileTreeItem {
        name: string;
        path: string;
        type: 'file' | 'dir';
        children?: FileTreeItem[];
    }

    interface WikiTreeContext {
        readonly expandedDirs: Set<string>;
        toggleDir: (path: string) => void;
        getFileUrl: (path: string) => string;
        isActiveFile: (path: string) => boolean;
    }

    // Only item and level are instance-specific; everything else comes from context.
    let { item, level }: { item: FileTreeItem; level: number } = $props();

    // Context is provided by +layout.svelte with a reactive getter for expandedDirs.
    // $derived below reads ctx.expandedDirs so Svelte tracks the $state variable
    // through the getter and re-evaluates whenever the layout's expandedDirs changes.
    const ctx = getContext<WikiTreeContext>('wikiTree');

    let isExpanded = $derived(ctx.expandedDirs.has(item.path));
    let isActive   = $derived(item.type === 'file' && ctx.isActiveFile(item.path));
</script>

{#if item.type === 'dir'}
    <div>
        <button
            onclick={() => ctx.toggleDir(item.path)}
            class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/40 transition-all text-sm group"
            style="padding-left: {12 + level * 16}px"
        >
            <span class="w-4 flex-shrink-0">
                {#if isExpanded}
                    <ChevronDown class="w-3.5 h-3.5 text-slate-500" />
                {:else}
                    <ChevronRight class="w-3.5 h-3.5 text-slate-500" />
                {/if}
            </span>
            <span class="w-4 flex-shrink-0">
                {#if isExpanded}
                    <FolderOpen class="w-4 h-4 text-[#78FAAE]" />
                {:else}
                    <Folder class="w-4 h-4 text-slate-500" />
                {/if}
            </span>
            <span class="text-slate-400 truncate">{item.name}</span>
        </button>

        {#if isExpanded && item.children && item.children.length > 0}
            <div>
                {#each item.children as child (child.path)}
                    <TreeItem item={child} level={level + 1} />
                {/each}
            </div>
        {/if}
    </div>
{:else}
    <a
        href={ctx.getFileUrl(item.path)}
        style="padding-left: {28 + level * 16}px"
        class="flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all text-sm group {isActive
            ? 'bg-[#0E3A2F]/30 text-[#78FAAE]'
            : 'text-slate-400 hover:bg-slate-800/40'}"
    >
        <FileText class="w-4 h-4 flex-shrink-0 {isActive ? 'text-[#78FAAE]' : 'text-slate-600'}" />
        <span class="truncate">{item.name}</span>
    </a>
{/if}
