<script lang="ts">
    import { marked } from 'marked';
    import Bot from '@lucide/svelte/icons/bot';
import UserIcon from '@lucide/svelte/icons/user';
import ThumbsUp from '@lucide/svelte/icons/thumbs-up';
import ThumbsDown from '@lucide/svelte/icons/thumbs-down';
    import { fly } from 'svelte/transition';
    import { sanitizeHtml } from '$lib/utils/sanitize';
    import { renderMermaidBlocksIn } from '$lib/utils/mermaidRender';
    import { theme } from '$lib/stores/theme';
    import Search from '@lucide/svelte/icons/search';
    import SourceResultsPanel from '$lib/components/SourceResultsPanel.svelte';

    type Message = { role: 'user' | 'assistant', content: string, sources?: any[] };

    let {
        msg,
        conversationId = null,
        messageIndex = 0,
        streaming = false
    }: { msg: Message; conversationId?: string | null; messageIndex?: number; streaming?: boolean } = $props();

    let feedbackGiven = $state<number | null>(null);
    let proseEl = $state<HTMLDivElement>();
    let isDark = $state(true);
    theme.subscribe(t => isDark = t === 'dark');

    let renderedContent = $derived(
        msg.role === 'assistant'
            ? sanitizeHtml(marked.parse(msg.content.replace(/\$\\rightarrow\$/g, '→')) as string)
            : msg.content
    );

    // Render mermaid blocks in the assistant message.
    // Suppress during streaming to avoid render-thrashing on partial blocks;
    // debounce after streaming stops or content updates.
    let mermaidDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    $effect(() => {
        const _content = renderedContent;
        const _streaming = streaming;
        const _el = proseEl;
        if (msg.role !== 'assistant') return;
        if (!_el) return;
        if (!_content) return;
        if (_streaming) return;
        if (mermaidDebounceTimer) clearTimeout(mermaidDebounceTimer);
        mermaidDebounceTimer = setTimeout(() => {
            if (proseEl && !streaming) {
                renderMermaidBlocksIn(proseEl);
            }
        }, 150);
        return () => {
            if (mermaidDebounceTimer) clearTimeout(mermaidDebounceTimer);
        };
    });

    // ─── Text selection → find source documents ───
    let selectionText = $state('');
    let btnX = $state(0);
    let btnY = $state(0);
    let showFindBtn = $state(false);

    let panelOpen = $state(false);
    let panelLoading = $state(false);
    let panelError = $state<string | null>(null);
    let panelResults = $state<any[]>([]);

    function handleSelectionEnd() {
        // Only offer this on assistant messages.
        if (msg.role !== 'assistant') return;
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? '';
        // Require a meaningful selection that lives inside this message.
        if (!sel || text.length < 4 || !proseEl) {
            showFindBtn = false;
            return;
        }
        const anchorOk = sel.anchorNode && proseEl.contains(sel.anchorNode);
        const focusOk = sel.focusNode && proseEl.contains(sel.focusNode);
        if (!anchorOk || !focusOk) {
            showFindBtn = false;
            return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            showFindBtn = false;
            return;
        }
        selectionText = text;
        // Position the floating button just above the selection (viewport-fixed).
        btnX = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80);
        btnY = rect.top - 8;
        showFindBtn = true;
    }

    async function findSources() {
        showFindBtn = false;
        const q = selectionText;
        if (!q) return;
        panelOpen = true;
        panelLoading = true;
        panelError = null;
        panelResults = [];

        // Restrict the search to the documents actually used in THIS answer.
        const sourceIds = (msg.sources ?? [])
            .map((s: any) => s?.path || s?.filename)
            .filter((s: any): s is string => typeof s === 'string' && s.length > 0);

        if (sourceIds.length === 0) {
            panelLoading = false;
            panelResults = [];
            return;
        }

        try {
            const res = await fetch('/api/search-sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q, sources: sourceIds })
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                panelError = body.error || `Search failed (${res.status})`;
            } else {
                const data = await res.json();
                panelResults = data.results ?? [];
            }
        } catch (e) {
            panelError = 'Search request failed.';
            console.error('findSources error:', e);
        } finally {
            panelLoading = false;
        }
    }

    // Hide the floating button when the selection is cleared or the user scrolls.
    $effect(() => {
        function onDocMouseDown(e: MouseEvent) {
            // Keep it open if clicking the button itself.
            const target = e.target as HTMLElement;
            if (target?.closest?.('[data-find-sources-btn]')) return;
            showFindBtn = false;
        }
        document.addEventListener('mousedown', onDocMouseDown);
        window.addEventListener('scroll', () => (showFindBtn = false), true);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
        };
    });

    async function submitFeedback(rating: number) {
        if (feedbackGiven !== null) return;
        feedbackGiven = rating;
        try {
            await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversationId,
                    messageIndex,
                    rating
                })
            });
        } catch (e) {
            console.error('Failed to submit feedback:', e);
        }
    }
</script>

<div
    class="group flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}"
    in:fly={{ y: 8, duration: 200 }}
>
    <div class="flex max-w-[80ch] gap-3 {msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0
            {msg.role === 'user' ? 'bg-accent-solid text-on-accent' : 'bg-surface border border-line text-accent'}">
            {#if msg.role === 'user'}
                <UserIcon class="w-4 h-4" />
            {:else}
                <Bot class="w-4 h-4" />
            {/if}
        </div>
        <div class="min-w-0 space-y-2">
            <div class="px-4 py-3 rounded-2xl text-sm leading-relaxed
                {msg.role === 'user'
                    ? 'bg-accent-solid text-on-accent-body rounded-tr-sm whitespace-pre-wrap'
                    : 'bg-surface border border-line-subtle text-dim rounded-tl-sm'}">
                {#if msg.role === 'assistant'}
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <div
                        bind:this={proseEl}
                        class="prose prose-sm max-w-none"
                        class:prose-invert={isDark}
                        onmouseup={handleSelectionEnd}
                        role="article"
                    >
                        {@html renderedContent}
                    </div>
                {:else}
                    {msg.content}
                {/if}
            </div>
            {#if msg.sources && msg.sources.length > 0}
                <div class="flex flex-wrap items-center gap-1.5">
                    <span class="eyebrow">Sources</span>
                    {#each msg.sources as source}
                        <span class="chip font-mono text-[11px]" title={source.path || source.filename}>
                            {source.path || source.filename}
                        </span>
                    {/each}
                </div>
            {/if}
            {#if msg.role === 'assistant' && msg.content}
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                        onclick={() => submitFeedback(1)}
                        class="btn btn-ghost btn-icon {feedbackGiven === 1 ? 'text-success' : ''}"
                        disabled={feedbackGiven !== null}
                        aria-label="Mark answer as helpful"
                        title="Helpful"
                    >
                        <ThumbsUp class="w-3.5 h-3.5" />
                    </button>
                    <button
                        onclick={() => submitFeedback(-1)}
                        class="btn btn-ghost btn-icon {feedbackGiven === -1 ? 'text-danger' : ''}"
                        disabled={feedbackGiven !== null}
                        aria-label="Mark answer as not helpful"
                        title="Not helpful"
                    >
                        <ThumbsDown class="w-3.5 h-3.5" />
                    </button>
                </div>
            {/if}
        </div>
    </div>
</div>

{#if showFindBtn}
    <button
        data-find-sources-btn
        class="btn btn-primary btn-sm fixed z-[70] -translate-x-1/2 -translate-y-full shadow-xl"
        style="left: {btnX}px; top: {btnY}px;"
        onclick={findSources}
        transition:fly={{ y: 6, duration: 120 }}
    >
        <Search class="w-3.5 h-3.5" />
        Find sources
    </button>
{/if}

<SourceResultsPanel
    open={panelOpen}
    query={selectionText}
    loading={panelLoading}
    results={panelResults}
    error={panelError}
    hasSources={(msg.sources ?? []).length > 0}
    onClose={() => (panelOpen = false)}
/>
