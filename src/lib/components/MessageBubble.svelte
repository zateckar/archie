<script lang="ts">
    import { marked } from 'marked';
    import Bot from 'lucide-svelte/icons/bot';
import UserIcon from 'lucide-svelte/icons/user';
import ThumbsUp from 'lucide-svelte/icons/thumbs-up';
import ThumbsDown from 'lucide-svelte/icons/thumbs-down';
    import { fly } from 'svelte/transition';
    import { sanitizeHtml } from '$lib/utils/sanitize';
    import { renderMermaidBlocksIn } from '$lib/utils/mermaidRender';
    import { theme } from '$lib/stores/theme';

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
    in:fly={{ y: 20, duration: 400, delay: 0 }}
>
    <div class="flex max-w-[85%] space-x-4 {msg.role === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'}">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform hover:scale-110
            {msg.role === 'user' ? 'bg-[#0E3A2F] shadow-lg shadow-[#0E3A2F]/30 text-[#78FAAE]' : 'bg-[var(--bg-slate-900)] border border-[var(--border-primary)] shadow-xl shadow-black/40'}">
            {#if msg.role === 'user'}
                <UserIcon class="w-5 h-5" />
            {:else}
                <Bot class="w-5 h-5 text-[#78FAAE]" />
            {/if}
        </div>
        <div class="space-y-3">
            <div class="p-5 rounded-2xl leading-relaxed shadow-2xl
                {msg.role === 'user' ? 'bg-[#0E3A2F] text-[#78FAAE] rounded-tr-none border border-[#78FAAE]/20' : 'bg-[var(--bg-raised)] border border-[var(--border-secondary)] text-[var(--text-secondary)] rounded-tl-none'}">
                {#if msg.role === 'assistant'}
                    <div bind:this={proseEl} class="prose prose-sm prose-slate max-w-none" class:prose-invert={isDark}>
                        {@html renderedContent}
                    </div>
                {:else}
                    {msg.content}
                {/if}
            </div>
            {#if msg.sources && msg.sources.length > 0}
                <div class="flex flex-wrap gap-2 pt-1 opacity-40 hover:opacity-100 transition-opacity duration-300">
                    <span class="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] font-black self-center">Sources</span>
                    {#each msg.sources as source}
                        <span class="text-[10px] px-2.5 py-1 bg-[var(--bg-slate-900)] border border-[var(--border-primary)] rounded-lg text-[var(--text-muted)] font-mono">
                            {source.path || source.filename}
                        </span>
                    {/each}
                </div>
            {/if}
            {#if msg.role === 'assistant' && msg.content}
                <div class="flex items-center gap-1.5 pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <button
                        onclick={() => submitFeedback(1)}
                        class="p-1 rounded-md transition-colors {feedbackGiven === 1 ? 'text-green-400 bg-green-400/10' : 'text-[var(--text-faintest)] hover:text-[var(--text-muted)] hover:bg-[var(--hover-surface)]'}"
                        disabled={feedbackGiven !== null}
                        title="Helpful"
                    >
                        <ThumbsUp class="w-3.5 h-3.5" />
                    </button>
                    <button
                        onclick={() => submitFeedback(-1)}
                        class="p-1 rounded-md transition-colors {feedbackGiven === -1 ? 'text-red-400 bg-red-400/10' : 'text-[var(--text-faintest)] hover:text-[var(--text-muted)] hover:bg-[var(--hover-surface)]'}"
                        disabled={feedbackGiven !== null}
                        title="Not helpful"
                    >
                        <ThumbsDown class="w-3.5 h-3.5" />
                    </button>
                </div>
            {/if}
        </div>
    </div>
</div>
