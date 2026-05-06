<script lang="ts">
    import { enhance } from '$app/forms';
    import { Loader2 } from 'lucide-svelte';

    let { data, form } = $props();
    let loading = $state(false);
</script>

<div class="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
    <div class="w-full max-w-md p-8 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl">
        <h1 class="text-2xl font-bold mb-6 text-center bg-gradient-to-r from-[#78FAAE] to-[#0E3A2F] bg-clip-text text-transparent">Login</h1>
        
        {#if form?.error}
            <div class="mb-4 p-3 bg-red-900/50 border border-red-800 text-red-200 rounded-lg text-sm">
                {form.error}
            </div>
        {/if}

        <form method="POST" action="?/login" use:enhance={() => { loading = true; return async ({ update }) => { loading = false; update(); }; }} class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-slate-400 mb-1" for="username">Username</label>
                <input type="text" id="username" name="username" required class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-colors" />
            </div>
            <div>
                <label class="block text-sm font-medium text-slate-400 mb-1" for="password">Password</label>
                <input type="password" id="password" name="password" required class="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-colors" />
            </div>
            <button type="submit" disabled={loading} class="w-full p-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 disabled:bg-slate-800 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2">
                {#if loading}
                    <Loader2 class="w-4 h-4 animate-spin" />
                {/if}
                Login
            </button>
        </form>

        {#if data.oidcEnabled}
        <div class="mt-6 pt-6 border-t border-slate-800">
            <a href="/api/auth/oidc" class="w-full p-3 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2">
                Login with OIDC
            </a>
        </div>
        {/if}
    </div>
</div>
