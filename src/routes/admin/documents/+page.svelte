<script lang="ts">
    import { onMount } from 'svelte';
    import FileText from '@lucide/svelte/icons/file-text';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Upload from '@lucide/svelte/icons/upload';
import Loader2 from '@lucide/svelte/icons/loader-2';
import Search from '@lucide/svelte/icons/search';
import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
import ChevronLeft from '@lucide/svelte/icons/chevron-left';
import ChevronRight from '@lucide/svelte/icons/chevron-right';

    let documents: any[] = $state([]);
    let loading = $state(true);
    let isUploading = $state(false);
    let searchQuery = $state('');
    let sortField = $state('created_at');
    let sortOrder = $state<'asc' | 'desc'>('desc');
    let currentPage = $state(1);
    let pageSize = $state(10);

    onMount(async () => {
        await loadDocuments();
    });

    async function loadDocuments() {
        loading = true;
        try {
            const res = await fetch('/api/documents');
            if (res.ok) {
                documents = await res.json();
            }
        } catch (err) {
            console.error(err);
        } finally {
            loading = false;
        }
    }

    async function handleUpload(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        isUploading = true;
        try {
            const content = await file.text();
            const res = await fetch('/api/documents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, content })
            });
            if (res.ok) {
                await loadDocuments();
            }
            input.value = '';
        } catch (err) {
            console.error(err);
            alert('Upload failed');
        } finally {
            isUploading = false;
        }
    }

    async function handleDelete(id: number) {
        if (!confirm('Are you sure?')) return;
        try {
            const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
            if (res.ok) {
                await loadDocuments();
            }
        } catch (err) {
            console.error(err);
        }
    }

    function toggleSort(field: string) {
        if (sortField === field) {
            sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            sortField = field;
            sortOrder = 'asc';
        }
    }

    let filteredDocuments = $derived(
        documents
            .filter(doc => 
                doc.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (doc.repo_url && doc.repo_url.toLowerCase().includes(searchQuery.toLowerCase()))
            )
            .sort((a, b) => {
                let valA = a[sortField];
                let valB = b[sortField];
                if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
                return 0;
            })
    );

    let totalPages = $derived(Math.ceil(filteredDocuments.length / pageSize));
    let paginatedDocuments = $derived(
        filteredDocuments.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    );

    $effect(() => {
        if (currentPage > totalPages && totalPages > 0) {
            currentPage = totalPages;
        }
    });
</script>

<div class="p-6">
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
            <h1 class="page-title">Knowledge Base</h1>
            <p class="page-subtitle mt-1">Manage documents used for RAG.</p>
        </div>
        
        <label 
            class="btn btn-primary cursor-pointer"
            class:opacity-50={isUploading}
            class:pointer-events-none={isUploading}
        >
            {#if isUploading}
                <Loader2 class="w-4 h-4 animate-spin" />
                <span>Uploading...</span>
            {:else}
                <Upload class="w-5 h-5" />
                <span>Upload Document</span>
            {/if}
            <input type="file" onchange={handleUpload} accept=".txt,.md,.mdx" class="hidden" disabled={isUploading} />
        </label>
    </header>

    <div class="card overflow-hidden">
        <div class="p-6 border-b border-[var(--border-primary)] flex flex-col md:flex-row gap-4 justify-between items-center">
            <div class="relative w-full md:w-96">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
                <input 
                    type="text" 
                    bind:value={searchQuery} 
                    placeholder="Search documents..." 
                    class="field pl-10"
                />
            </div>
            
            <div class="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <span>Show</span>
                <select bind:value={pageSize} class="bg-[var(--bg-well)] border border-[var(--border-primary)] rounded-xl px-2 py-1 focus:outline-none focus:border-accent-quiet">
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                </select>
                <span>per page</span>
            </div>
        </div>

        <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-[var(--bg-muted-30)]">
                        <th class="eyebrow px-4 py-3 cursor-pointer hover:text-body transition-colors" onclick={() => toggleSort('filename')}>
                            <div class="flex items-center gap-2">
                                Filename
                                <ArrowUpDown class="w-3 h-3" />
                            </div>
                        </th>
                        <th class="eyebrow px-4 py-3 cursor-pointer hover:text-body transition-colors" onclick={() => toggleSort('repo_url')}>
                            <div class="flex items-center gap-2">
                                Source
                                <ArrowUpDown class="w-3 h-3" />
                            </div>
                        </th>
                        <th class="eyebrow px-4 py-3 cursor-pointer hover:text-body transition-colors" onclick={() => toggleSort('created_at')}>
                            <div class="flex items-center gap-2">
                                Added
                                <ArrowUpDown class="w-3 h-3" />
                            </div>
                        </th>
                        <th class="eyebrow px-4 py-3 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-[var(--border-primary)]">
                    {#if loading}
                        <tr>
                            <td colspan="4" class="p-12 text-center">
                                <Loader2 class="w-8 h-8 animate-spin mx-auto text-[var(--text-faint)]" />
                            </td>
                        </tr>
                    {:else if paginatedDocuments.length === 0}
                        <tr>
                            <td colspan="4" class="p-12 text-center text-[var(--text-faint)] italic">No documents found.</td>
                        </tr>
                    {:else}
                        {#each paginatedDocuments as doc}
                            <tr class="hover:bg-[var(--hover-surface)] transition-colors group">
                                <td class="p-6">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-[var(--bg-muted)] flex items-center justify-center text-accent">
                                            <FileText class="w-5 h-5" />
                                        </div>
                                        <span class="font-medium text-[var(--text-secondary)]">{doc.filename}</span>
                                    </div>
                                </td>
                                <td class="p-6">
                                    {#if doc.repo_url}
                                        <span class="text-xs font-mono text-[var(--text-faint)] bg-[var(--bg-well)] px-2 py-1 rounded-lg border border-[var(--border-primary)]">
                                            {doc.repo_url.split('/').pop()}
                                        </span>
                                    {:else}
                                        <span class="text-xs text-[var(--text-faintest)] italic">Manual Upload</span>
                                    {/if}
                                </td>
                                <td class="p-6">
                                    <span class="text-sm text-[var(--text-faint)]">{new Date(doc.created_at).toLocaleDateString()}</span>
                                </td>
                                <td class="p-6 text-right">
                                    <button 
                                        onclick={() => handleDelete(doc.id)}
                                        class="p-2 hover:bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] rounded-xl text-[var(--text-faint)] hover:text-danger transition-all opacity-0 group-hover:opacity-100"
                                    >
                                        <Trash2 class="w-5 h-5" />
                                    </button>
                                </td>
                            </tr>
                        {/each}
                    {/if}
                </tbody>
            </table>
        </div>

        {#if totalPages > 1}
            <div class="p-6 border-t border-[var(--border-primary)] flex items-center justify-between">
                <p class="text-sm text-[var(--text-faint)]">
                    Showing <span class="text-[var(--text-primary)] font-medium">{(currentPage - 1) * pageSize + 1}</span> to 
                    <span class="text-[var(--text-primary)] font-medium">{Math.min(currentPage * pageSize, filteredDocuments.length)}</span> of 
                    <span class="text-[var(--text-primary)] font-medium">{filteredDocuments.length}</span> documents
                </p>
                
                <div class="flex items-center gap-2">
                    <button 
                        disabled={currentPage === 1}
                        onclick={() => currentPage--}
                        class="p-2 hover:bg-[var(--hover-surface)] disabled:opacity-30 rounded-xl transition-colors"
                    >
                        <ChevronLeft class="w-5 h-5" />
                    </button>
                    
                    <div class="flex items-center gap-1">
                        {#each Array(totalPages) as _, i}
                            <button 
                                onclick={() => currentPage = i + 1}
                                class="w-8 h-8 rounded-lg text-sm font-medium transition-all
                                {currentPage === i + 1 ? 'bg-accent-solid text-accent' : 'hover:bg-[var(--hover-surface)] text-[var(--text-faint)]'}"
                            >
                                {i + 1}
                            </button>
                        {/each}
                    </div>

                    <button 
                        disabled={currentPage === totalPages}
                        onclick={() => currentPage++}
                        class="p-2 hover:bg-[var(--hover-surface)] disabled:opacity-30 rounded-xl transition-colors"
                    >
                        <ChevronRight class="w-5 h-5" />
                    </button>
                </div>
            </div>
        {/if}
    </div>
</div>
