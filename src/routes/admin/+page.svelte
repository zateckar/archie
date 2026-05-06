<script lang="ts">
    import { onMount } from 'svelte';
    import { FileText, GitBranch, Users, Activity } from 'lucide-svelte';

    let stats = $state({
        documents: 0,
        repos: 0,
        users: 0
    });

    onMount(async () => {
        const [docsRes, reposRes, usersRes] = await Promise.all([
            fetch('/api/documents'),
            fetch('/api/git'),
            fetch('/api/users')
        ]);

        if (docsRes.ok) stats.documents = (await docsRes.json()).length;
        if (reposRes.ok) stats.repos = (await reposRes.json()).length;
        if (usersRes.ok) stats.users = (await usersRes.json()).length;
    });
</script>

<div class="p-8">
    <header class="mb-12">
        <h1 class="text-3xl font-bold text-white mb-2">Admin Dashboard</h1>
        <p class="text-slate-400 text-lg">Overview of your ARCHIE instance.</p>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl hover:border-[#78FAAE]/50 transition-all group">
            <div class="flex items-center justify-between mb-6">
                <div class="p-4 bg-[#0E3A2F]/30 rounded-2xl text-[#78FAAE] group-hover:scale-110 transition-transform">
                    <FileText class="w-8 h-8" />
                </div>
                <span class="text-4xl font-black text-white tracking-tighter">{stats.documents}</span>
            </div>
            <h3 class="text-xl font-bold text-slate-200 mb-1">Documents</h3>
            <p class="text-slate-500 text-sm">Indexed knowledge base files.</p>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl hover:border-[#78FAAE]/50 transition-all group">
            <div class="flex items-center justify-between mb-6">
                <div class="p-4 bg-[#0E3A2F]/30 rounded-2xl text-[#78FAAE] group-hover:scale-110 transition-transform">
                    <GitBranch class="w-8 h-8" />
                </div>
                <span class="text-4xl font-black text-white tracking-tighter">{stats.repos}</span>
            </div>
            <h3 class="text-xl font-bold text-slate-200 mb-1">Git Repos</h3>
            <p class="text-slate-500 text-sm">Connected source repositories.</p>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl hover:border-[#78FAAE]/50 transition-all group">
            <div class="flex items-center justify-between mb-6">
                <div class="p-4 bg-[#0E3A2F]/30 rounded-2xl text-[#78FAAE] group-hover:scale-110 transition-transform">
                    <Users class="w-8 h-8" />
                </div>
                <span class="text-4xl font-black text-white tracking-tighter">{stats.users}</span>
            </div>
            <h3 class="text-xl font-bold text-slate-200 mb-1">Users</h3>
            <p class="text-slate-500 text-sm">Registered system users.</p>
        </div>
    </div>

    <div class="mt-12 p-8 bg-slate-900 border border-slate-800 rounded-3xl shadow-xl">
        <h2 class="text-xl font-bold text-white mb-6 flex items-center gap-2">
            <Activity class="w-5 h-5 text-[#78FAAE]" />
            System Status
        </h2>
        <div class="space-y-4">
            <div class="flex items-center justify-between p-4 bg-slate-950 rounded-2xl border border-slate-800">
                <span class="text-slate-400">Database</span>
                <span class="px-3 py-1 bg-[#0E3A2F]/30 text-[#78FAAE] text-xs font-bold rounded-full border border-[#0E3A2F]/50">ONLINE</span>
            </div>
            <div class="flex items-center justify-between p-4 bg-slate-950 rounded-2xl border border-slate-800">
                <span class="text-slate-400">Vector Extension</span>
                <span class="px-3 py-1 bg-[#0E3A2F]/30 text-[#78FAAE] text-xs font-bold rounded-full border border-[#0E3A2F]/50">LOADED</span>
            </div>
            <div class="flex items-center justify-between p-4 bg-slate-950 rounded-2xl border border-slate-800">
                <span class="text-slate-400">Gemini API</span>
                <span class="px-3 py-1 bg-[#0E3A2F]/30 text-[#78FAAE] text-xs font-bold rounded-full border border-[#0E3A2F]/50">CONNECTED</span>
            </div>
        </div>
    </div>
</div>
