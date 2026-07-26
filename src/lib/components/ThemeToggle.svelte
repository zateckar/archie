<script lang="ts">
    import Sun from '@lucide/svelte/icons/sun';
import Moon from '@lucide/svelte/icons/moon';
    import { theme } from '$lib/stores/theme';
</script>

<button
    onclick={() => theme.toggle()}
    class="btn btn-ghost btn-icon"
    aria-label={$theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    title={$theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
>
    {#if $theme === 'dark'}
        <Sun class="w-4 h-4" />
    {:else}
        <Moon class="w-4 h-4" />
    {/if}
</button>
