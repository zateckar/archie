<script lang="ts">
    import { marked } from 'marked';
    import { Bot, User as UserIcon } from 'lucide-svelte';
    import { fly } from 'svelte/transition';
    import { sanitizeHtml } from '$lib/utils/sanitize';

    type Message = { role: 'user' | 'assistant', content: string, sources?: any[] };

    let { msg }: { msg: Message } = $props();

    let renderedContent = $derived(
        msg.role === 'assistant'
            ? sanitizeHtml(marked.parse(msg.content.replace(/\$\\rightarrow\$/g, '→')) as string)
            : msg.content
    );
</script>

<div 
    class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}"
    in:fly={{ y: 20, duration: 400, delay: 0 }}
>
    <div class="flex max-w-[85%] space-x-4 {msg.role === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'}">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform hover:scale-110
            {msg.role === 'user' ? 'bg-[#0E3A2F] shadow-lg shadow-[#0E3A2F]/30 text-[#78FAAE]' : 'bg-slate-900 border border-slate-800 shadow-xl shadow-black/40'}">
            {#if msg.role === 'user'}
                <UserIcon class="w-5 h-5" />
            {:else}
                <Bot class="w-5 h-5 text-[#78FAAE]" />
            {/if}
        </div>
        <div class="space-y-3">
            <div class="p-5 rounded-2xl leading-relaxed shadow-2xl
                {msg.role === 'user' ? 'bg-[#0E3A2F] text-[#78FAAE] rounded-tr-none border border-[#78FAAE]/20' : 'bg-[#0f0f0f] border border-slate-800/50 text-slate-200 rounded-tl-none'}">
                {#if msg.role === 'assistant'}
                    <div class="prose prose-sm prose-invert prose-slate max-w-none">
                        {@html renderedContent}
                    </div>
                {:else}
                    {msg.content}
                {/if}
            </div>
            {#if msg.sources && msg.sources.length > 0}
                <div class="flex flex-wrap gap-2 pt-1 opacity-40 hover:opacity-100 transition-opacity duration-300">
                    <span class="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-black self-center">Sources</span>
                    {#each msg.sources as source}
                        <span class="text-[10px] px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-slate-400 font-mono">
                            {source.path || source.filename}
                        </span>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>