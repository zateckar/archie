<script lang="ts">
    import { enhance } from '$app/forms';
    import Loader2 from 'lucide-svelte/icons/loader-2';

    let { data, form } = $props();
    let loading = $state(false);
</script>

<div class="min-h-screen flex items-center justify-center bg-[var(--bg-page)] text-[var(--text-page)]">
    <div class="w-full max-w-md p-8 bg-[var(--bg-surface)] border border-[var(--border-primary)] rounded-2xl shadow-2xl">
        <h1 class="text-2xl font-bold mb-6 text-center bg-gradient-to-r from-[#78FAAE] to-[#0E3A2F] bg-clip-text text-transparent">Login</h1>
        
        {#if form?.error}
            <div class="mb-4 p-3 bg-red-900/50 border border-red-800 text-red-200 rounded-lg text-sm">
                {form.error}
            </div>
        {/if}

        <form method="POST" action="?/login" use:enhance={() => { loading = true; return async ({ update }) => { loading = false; update(); }; }} class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-[var(--text-muted)] mb-1" for="username">Username</label>
                <input type="text" id="username" name="username" required class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-lg p-3 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-colors" />
            </div>
            <div>
                <label class="block text-sm font-medium text-[var(--text-muted)] mb-1" for="password">Password</label>
                <input type="password" id="password" name="password" required class="w-full bg-[var(--bg-slate-950)] border border-[var(--border-primary)] rounded-lg p-3 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-colors" />
            </div>
            <button type="submit" disabled={loading} class="w-full p-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] disabled:bg-[var(--bg-slate-800)] disabled:text-[var(--text-faint)] rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2">
                {#if loading}
                    <Loader2 class="w-4 h-4 animate-spin" />
                {/if}
                Login
            </button>
        </form>

        {#if data.oidcEnabled}
        <div class="mt-6 pt-6 border-t border-[var(--border-primary)]">
            <a href="/api/auth/oidc" class="w-full p-3 bg-[var(--bg-slate-800)] hover:bg-[var(--hover-surface)] rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2">
                Login with OIDC
            </a>
        </div>
        {/if}
    </div>
</div>
