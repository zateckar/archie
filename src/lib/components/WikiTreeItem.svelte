<script lang="ts">
    import { getContext } from 'svelte';
    import FileText from '@lucide/svelte/icons/file-text';
import Folder from '@lucide/svelte/icons/folder';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
    import TreeItem from './WikiTreeItem.svelte';

    interface FileTreeItem {
        name: string;
        path: string;
        type: 'file' | 'dir';
        children?: FileTreeItem[];
    }

    interface WikiTreeContext {
        readonly expandedDirs: Record<string, boolean>;
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

    let isExpanded = $derived(!!ctx.expandedDirs[item.path]);
    let isActive   = $derived(item.type === 'file' && ctx.isActiveFile(item.path));
</script>

{#if item.type === 'dir'}
    <div>
        <button
            onclick={() => ctx.toggleDir(item.path)}
            class="nav-item w-full py-1.5"
            style="padding-left: {8 + level * 14}px"
        >
            <span class="w-3.5 flex-shrink-0">
                {#if isExpanded}
                    <ChevronDown class="w-3.5 h-3.5 text-faint" />
                {:else}
                    <ChevronRight class="w-3.5 h-3.5 text-faint" />
                {/if}
            </span>
            {#if isExpanded}
                <FolderOpen class="w-4 h-4 flex-shrink-0 text-faint" />
            {:else}
                <Folder class="w-4 h-4 flex-shrink-0 text-faint" />
            {/if}
            <span class="truncate">{item.name}</span>
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
        style="padding-left: {26 + level * 14}px"
        class="nav-item py-1.5 {isActive ? 'nav-item-active' : ''}"
    >
        <FileText class="w-4 h-4 flex-shrink-0 {isActive ? 'text-accent' : 'text-ghost'}" />
        <span class="truncate">{item.name}</span>
    </a>
{/if}
