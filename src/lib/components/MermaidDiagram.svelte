<script lang="ts">
    import { renderMermaid, hashId, registerReRenderCallback } from '$lib/utils/mermaid';
    import { openMermaidFullscreen } from '$lib/stores/mermaidFullscreen';
    import Copy from 'lucide-svelte/icons/copy';
import CodeIcon from 'lucide-svelte/icons/code';
import Eye from 'lucide-svelte/icons/eye';
import Maximize2 from 'lucide-svelte/icons/maximize-2';

    let { code, id }: { code: string; id?: string } = $props();

    let svg = $state<string>('');
    let error = $state<string | null>(null);
    let showSource = $state(false);
    let copied = $state(false);
    let renderToken = $state(0);

    const diagramId = $derived(id || hashId(code));

    // Re-render on theme change.
    $effect(() => {
        const unsub = registerReRenderCallback(() => {
            renderToken++;
        });
        return unsub;
    });

    $effect(() => {
        // Track dependencies explicitly.
        const _code = code;
        const _token = renderToken;
        void _token;
        let cancelled = false;
        (async () => {
            const result = await renderMermaid(_code, diagramId + '-' + _token);
            if (cancelled) return;
            if (result.ok) {
                svg = result.svg;
                error = null;
            } else {
                svg = '';
                error = result.error;
            }
        })();
        return () => {
            cancelled = true;
        };
    });

    async function copySource() {
        try {
            await navigator.clipboard.writeText(code);
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch (e) {
            console.error('Copy failed', e);
        }
    }

    function expandFullscreen() {
        if (svg) openMermaidFullscreen(svg, code);
    }
</script>

<div class="mermaid-diagram-wrapper relative group">
    {#if error}
        <div class="mermaid-diagram-error">
            <p class="mermaid-error-title">Diagram syntax error</p>
            <pre class="mermaid-error-msg">{error}</pre>
            <details class="mermaid-error-details">
                <summary>View source</summary>
                <pre>{code}</pre>
            </details>
        </div>
    {:else if showSource}
        <div class="mermaid-diagram-source">
            <pre>{code}</pre>
        </div>
    {:else if svg}
        <div class="mermaid-diagram-scroll">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html svg}
        </div>
    {:else}
        <div class="mermaid-diagram-loading">
            <div class="w-5 h-5 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
        </div>
    {/if}

    {#if !error}
        <div class="mermaid-diagram-toolbar opacity-0 group-hover:opacity-100 transition-opacity">
            <button type="button" class="mermaid-btn" title="Copy source" onclick={copySource}>
                <Copy class="w-3 h-3" />
                {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" class="mermaid-btn" title="Toggle source" onclick={() => showSource = !showSource}>
                {#if showSource}
                    <Eye class="w-3 h-3" />
                    Diagram
                {:else}
                    <CodeIcon class="w-3 h-3" />
                    Source
                {/if}
            </button>
            {#if svg && !showSource}
                <button type="button" class="mermaid-btn" title="View fullscreen" onclick={expandFullscreen}>
                    <Maximize2 class="w-3 h-3" />
                    Expand
                </button>
            {/if}
        </div>
    {/if}
</div>
