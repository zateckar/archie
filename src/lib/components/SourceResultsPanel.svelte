<script lang="ts">
    import { fly, fade } from 'svelte/transition';
    import X from '@lucide/svelte/icons/x';
    import FileText from '@lucide/svelte/icons/file-text';
    import Search from '@lucide/svelte/icons/search';
    import ExternalLink from '@lucide/svelte/icons/external-link';

    type SourceMatch = {
        doc_id: number;
        filename: string;
        path: string | null;
        repo_id: number | null;
        matches: number;
        snippet: string;
    };

    let {
        open = false,
        query = '',
        loading = false,
        results = [],
        error = null,
        hasSources = true,
        onClose
    }: {
        open?: boolean;
        query?: string;
        loading?: boolean;
        results?: SourceMatch[];
        error?: string | null;
        /** Whether the answer had any source documents to search at all. */
        hasSources?: boolean;
        onClose: () => void;
    } = $props();

    // Turn the [[HL]]...[[/HL]] markers from the FTS snippet into highlighted
    // spans. The raw snippet is escaped first so document content can't inject
    // markup.
    function renderSnippet(snippet: string): string {
        const escaped = (snippet || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return escaped
            .replace(/\[\[HL\]\]/g, '<mark class="src-hl">')
            .replace(/\[\[\/HL\]\]/g, '</mark>');
    }

    // Deep-link into the editable wiki with the selected text as a ?highlight=
    // param so the target page can highlight + scroll to the matching sentence.
    function wikiUrl(m: SourceMatch): string | null {
        if (m.repo_id == null || !m.path) return null;
        const encodedPath = m.path.split('/').map(encodeURIComponent).join('/');
        return `/wiki/${m.repo_id}/${encodedPath}?highlight=${encodeURIComponent(query)}`;
    }
</script>

{#if open}
    <div
        class="fixed inset-0 z-[60] flex justify-end"
        transition:fade={{ duration: 150 }}
    >
        <!-- backdrop -->
        <button
            class="absolute inset-0 bg-black/50 backdrop-blur-sm"
            aria-label="Close source results"
            onclick={onClose}
        ></button>

        <!-- panel -->
        <aside
            class="relative w-full max-w-md h-full bg-[var(--bg-raised)] border-l border-[var(--border-secondary)] shadow-2xl flex flex-col"
            transition:fly={{ x: 400, duration: 250 }}
        >
            <header class="p-5 border-b border-[var(--border-primary)] flex items-start gap-3">
                <div class="w-9 h-9 rounded-xl bg-[#0E3A2F] flex items-center justify-center flex-shrink-0">
                    <Search class="w-4 h-4 text-[#78FAAE]" />
                </div>
                <div class="min-w-0 flex-1">
                    <p class="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] font-black">Source documents</p>
                    <p class="text-sm text-[var(--text-secondary)] truncate mt-0.5" title={query}>“{query}”</p>
                </div>
                <button
                    class="p-1.5 rounded-lg text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--hover-surface)] transition-colors"
                    onclick={onClose}
                    aria-label="Close"
                >
                    <X class="w-4 h-4" />
                </button>
            </header>

            <div class="flex-1 overflow-y-auto p-4 space-y-3">
                {#if loading}
                    <div class="flex items-center justify-center py-16">
                        <div class="w-7 h-7 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
                    </div>
                {:else if error}
                    <p class="text-sm text-red-400 text-center py-10">{error}</p>
                {:else if !hasSources}
                    <div class="flex flex-col items-center gap-3 text-[var(--text-faint)] py-16 text-center">
                        <FileText class="w-12 h-12 text-slate-700" />
                        <p class="text-sm">This answer has no cited source documents.</p>
                        <p class="text-xs text-[var(--text-faintest)]">There's nothing to trace this selection back to.</p>
                    </div>
                {:else if results.length === 0}
                    <div class="flex flex-col items-center gap-3 text-[var(--text-faint)] py-16 text-center">
                        <FileText class="w-12 h-12 text-slate-700" />
                        <p class="text-sm">Not found in this answer's sources.</p>
                        <p class="text-xs text-[var(--text-faintest)]">The selected text wasn't matched in the documents used for this response. Try selecting a distinctive phrase.</p>
                    </div>
                {:else}
                    <p class="text-[11px] text-[var(--text-faint)] px-1">
                        Found in {results.length} of this answer's source document{results.length === 1 ? '' : 's'}
                    </p>
                    {#each results as m (m.doc_id)}
                        {@const url = wikiUrl(m)}
                        <div class="rounded-xl bg-[var(--bg-slate-900)]/60 border border-[var(--border-primary)] p-4 hover:border-[#78FAAE]/40 transition-colors">
                            <div class="flex items-center gap-2 mb-2">
                                <FileText class="w-3.5 h-3.5 text-[#78FAAE] flex-shrink-0" />
                                <span class="text-xs font-mono text-[var(--text-secondary)] truncate" title={m.path || m.filename}>
                                    {m.filename}
                                </span>
                                <span class="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-[#0E3A2F] text-[#78FAAE] font-bold flex-shrink-0">
                                    {m.matches} hit{m.matches === 1 ? '' : 's'}
                                </span>
                            </div>
                            <p class="text-xs text-[var(--text-muted)] leading-relaxed src-snippet">
                                {@html renderSnippet(m.snippet)}
                            </p>
                            {#if url}
                                <a
                                    href={url}
                                    class="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#78FAAE] hover:underline"
                                >
                                    Open &amp; review
                                    <ExternalLink class="w-3 h-3" />
                                </a>
                            {:else}
                                <p class="mt-3 text-[10px] text-[var(--text-faintest)] italic">Not linked to an editable wiki file</p>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        </aside>
    </div>
{/if}

<style>
    :global(.src-snippet mark.src-hl) {
        background: #78FAAE;
        color: #05140d;
        border-radius: 3px;
        padding: 0 2px;
        font-weight: 700;
    }
</style>
