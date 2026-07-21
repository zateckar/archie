<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import X from '@lucide/svelte/icons/x';
import Workflow from '@lucide/svelte/icons/workflow';
import AlertCircle from '@lucide/svelte/icons/alert-circle';
    import { fade, scale } from 'svelte/transition';
    import MermaidDiagram from './MermaidDiagram.svelte';

    let {
        open,
        initialCode = '',
        onInsert,
        onClose
    }: {
        open: boolean;
        initialCode?: string;
        onInsert: (code: string) => void;
        onClose: () => void;
    } = $props();

    const DEFAULT_TEMPLATE = `flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do thing]
    B -->|No| D[Skip]
    C --> E[End]
    D --> E`;

    let code = $state<string>('');
    let debouncedCode = $state<string>('');
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let textareaEl = $state<HTMLTextAreaElement>();
    let modalEl = $state<HTMLDivElement>();
    let previousFocus: HTMLElement | null = null;

    // Reset code when modal opens (or when initialCode changes while open).
    $effect(() => {
        if (open) {
            code = initialCode || DEFAULT_TEMPLATE;
            debouncedCode = code;
        }
    });

    // Debounce preview updates to avoid render thrashing on every keystroke.
    $effect(() => {
        const _code = code;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debouncedCode = _code;
        }, 300);
        return () => {
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    });

    // Focus trap + auto-focus textarea on open.
    $effect(() => {
        if (open) {
            previousFocus = document.activeElement as HTMLElement;
            queueMicrotask(() => textareaEl?.focus());
            document.addEventListener('keydown', handleKeyDown);
        } else {
            document.removeEventListener('keydown', handleKeyDown);
            previousFocus?.focus?.();
        }
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    });

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
        }
        if (e.key === 'Tab' && modalEl) {
            // Simple focus trap.
            const focusables = modalEl.querySelectorAll<HTMLElement>(
                'button, textarea, [href], input, select, [tabindex]:not([tabindex="-1"])'
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

    function handleInsert() {
        const trimmed = code.trim();
        if (!trimmed) return;
        onInsert(trimmed);
    }

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
        onclick={handleBackdropClick}
        transition:fade={{ duration: 150 }}
    >
        <div
            bind:this={modalEl}
            role="dialog"
            aria-modal="true"
            aria-label="Insert Mermaid diagram"
            class="bg-[var(--bg-raised)] border border-[var(--border-primary)] rounded-2xl shadow-2xl w-full max-w-6xl h-[80vh] flex flex-col overflow-hidden"
            transition:scale={{ duration: 200, start: 0.95 }}
        >
            <!-- Header -->
            <header class="flex items-center justify-between px-5 py-3 border-b border-[var(--border-primary)] bg-[var(--bg-slate-950)]/50">
                <div class="flex items-center gap-3">
                    <Workflow class="w-5 h-5 text-[#78FAAE]" />
                    <h2 class="text-sm font-bold text-[var(--text-primary)] uppercase tracking-widest">Mermaid Diagram</h2>
                </div>
                <button
                    type="button"
                    onclick={onClose}
                    class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all"
                    aria-label="Close"
                >
                    <X class="w-4 h-4" />
                </button>
            </header>

            <!-- Body: split pane -->
            <div class="flex-1 flex overflow-hidden">
                <!-- Source editor -->
                <div class="flex-1 flex flex-col border-r border-[var(--border-primary)] min-w-0">
                    <div class="px-4 py-2 border-b border-[var(--border-primary)] text-[10px] font-bold uppercase tracking-widest text-[var(--text-faint)]">
                        Source
                    </div>
                    <textarea
                        bind:this={textareaEl}
                        bind:value={code}
                        spellcheck="false"
                        class="flex-1 w-full bg-[var(--bg-slate-950)] text-[#78FAAE] font-mono text-sm p-4 resize-none outline-none"
                        placeholder="Enter mermaid syntax..."
                    ></textarea>
                </div>

                <!-- Live preview -->
                <div class="flex-1 flex flex-col min-w-0">
                    <div class="px-4 py-2 border-b border-[var(--border-primary)] text-[10px] font-bold uppercase tracking-widest text-[var(--text-faint)]">
                        Preview
                    </div>
                    <div class="flex-1 overflow-auto p-4 bg-[var(--bg-page)]">
                        {#if debouncedCode.trim()}
                            <MermaidDiagram code={debouncedCode} />
                        {:else}
                            <div class="text-[var(--text-faintest)] text-sm flex items-center gap-2">
                                <AlertCircle class="w-4 h-4" />
                                Enter mermaid syntax to see a preview.
                            </div>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- Footer -->
            <footer class="flex items-center justify-between px-5 py-3 border-t border-[var(--border-primary)] bg-[var(--bg-slate-950)]/50">
                <a
                    href="https://mermaid.js.org/intro/"
                    target="_blank"
                    rel="noopener"
                    class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-faint)] hover:text-[#78FAAE] transition-colors"
                >
                    Mermaid syntax reference →
                </a>
                <div class="flex items-center gap-2">
                    <button
                        type="button"
                        onclick={onClose}
                        class="px-4 py-2 hover:bg-[var(--hover-surface)] rounded-xl text-xs font-bold transition-all text-[var(--text-muted)]"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onclick={handleInsert}
                        disabled={!code.trim()}
                        class="px-4 py-2 bg-[#78FAAE] hover:bg-[#78FAAE]/80 text-black rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                    >
                        Insert
                    </button>
                </div>
            </footer>
        </div>
    </div>
{/if}
