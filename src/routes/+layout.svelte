<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { reinitializeMermaid } from '$lib/utils/mermaid';

	let { children } = $props();

	// Re-render mermaid diagrams when the app theme changes.
	onMount(() => {
		let first = true;
		const unsub = theme.subscribe((t) => {
			// Skip the initial subscription call so we don't trigger a re-init
			// before any diagrams have rendered.
			if (first) {
				first = false;
				return;
			}
			reinitializeMermaid(t);
		});
		return unsub;
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
