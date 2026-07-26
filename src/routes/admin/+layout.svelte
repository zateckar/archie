<script lang="ts">
    import { page } from '$app/state';
    import FileText from '@lucide/svelte/icons/file-text';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Users from '@lucide/svelte/icons/users';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import ChevronLeft from '@lucide/svelte/icons/chevron-left';
import LogOut from '@lucide/svelte/icons/log-out';
import Network from '@lucide/svelte/icons/network';
import Coins from '@lucide/svelte/icons/coins';

    let { children } = $props();

    const menuItems = [
        { name: 'Dashboard', href: '/admin', icon: LayoutDashboard },
        { name: 'Documents', href: '/admin/documents', icon: FileText },
        { name: 'Git Repos', href: '/admin/repos', icon: GitBranch },
        { name: 'Users', href: '/admin/users', icon: Users },
        { name: 'Knowledge', href: '/admin/knowledge', icon: Network },
        { name: 'Token usage', href: '/admin/usage', icon: Coins },
    ];
</script>

<div class="flex h-screen bg-page text-body font-sans overflow-hidden">
    <!-- Admin Sidebar -->
    <aside class="w-60 bg-surface border-r border-line flex flex-col flex-shrink-0">
        <div class="h-14 px-4 border-b border-line-subtle flex items-center">
            <p class="wordmark">Archie<span class="wordmark-dot ml-1"></span></p>
            <span class="chip ml-2">Admin</span>
        </div>

        <nav class="flex-1 p-2 space-y-0.5">
            {#each menuItems as item}
                {@const active = page.url.pathname === item.href}
                <a href={item.href} class="nav-item {active ? 'nav-item-active' : ''}">
                    <item.icon class="w-4 h-4 {active ? 'text-accent' : 'text-faint'}" />
                    <span>{item.name}</span>
                </a>
            {/each}
        </nav>

        <div class="p-2 border-t border-line-subtle">
            <a href="/" class="nav-item">
                <ChevronLeft class="w-4 h-4 text-faint" />
                <span>Back to chat</span>
            </a>
        </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 overflow-y-auto bg-page relative">
        {@render children()}
    </main>
</div>
