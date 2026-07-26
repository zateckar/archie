<script lang="ts">
    import { enhance } from '$app/forms';
    import Loader2 from '@lucide/svelte/icons/loader-2';

    let { data, form } = $props();
    let loading = $state(false);
</script>

<div class="min-h-screen flex items-center justify-center bg-page p-6">
    <div class="w-full max-w-sm">
        <div class="mb-8 text-center">
            <p class="wordmark">Archie<span class="wordmark-dot ml-1"></span></p>
            <p class="page-subtitle mt-2">Sign in to search your knowledge base.</p>
        </div>

        <div class="card p-6 shadow-md">
            {#if form?.error}
                <div class="mb-5 rounded-xl border border-[color-mix(in_oklab,var(--danger)_32%,transparent)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2.5 text-[13px] text-danger">
                    {form.error}
                </div>
            {/if}

            <form
                method="POST"
                action="?/login"
                use:enhance={() => { loading = true; return async ({ update }) => { loading = false; update(); }; }}
                class="space-y-4"
            >
                <input type="hidden" name="redirectTo" value={data.redirectTo} />
                <div class="space-y-1.5">
                    <label class="block text-[13px] font-medium text-dim" for="username">Username</label>
                    <input type="text" id="username" name="username" required autocomplete="username" class="field" />
                </div>
                <div class="space-y-1.5">
                    <label class="block text-[13px] font-medium text-dim" for="password">Password</label>
                    <input type="password" id="password" name="password" required autocomplete="current-password" class="field" />
                </div>
                <button type="submit" disabled={loading} class="btn btn-primary w-full py-2.5">
                    {#if loading}
                        <Loader2 class="w-4 h-4 animate-spin" />
                    {/if}
                    {loading ? 'Signing in' : 'Sign in'}
                </button>
            </form>

            {#if data.oidcEnabled}
                <div class="mt-5 pt-5 border-t border-line-subtle">
                    <a href="/api/auth/oidc?redirectTo={encodeURIComponent(data.redirectTo)}" class="btn btn-secondary w-full py-2.5">
                        Sign in with OIDC
                    </a>
                </div>
            {/if}
        </div>
    </div>
</div>
