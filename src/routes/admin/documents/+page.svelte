<script lang="ts">
    import { onMount } from 'svelte';
    import { FileText, Trash2, Upload, Loader2, Search, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-svelte';

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

<div class="p-8">
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
            <h1 class="text-3xl font-bold text-white mb-2">Knowledge Base</h1>
            <p class="text-slate-400">Manage documents used for RAG.</p>
        </div>
        
        <label 
            class="flex items-center justify-center gap-2 px-6 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 rounded-2xl font-bold transition-all cursor-pointer shadow-lg shadow-[#0E3A2F]/20"
            class:opacity-50={isUploading}
            class:pointer-events-none={isUploading}
        >
            {#if isUploading}
                <Loader2 class="w-5 h-5 animate-spin" />
                <span>Uploading...</span>
            {:else}
                <Upload class="w-5 h-5" />
                <span>Upload Document</span>
            {/if}
            <input type="file" onchange={handleUpload} accept=".txt,.md,.mdx" class="hidden" disabled={isUploading} />
        </label>
    </header>

    <div class="bg-slate-900 border border-slate-800 rounded-3xl shadow-xl overflow-hidden">
        <div class="p-6 border-b border-slate-800 flex flex-col md:flex-row gap-4 justify-between items-center">
            <div class="relative w-full md:w-96">
                <Search class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input 
                    type="text" 
                    bind:value={searchQuery} 
                    placeholder="Search documents..." 
                    class="w-full bg-slate-950 border border-slate-800 rounded-2xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-[#78FAAE]/50 transition-all"
                />
            </div>
            
            <div class="flex items-center gap-2 text-sm text-slate-400">
                <span>Show</span>
                <select bind:value={pageSize} class="bg-slate-950 border border-slate-800 rounded-xl px-2 py-1 focus:outline-none focus:border-[#78FAAE]/50">
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
                    <tr class="bg-slate-800/30">
                        <th class="p-6 text-xs font-bold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-white transition-colors" onclick={() => toggleSort('filename')}>
                            <div class="flex items-center gap-2">
                                Filename
                                <ArrowUpDown class="w-3 h-3" />
                            </div>
                        </th>
                        <th class="p-6 text-xs font-bold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-white transition-colors" onclick={() => toggleSort('repo_url')}>
                            <div class="flex items-center gap-2">
                                Source
                                <ArrowUpDown class="w-3 h-3" />
                            </div>
                        </th>
                        <th class="p-6 text-xs font-bold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-white transition-colors" onclick={() => toggleSort('created_at')}>
                            <div class="flex items-center gap-2">
                                Added
                                <ArrowUpDown class="w-3 h-3" />
                            </div>
                        </th>
                        <th class="p-6 text-xs font-bold text-slate-400 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-800">
                    {#if loading}
                        <tr>
                            <td colspan="4" class="p-12 text-center">
                                <Loader2 class="w-8 h-8 animate-spin mx-auto text-slate-500" />
                            </td>
                        </tr>
                    {:else if paginatedDocuments.length === 0}
                        <tr>
                            <td colspan="4" class="p-12 text-center text-slate-500 italic">No documents found.</td>
                        </tr>
                    {:else}
                        {#each paginatedDocuments as doc}
                            <tr class="hover:bg-slate-800/20 transition-colors group">
                                <td class="p-6">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-[#78FAAE]">
                                            <FileText class="w-5 h-5" />
                                        </div>
                                        <span class="font-medium text-slate-200">{doc.filename}</span>
                                    </div>
                                </td>
                                <td class="p-6">
                                    {#if doc.repo_url}
                                        <span class="text-xs font-mono text-slate-500 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
                                            {doc.repo_url.split('/').pop()}
                                        </span>
                                    {:else}
                                        <span class="text-xs text-slate-600 italic">Manual Upload</span>
                                    {/if}
                                </td>
                                <td class="p-6">
                                    <span class="text-sm text-slate-500">{new Date(doc.created_at).toLocaleDateString()}</span>
                                </td>
                                <td class="p-6 text-right">
                                    <button 
                                        onclick={() => handleDelete(doc.id)}
                                        class="p-2 hover:bg-red-900/30 rounded-xl text-slate-500 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100"
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
            <div class="p-6 border-t border-slate-800 flex items-center justify-between">
                <p class="text-sm text-slate-500">
                    Showing <span class="text-white font-medium">{(currentPage - 1) * pageSize + 1}</span> to 
                    <span class="text-white font-medium">{Math.min(currentPage * pageSize, filteredDocuments.length)}</span> of 
                    <span class="text-white font-medium">{filteredDocuments.length}</span> documents
                </p>
                
                <div class="flex items-center gap-2">
                    <button 
                        disabled={currentPage === 1}
                        onclick={() => currentPage--}
                        class="p-2 hover:bg-slate-800 disabled:opacity-30 rounded-xl transition-colors"
                    >
                        <ChevronLeft class="w-5 h-5" />
                    </button>
                    
                    <div class="flex items-center gap-1">
                        {#each Array(totalPages) as _, i}
                            <button 
                                onclick={() => currentPage = i + 1}
                                class="w-8 h-8 rounded-lg text-sm font-medium transition-all
                                {currentPage === i + 1 ? 'bg-[#0E3A2F] text-white' : 'hover:bg-slate-800 text-slate-500'}"
                            >
                                {i + 1}
                            </button>
                        {/each}
                    </div>

                    <button 
                        disabled={currentPage === totalPages}
                        onclick={() => currentPage++}
                        class="p-2 hover:bg-slate-800 disabled:opacity-30 rounded-xl transition-colors"
                    >
                        <ChevronRight class="w-5 h-5" />
                    </button>
                </div>
            </div>
        {/if}
    </div>
</div>
