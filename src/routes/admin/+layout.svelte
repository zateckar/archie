<script lang="ts">
    import { page } from '$app/state';
    import FileText from 'lucide-svelte/icons/file-text';
import GitBranch from 'lucide-svelte/icons/git-branch';
import Users from 'lucide-svelte/icons/users';
import LayoutDashboard from 'lucide-svelte/icons/layout-dashboard';
import ChevronLeft from 'lucide-svelte/icons/chevron-left';
import LogOut from 'lucide-svelte/icons/log-out';
import Network from 'lucide-svelte/icons/network';

    let { children } = $props();

    const menuItems = [
        { name: 'Dashboard', href: '/admin', icon: LayoutDashboard },
        { name: 'Documents', href: '/admin/documents', icon: FileText },
        { name: 'Git Repos', href: '/admin/repos', icon: GitBranch },
        { name: 'Users', href: '/admin/users', icon: Users },
        { name: 'Knowledge', href: '/admin/knowledge', icon: Network },
    ];
</script>

<div class="flex h-screen bg-[var(--bg-page)] text-slate-100 font-sans overflow-hidden">
    <!-- Admin Sidebar -->
    <aside class="w-64 bg-[var(--bg-slate-900)] border-r border-[var(--border-primary)] flex flex-col shadow-xl">
        <div class="p-6 border-b border-[var(--border-primary)] flex items-center justify-between">
            <h1 class="text-xl font-bold bg-gradient-to-r from-[#78FAAE] to-[#0E3A2F] bg-clip-text text-transparent uppercase tracking-widest">
                ARCHIE ADMIN
            </h1>
        </div>

        <nav class="flex-1 p-4 space-y-2">
            {#each menuItems as item}
                <a 
                    href={item.href} 
                    class="flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group
                    {page.url.pathname === item.href ? 'bg-[#0E3A2F] text-[#78FAAE] shadow-lg shadow-[#0E3A2F]/20' : 'hover:bg-[var(--hover-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
                >
                    <item.icon class="w-5 h-5 {page.url.pathname === item.href ? 'text-[#78FAAE]' : 'text-[var(--text-faint)] group-hover:text-[#78FAAE]'}" />
                    <span class="font-medium">{item.name}</span>
                </a>
            {/each}
        </nav>

        <div class="p-4 border-t border-[var(--border-primary)]">
            <a href="/" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[var(--hover-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all group">
                <ChevronLeft class="w-5 h-5 text-[var(--text-faint)] group-hover:text-[#78FAAE]" />
                <span class="font-medium">Back to Chat</span>
            </a>
        </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 overflow-y-auto bg-[var(--bg-page)] relative">
        {@render children()}
    </main>
</div>
