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
            class="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-sm"
            aria-label="Close source results"
            onclick={onClose}
        ></button>

        <!-- panel -->
        <aside
            class="relative w-full max-w-md h-full bg-surface border-l border-line shadow-xl flex flex-col"
            transition:fly={{ x: 400, duration: 200 }}
        >
            <header class="p-4 border-b border-line-subtle flex items-start gap-3">
                <div class="min-w-0 flex-1">
                    <p class="eyebrow">Source documents</p>
                    <p class="text-[13px] text-body truncate mt-1" title={query}>“{query}”</p>
                </div>
                <button class="btn btn-ghost btn-icon" onclick={onClose} aria-label="Close">
                    <X class="w-4 h-4" />
                </button>
            </header>

            <div class="flex-1 overflow-y-auto p-4 space-y-2.5">
                {#if loading}
                    <div class="flex items-center justify-center py-16">
                        <div class="spinner w-6 h-6"></div>
                    </div>
                {:else if error}
                    <p class="text-[13px] text-danger text-center py-10">{error}</p>
                {:else if !hasSources}
                    <div class="flex flex-col items-center gap-2 py-16 text-center">
                        <FileText class="w-8 h-8 text-ghost" />
                        <p class="text-[13px] text-mute">This answer cites no source documents.</p>
                        <p class="text-xs text-faint">There is nothing to trace this selection back to.</p>
                    </div>
                {:else if results.length === 0}
                    <div class="flex flex-col items-center gap-2 py-16 text-center">
                        <FileText class="w-8 h-8 text-ghost" />
                        <p class="text-[13px] text-mute">Not found in this answer's sources.</p>
                        <p class="text-xs text-faint">Try selecting a more distinctive phrase.</p>
                    </div>
                {:else}
                    <p class="text-xs text-faint px-0.5 pb-1">
                        Found in {results.length} source document{results.length === 1 ? '' : 's'}
                    </p>
                    {#each results as m (m.doc_id)}
                        {@const url = wikiUrl(m)}
                        <div class="well card-hover p-3.5">
                            <div class="flex items-center gap-2 mb-2">
                                <FileText class="w-3.5 h-3.5 text-faint flex-shrink-0" />
                                <span class="text-xs font-mono text-body truncate" title={m.path || m.filename}>
                                    {m.filename}
                                </span>
                                <span class="chip chip-accent ml-auto flex-shrink-0 text-[11px]">
                                    {m.matches} hit{m.matches === 1 ? '' : 's'}
                                </span>
                            </div>
                            <p class="text-xs text-mute leading-relaxed src-snippet">
                                {@html renderSnippet(m.snippet)}
                            </p>
                            {#if url}
                                <a
                                    href={url}
                                    class="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
                                >
                                    Open and review
                                    <ExternalLink class="w-3 h-3" />
                                </a>
                            {:else}
                                <p class="mt-3 text-xs text-faint">Not linked to an editable wiki file</p>
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
        background: color-mix(in oklab, var(--accent) 26%, transparent);
        color: var(--text-strong);
        border-radius: 3px;
        padding: 0 2px;
        font-weight: 600;
    }
</style>
