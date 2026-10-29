<script lang="ts">
    import { marked } from 'marked';
    import X from '@lucide/svelte/icons/x';
    import FileText from '@lucide/svelte/icons/file-text';
    import SquarePen from '@lucide/svelte/icons/square-pen';
    import { sanitizeHtml } from '$lib/utils/sanitize';
    import { renderMermaidBlocksIn } from '$lib/utils/mermaidRender';
    import { highlightText } from '$lib/utils/highlight';
    import { wikiHref, type QuickViewDoc } from '$lib/utils/citations';
    import { theme } from '$lib/stores/theme';
    import { QUICK_VIEW_MIN_WIDTH, QUICK_VIEW_MAX_WIDTH, QUICK_VIEW_DEFAULT_WIDTH, clampQuickViewWidth } from '$lib/prefs';

    /**
     * A cited document, read-only, in a column beside the chat — so checking a
     * source does not cost the conversation. Editing stays in the wiki, one click
     * away. The column's width is the page's to persist; this only reports drags.
     */
    let {
        doc,
        width = $bindable(QUICK_VIEW_DEFAULT_WIDTH),
        reserve = 0,
        onWidthCommit,
        onOpen,
        onClose
    }: {
        doc: QuickViewDoc;
        width?: number;
        /** Pixels of the window the rest of the page keeps; the view never grows into them. */
        reserve?: number;
        /** Called once a resize settles, with the width to save. */
        onWidthCommit: (width: number) => void;
        /** A relative link inside the document was followed to another wiki file. */
        onOpen: (doc: QuickViewDoc) => void;
        onClose: () => void;
    } = $props();

    let content = $state('');
    let loading = $state(true);
    let error = $state<string | null>(null);
    let bodyEl = $state<HTMLDivElement>();
    let isDark = $state(true);
    theme.subscribe((t) => (isDark = t === 'dark'));

    let filename = $derived(doc.path.slice(doc.path.lastIndexOf('/') + 1));
    let wikiUrl = $derived.by(() => {
        const base = wikiHref({ repo_id: doc.repoId, path: doc.path })!;
        return doc.highlight ? `${base}?highlight=${encodeURIComponent(doc.highlight)}` : base;
    });

    $effect(() => {
        const { repoId, path } = doc;
        const controller = new AbortController();
        loading = true;
        error = null;
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        fetch(`/api/wiki/${repoId}/file?path=${encodedPath}`, { signal: controller.signal })
            .then(async (res) => {
                if (res.ok) {
                    content = (await res.json()).content ?? '';
                } else {
                    content = '';
                    error = res.status === 404 ? 'This document is no longer in the wiki.' : `Could not load the document (${res.status}).`;
                }
                loading = false;
            })
            .catch((e) => {
                if (e?.name === 'AbortError') return;
                content = '';
                error = 'Could not load the document.';
                loading = false;
            });
        return () => controller.abort();
    });

    let rendered = $derived.by(() => {
        if (!content) return '';
        try {
            return sanitizeHtml(marked.parse(content, { async: false }) as string);
        } catch {
            return '';
        }
    });

    // Diagrams and the highlight are applied to the live DOM once {@html} has
    // painted, the same way the wiki page does it.
    $effect(() => {
        const _html = rendered;
        const el = bodyEl;
        const q = doc.highlight;
        if (!el || !_html) return;
        queueMicrotask(() => {
            renderMermaidBlocksIn(el);
            if (q) {
                highlightText(el, q)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                el.closest('.qv-scroll')?.scrollTo({ top: 0 });
            }
        });
    });

    /**
     * Links inside the document were written for the wiki, where a relative
     * href resolves against the file's folder. Here they would resolve against
     * the chat page, so a link to another markdown file opens in this view, and
     * an external one opens in a new tab rather than replacing the chat.
     */
    function onBodyClick(e: MouseEvent) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = (e.target as Element | null)?.closest?.('a');
        const href = a?.getAttribute('href');
        if (!a || !href || href.startsWith('#')) return;

        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            e.preventDefault();
            window.open(href, '_blank', 'noopener,noreferrer');
            return;
        }
        if (href.startsWith('/')) return;

        const [target] = href.split(/[?#]/);
        if (!/\.mdx?$/i.test(target)) return;
        const base = `https://x/${doc.path.split('/').map(encodeURIComponent).join('/')}`;
        const resolved = new URL(target, base).pathname.slice(1);
        try {
            const path = resolved.split('/').map(decodeURIComponent).join('/');
            e.preventDefault();
            onOpen({ repoId: doc.repoId, path });
        } catch {
            // Malformed escape: leave the browser's default behaviour.
        }
    }

    // ── Resizing ─────────────────────────────────────────────────────────────
    // The handle is on the column's left edge, so dragging left widens it.

    let isResizing = $state(false);

    function startResize(e: PointerEvent) {
        e.preventDefault();
        isResizing = true;
        const startX = e.clientX;
        // The rendered width, not the stored one: on a small window the column
        // is capped, and a drag should move it from where it visibly is.
        const shown = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().width;
        const startWidth = shown ? Math.round(shown) : width;
        const onMove = (move: PointerEvent) => {
            width = clampQuickViewWidth(startWidth - (move.clientX - startX));
        };
        const onUp = () => {
            isResizing = false;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            onWidthCommit(width);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    function setWidth(next: number) {
        width = clampQuickViewWidth(next);
        onWidthCommit(width);
    }

    function onResizeKey(e: KeyboardEvent) {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setWidth(width + step);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setWidth(width - step);
        } else if (e.key === 'Home') {
            e.preventDefault();
            setWidth(QUICK_VIEW_DEFAULT_WIDTH);
        }
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
    class="quick-view bg-surface border-l border-line flex flex-col {isResizing ? 'is-resizing' : ''}"
    style="width: {width}px; max-width: calc(100vw - {reserve}px)"
    aria-label="Quick View"
    onkeydown={(e) => e.key === 'Escape' && onClose()}
>
    <!-- Same ARIA window-splitter pattern as the conversations panel's grip. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Quick View"
        aria-valuenow={width}
        aria-valuemin={QUICK_VIEW_MIN_WIDTH}
        aria-valuemax={QUICK_VIEW_MAX_WIDTH}
        tabindex="0"
        class="qv-resize {isResizing ? 'is-active' : ''}"
        onpointerdown={startResize}
        onkeydown={onResizeKey}
        ondblclick={() => setWidth(QUICK_VIEW_DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
    ></div>

    <header class="h-14 px-4 border-b border-line-subtle flex items-center gap-2 flex-shrink-0">
        <FileText class="w-4 h-4 text-faint flex-shrink-0" />
        <div class="min-w-0 flex-1">
            <p class="eyebrow leading-none">Quick View</p>
            <p class="text-[13px] font-medium text-body truncate mt-1" title={doc.path}>{filename}</p>
        </div>
        <a href={wikiUrl} class="btn btn-ghost btn-sm flex-shrink-0" title="Open in the wiki, where it can be edited">
            <SquarePen class="w-3.5 h-3.5" />
            Open in wiki
        </a>
        <button class="btn btn-ghost btn-icon flex-shrink-0" onclick={onClose} aria-label="Close Quick View" title="Close">
            <X class="w-4 h-4" />
        </button>
    </header>

    <div class="qv-scroll flex-1 overflow-y-auto px-6 py-5">
        {#if loading}
            <div class="flex items-center justify-center py-16">
                <div class="spinner w-6 h-6"></div>
            </div>
        {:else if error}
            <div class="flex flex-col items-center gap-2 py-16 text-center">
                <FileText class="w-8 h-8 text-ghost" />
                <p class="text-[13px] text-mute">{error}</p>
            </div>
        {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
                bind:this={bodyEl}
                class="wiki-prose prose prose-sm max-w-none"
                class:prose-invert={isDark}
                role="document"
                onclick={onBodyClick}
            >
                {@html rendered}
            </div>
        {/if}
    </div>
</aside>

<style>
    .quick-view {
        position: relative;
        flex-shrink: 0;
        height: 100%;
        min-width: 0;
        z-index: 15;
    }

    .quick-view.is-resizing,
    .quick-view.is-resizing * {
        user-select: none;
    }

    /* Narrow screens: no room for two columns, so the view covers the chat. */
    @media (max-width: 767px) {
        .quick-view {
            position: fixed;
            inset: 0;
            width: 100% !important;
            max-width: none !important;
            z-index: 60;
        }
        .qv-resize { display: none; }
    }

    .qv-resize {
        position: absolute;
        top: 0;
        bottom: 0;
        left: -3px;
        width: 5px;
        cursor: col-resize;
        background: transparent;
        transition: background-color 0.15s ease;
        touch-action: none;
        z-index: 30;
    }

    .qv-resize:hover,
    .qv-resize:focus-visible,
    .qv-resize.is-active {
        background: var(--accent);
        outline: none;
    }
</style>
