<script lang="ts">
    /**
     * Page navigation for the server-paged knowledge lists.
     *
     * Deliberately compact: a window of page numbers around the current page plus
     * first/last, so a 80-page topic list doesn't render 80 buttons.
     */
    import ChevronLeft from '@lucide/svelte/icons/chevron-left';
    import ChevronRight from '@lucide/svelte/icons/chevron-right';

    interface Props {
        page: number;
        totalPages: number;
        total: number;
        pageSize: number;
        /** Noun for the summary line, e.g. "topics" / "claims". */
        label?: string;
        onPage: (page: number) => void;
        onPageSize?: (pageSize: number) => void;
    }

    let { page, totalPages, total, pageSize, label = 'results', onPage, onPageSize }: Props = $props();

    const PAGE_SIZES = [20, 50, 100];

    /** Current page ± 2, clamped, with `null` marking an elided run. */
    let windowed = $derived.by(() => {
        const pages: (number | null)[] = [];
        const from = Math.max(1, page - 2);
        const to = Math.min(totalPages, page + 2);
        if (from > 1) {
            pages.push(1);
            if (from > 2) pages.push(null);
        }
        for (let p = from; p <= to; p++) pages.push(p);
        if (to < totalPages) {
            if (to < totalPages - 1) pages.push(null);
            pages.push(totalPages);
        }
        return pages;
    });

    let firstOnPage = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
    let lastOnPage = $derived(Math.min(total, page * pageSize));
</script>

{#if total > 0}
    <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p class="text-xs text-faint tabular-nums">
            {firstOnPage}–{lastOnPage} of {total} {label}
        </p>

        <div class="flex items-center gap-2">
            {#if onPageSize}
                <label class="flex items-center gap-1.5">
                    <span class="eyebrow whitespace-nowrap">Per page</span>
                    <select
                        value={pageSize}
                        onchange={(e) => onPageSize?.(Number((e.currentTarget as HTMLSelectElement).value))}
                        class="field w-auto text-xs py-1"
                    >
                        {#each PAGE_SIZES as size}
                            <option value={size}>{size}</option>
                        {/each}
                    </select>
                </label>
            {/if}

            {#if totalPages > 1}
                <div class="flex items-center gap-1">
                    <button
                        class="btn btn-secondary btn-icon"
                        disabled={page <= 1}
                        onclick={() => onPage(page - 1)}
                        aria-label="Previous page"
                    >
                        <ChevronLeft class="w-3.5 h-3.5" />
                    </button>

                    {#each windowed as p}
                        {#if p === null}
                            <span class="px-1 text-xs text-faint">…</span>
                        {:else}
                            <button
                                class="btn btn-sm tabular-nums {p === page ? 'btn-secondary' : 'btn-ghost'}"
                                aria-current={p === page ? 'page' : undefined}
                                onclick={() => onPage(p)}
                            >
                                {p}
                            </button>
                        {/if}
                    {/each}

                    <button
                        class="btn btn-secondary btn-icon"
                        disabled={page >= totalPages}
                        onclick={() => onPage(page + 1)}
                        aria-label="Next page"
                    >
                        <ChevronRight class="w-3.5 h-3.5" />
                    </button>
                </div>
            {/if}
        </div>
    </div>
{/if}
