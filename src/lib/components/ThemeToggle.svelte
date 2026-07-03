<script lang="ts">
    import Sun from 'lucide-svelte/icons/sun';
import Moon from 'lucide-svelte/icons/moon';
    import { theme } from '$lib/stores/theme';
</script>

<button
    onclick={() => theme.toggle()}
    class="p-2 rounded-xl transition-all border border-[var(--border-primary)] hover:border-[var(--border-hover)] { $theme === 'dark' ? 'bg-[var(--bg-slate-800)] hover:bg-[var(--bg-slate-800-50)] text-[var(--text-muted)]' : 'bg-[var(--bg-slate-800)] hover:bg-[var(--bg-muted)] text-[var(--text-muted)]' }"
    aria-label="Toggle theme"
    title="Toggle dark/light mode"
>
    {#if $theme === 'dark'}
        <Sun class="w-4 h-4" />
    {:else}
        <Moon class="w-4 h-4" />
    {/if}
</button>
