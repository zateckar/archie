<script lang="ts">
    import { tick } from 'svelte';
    import { fade, scale as scaleTransition } from 'svelte/transition';
    import ZoomIn from '@lucide/svelte/icons/zoom-in';
    import ZoomOut from '@lucide/svelte/icons/zoom-out';
    import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
    import Copy from '@lucide/svelte/icons/copy';
    import X from '@lucide/svelte/icons/x';
    import { mermaidFullscreenState, closeMermaidFullscreen } from '$lib/stores/mermaidFullscreen';

    const MIN_ZOOM = 0.1;
    const MAX_ZOOM = 4;
    const ZOOM_STEP = 0.25;

    let open = $state(false);
    let svg = $state('');
    let source = $state('');
    let zoom = $state(1);
    let copied = $state(false);

    let modalEl = $state<HTMLDivElement>();
    let viewportEl = $state<HTMLDivElement>();
    let contentEl = $state<HTMLDivElement>();
    let naturalWidth = 0;
    let naturalHeight = 0;

    let dragging = $state(false);
    let dragStartX = 0;
    let dragStartY = 0;
    let dragScrollLeft = 0;
    let dragScrollTop = 0;

    let previousFocus: HTMLElement | null = null;

    mermaidFullscreenState.subscribe((s) => {
        open = s.open;
        svg = s.svg;
        source = s.source;
    });

    // When (re)opened with fresh SVG content, measure its natural size and fit it to view.
    $effect(() => {
        const _open = open;
        const _svg = svg;
        const _contentEl = contentEl;
        if (!_open || !_svg || !_contentEl) return;
        zoom = 1;
        (async () => {
            await tick();
            const svgEl = _contentEl.querySelector('svg');
            if (!svgEl) return;
            let w = 0;
            let h = 0;
            const viewBox = svgEl.getAttribute('viewBox');
            if (viewBox) {
                const parts = viewBox.trim().split(/\s+/).map(Number);
                if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
                    w = parts[2];
                    h = parts[3];
                }
            }
            if (!w || !h) {
                const rect = svgEl.getBoundingClientRect();
                w = rect.width || 800;
                h = rect.height || 600;
            }
            naturalWidth = w;
            naturalHeight = h;
            svgEl.setAttribute('role', 'img');
            svgEl.setAttribute('aria-label', 'Mermaid diagram');
            svgEl.removeAttribute('height');
            svgEl.style.width = `${w}px`;
            svgEl.style.height = `${h}px`;
            svgEl.style.maxWidth = 'none';
            fitToView();
        })();
    });

    function fitToView() {
        if (!viewportEl || !naturalWidth || !naturalHeight) {
            zoom = 1;
            return;
        }
        const padding = 64;
        const availW = Math.max(50, viewportEl.clientWidth - padding);
        const availH = Math.max(50, viewportEl.clientHeight - padding);
        const fit = Math.min(availW / naturalWidth, availH / naturalHeight, 1);
        zoom = Math.max(MIN_ZOOM, Math.round(fit * 100) / 100);
        recenter();
    }

    async function recenter() {
        await tick();
        if (!viewportEl) return;
        viewportEl.scrollLeft = Math.max(0, (viewportEl.scrollWidth - viewportEl.clientWidth) / 2);
        viewportEl.scrollTop = Math.max(0, (viewportEl.scrollHeight - viewportEl.clientHeight) / 2);
    }

    function setZoom(next: number) {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
    }

    function zoomIn() {
        setZoom(zoom + ZOOM_STEP);
        recenter();
    }

    function zoomOut() {
        setZoom(zoom - ZOOM_STEP);
        recenter();
    }

    function handleWheel(e: WheelEvent) {
        e.preventDefault();
        setZoom(zoom + (e.deltaY > 0 ? -0.15 : 0.15));
    }

    function handlePointerDown(e: PointerEvent) {
        if (e.button !== 0 || !viewportEl) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragScrollLeft = viewportEl.scrollLeft;
        dragScrollTop = viewportEl.scrollTop;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e: PointerEvent) {
        if (!dragging || !viewportEl) return;
        viewportEl.scrollLeft = dragScrollLeft - (e.clientX - dragStartX);
        viewportEl.scrollTop = dragScrollTop - (e.clientY - dragStartY);
    }

    function handlePointerUp(e: PointerEvent) {
        dragging = false;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMermaidFullscreen();
            return;
        }
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            zoomIn();
            return;
        }
        if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            zoomOut();
            return;
        }
        if (e.key === '0') {
            e.preventDefault();
            fitToView();
            return;
        }
        if (e.key === 'Tab' && modalEl) {
            const focusables = modalEl.querySelectorAll<HTMLElement>(
                'button, [href], input, select, [tabindex]:not([tabindex="-1"])'
            );
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    $effect(() => {
        if (open) {
            previousFocus = document.activeElement as HTMLElement;
            document.addEventListener('keydown', handleKeyDown);
        } else {
            document.removeEventListener('keydown', handleKeyDown);
            previousFocus?.focus?.();
        }
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    });

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) {
            closeMermaidFullscreen();
        }
    }

    async function copySource() {
        if (!source) return;
        try {
            await navigator.clipboard.writeText(source);
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch (e) {
            console.error('Copy failed', e);
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
        onclick={handleBackdropClick}
        transition:fade={{ duration: 150 }}
    >
        <div
            bind:this={modalEl}
            role="dialog"
            aria-modal="true"
            aria-label="Mermaid diagram fullscreen viewer"
            class="bg-[var(--bg-raised)] border border-[var(--border-primary)] rounded-2xl shadow-2xl w-full max-w-[96vw] h-[92vh] flex flex-col overflow-hidden"
            transition:scaleTransition={{ duration: 200, start: 0.95 }}
        >
            <!-- Header -->
            <header class="flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--border-primary)] bg-[var(--bg-slate-950)]/50 flex-shrink-0">
                <h2 class="text-sm font-bold text-[var(--text-primary)] uppercase tracking-widest">Diagram</h2>
                <div class="flex items-center gap-1.5">
                    <button
                        type="button"
                        onclick={zoomOut}
                        class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                        title="Zoom out"
                        aria-label="Zoom out"
                    >
                        <ZoomOut class="w-4 h-4" />
                    </button>
                    <span class="text-xs font-mono text-[var(--text-muted)] w-12 text-center select-none">{Math.round(zoom * 100)}%</span>
                    <button
                        type="button"
                        onclick={zoomIn}
                        class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                        title="Zoom in"
                        aria-label="Zoom in"
                    >
                        <ZoomIn class="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onclick={fitToView}
                        class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                        title="Reset zoom"
                        aria-label="Reset zoom"
                    >
                        <RotateCcw class="w-4 h-4" />
                    </button>
                    {#if source}
                        <div class="w-px h-5 bg-[var(--border-primary)] mx-1"></div>
                        <button
                            type="button"
                            onclick={copySource}
                            class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                            title="Copy source"
                            aria-label="Copy source"
                        >
                            <Copy class="w-4 h-4" />
                            <span class="sr-only">{copied ? 'Copied' : 'Copy source'}</span>
                        </button>
                    {/if}
                    <div class="w-px h-5 bg-[var(--border-primary)] mx-1"></div>
                    <button
                        type="button"
                        onclick={() => closeMermaidFullscreen()}
                        class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                        title="Close"
                        aria-label="Close"
                    >
                        <X class="w-4 h-4" />
                    </button>
                </div>
            </header>

            <!-- Pannable / zoomable viewport -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                bind:this={viewportEl}
                class="flex-1 overflow-auto mermaid-fullscreen-viewport"
                class:cursor-grab={!dragging}
                class:cursor-grabbing={dragging}
                onwheel={handleWheel}
                onpointerdown={handlePointerDown}
                onpointermove={handlePointerMove}
                onpointerup={handlePointerUp}
                onpointerleave={handlePointerUp}
            >
                <div class="mermaid-fullscreen-stage">
                    <div bind:this={contentEl} class="mermaid-fullscreen-content" style="transform: scale({zoom});">
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html svg}
                    </div>
                </div>
            </div>

            <!-- Footer hint -->
            <footer class="px-5 py-2 border-t border-[var(--border-primary)] bg-[var(--bg-slate-950)]/50 flex-shrink-0">
                <p class="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold text-center">
                    Scroll to zoom · Drag to pan · Esc to close
                </p>
            </footer>
        </div>
    </div>
{/if}

<style>
    .mermaid-fullscreen-viewport {
        touch-action: none;
        overscroll-behavior: contain;
    }

    .mermaid-fullscreen-viewport::-webkit-scrollbar {
        width: 8px;
        height: 8px;
    }

    .mermaid-fullscreen-viewport::-webkit-scrollbar-track {
        background: transparent;
    }

    .mermaid-fullscreen-viewport::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb);
        border-radius: 9999px;
    }

    .mermaid-fullscreen-viewport::-webkit-scrollbar-thumb:hover {
        background: var(--scrollbar-hover);
    }

    .mermaid-fullscreen-stage {
        min-width: 100%;
        min-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
        box-sizing: border-box;
    }

    .mermaid-fullscreen-content {
        transform-origin: center center;
        flex-shrink: 0;
        line-height: 0;
    }
</style>
