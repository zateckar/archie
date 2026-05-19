<script lang="ts">
    import { page } from '$app/state';
    import { onMount, onDestroy } from 'svelte';
    import { Editor } from '@tiptap/core';
    import { StarterKit } from '@tiptap/starter-kit';
    import { Placeholder } from '@tiptap/extension-placeholder';
    import { Link } from '@tiptap/extension-link';
    import TurndownService from 'turndown';
    import { marked } from 'marked';
    import { 
        Edit3, Eye, Save, Clock, ArrowLeft, 
        Bold, Italic, Heading1, Heading2, Heading3,
        List, ListOrdered, Code, Quote, Link as LinkIcon,
        X, RotateCcw, FileText, History, Diff, ChevronDown, ChevronUp, 
        AlertTriangle, CheckCircle, GitBranch
    } from 'lucide-svelte';

    // ─── Props ───
    let { params }: {
        params: { repoId: string; path: string };
    } = $props();

    let repoId = $derived(parseInt(params.repoId));
    let currentPath = $derived(params.path || '');

    // ─── State ───
    let content = $state('');
    let isEditing = $state(false);
    let isSaving = $state(false);
    let isLoading = $state(true);
    let showSource = $state(false);
    let showHistory = $state(false);
    let fileNotFound = $state(false);
    let historyEntries = $state<any[]>([]);
    let loadingHistory = $state(false);
    let selectedHistoryItem = $state<any | null>(null);
    let diffContent = $state<string | null>(null);
    let loadingDiff = $state(false);
    let saveMessage = $state('');

    let editorEl = $state<HTMLDivElement>();
    let editorState = $state<{ editor: Editor | null }>({ editor: null });

    const turndownService = new TurndownService({ 
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-'
    });

    // ─── Load file content ───
    async function loadContent() {
        isLoading = true;
        fileNotFound = false;
        try {
            const encodedPath = currentPath.split('/').map(encodeURIComponent).join('/');
            const res = await fetch(`/api/wiki/${repoId}/file?path=${encodedPath}`);
            if (res.ok) {
                const data = await res.json();
                content = data.content;
            } else {
                fileNotFound = true;
                content = '';
            }
        } catch (err) {
            console.error(err);
            fileNotFound = true;
        } finally {
            isLoading = false;
        }
    }

    $effect(() => {
        if (currentPath) {
            loadContent();
        }
    });

    // Clean up editor on unmount
    onDestroy(() => {
        editorState.editor?.destroy();
    });

    // Initialize editor when editing starts
    $effect(() => {
        if (isEditing && editorEl && !editorState.editor) {
            const html = marked.parse(content, { async: false }) as string;
            editorState.editor = new Editor({
                element: editorEl,
                extensions: [
                    StarterKit.configure({
                        heading: { levels: [1, 2, 3] },
                    }),
                    Placeholder.configure({
                        placeholder: 'Start writing...',
                    }),
                    Link.configure({
                        openOnClick: false,
                    }),
                ],
                content: html,
                onTransaction: () => {
                    editorState = { editor: editorState.editor };
                },
            });
        }
    });

    function startEditing() {
        isEditing = true;
        showHistory = false;
        selectedHistoryItem = null;
        diffContent = null;
    }

    function cancelEditing() {
        isEditing = false;
        showSource = false;
        editorState.editor?.destroy();
        editorState = { editor: null };
    }

    async function handleSave() {
        if (!editorState.editor) return;
        isSaving = true;
        saveMessage = '';

        // Convert HTML back to markdown
        const html = editorState.editor.getHTML();
        const markdown = turndownService.turndown(html);

        try {
            const encodedPath = currentPath.split('/').map(encodeURIComponent).join('/');
            const res = await fetch(`/api/wiki/${repoId}/file`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath, content: markdown })
            });
            if (res.ok) {
                content = markdown;
                isEditing = false;
                editorState.editor?.destroy();
                editorState = { editor: null };
                saveMessage = 'Saved successfully';
                setTimeout(() => saveMessage = '', 3000);
                // Notify layout to refresh the file tree (in case a new subdir was created)
                window.dispatchEvent(new CustomEvent('wiki:tree:refresh'));
            } else {
                const err = await res.json();
                saveMessage = 'Error: ' + (err.error || 'Save failed');
            }
        } catch (err) {
            saveMessage = 'Error: Save failed';
        } finally {
            isSaving = false;
        }
    }

    // ─── History ───
    async function loadHistory() {
        showHistory = !showHistory;
        if (showHistory && historyEntries.length === 0) {
            loadingHistory = true;
            try {
                const encodedPath = currentPath.split('/').map(encodeURIComponent).join('/');
                const res = await fetch(`/api/wiki/${repoId}/history?path=${encodedPath}`);
                if (res.ok) {
                    historyEntries = await res.json();
                }
            } catch (err) {
                console.error(err);
            } finally {
                loadingHistory = false;
            }
        }
        selectedHistoryItem = null;
        diffContent = null;
    }

    async function viewDiff(entry: any) {
        // Find the parent commit (previous in the list)
        const idx = historyEntries.indexOf(entry);
        if (idx < historyEntries.length - 1) {
            const parent = historyEntries[idx + 1];
            loadingDiff = true;
            selectedHistoryItem = entry;
            try {
                const encodedPath = currentPath.split('/').map(encodeURIComponent).join('/');
                const res = await fetch(`/api/wiki/${repoId}/diff?path=${encodedPath}&from=${parent.oid}&to=${entry.oid}`);
                if (res.ok) {
                    const data = await res.json();
                    diffContent = data.diff;
                }
            } catch (err) {
                console.error(err);
            } finally {
                loadingDiff = false;
            }
        } else {
            selectedHistoryItem = entry;
            diffContent = '(Initial commit)';
        }
    }

    async function handleRevert(oid: string) {
        if (!confirm('Revert to this version? Current changes will be overwritten.')) return;
        try {
            const encodedPath = currentPath.split('/').map(encodeURIComponent).join('/');
            const res = await fetch(`/api/wiki/${repoId}/revert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath, oid })
            });
            if (res.ok) {
                saveMessage = 'Reverted successfully';
                await loadContent();
                showHistory = false;
                setTimeout(() => saveMessage = '', 3000);
            }
        } catch (err) {
            console.error(err);
        }
    }

    // ─── Toolbar actions ───
    function execCmd(cmd: string, attr?: any) {
        if (!editorState.editor) return;
        const chain = editorState.editor.chain().focus();
        if (cmd === 'bold') chain.toggleBold().run();
        else if (cmd === 'italic') chain.toggleItalic().run();
        else if (cmd === 'h1') chain.toggleHeading({ level: 1 }).run();
        else if (cmd === 'h2') chain.toggleHeading({ level: 2 }).run();
        else if (cmd === 'h3') chain.toggleHeading({ level: 3 }).run();
        else if (cmd === 'bulletList') chain.toggleBulletList().run();
        else if (cmd === 'orderedList') chain.toggleOrderedList().run();
        else if (cmd === 'codeBlock') chain.toggleCodeBlock().run();
        else if (cmd === 'blockquote') chain.toggleBlockquote().run();
        else if (cmd === 'link') {
            const url = prompt('Enter URL:');
            if (url) chain.setLink({ href: url }).run();
        }
    }

    // ─── Derived ───
    let renderedContent = $derived.by(() => {
        if (!content) return '';
        try {
            return marked.parse(content, { async: false }) as string;
        } catch {
            return content;
        }
    });

    let filename = $derived(currentPath.split('/').pop() || 'document');
</script>

<div class="h-full flex flex-col">
    <!-- Toolbar -->
    <header class="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/50 backdrop-blur-sm">
        <div class="flex items-center gap-3 min-w-0">
            <a href={`/wiki/${repoId}`} class="p-1.5 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-white transition-all flex-shrink-0" title="Back to repo root">
                <ArrowLeft class="w-4 h-4" />
            </a>
            <div class="flex items-center gap-2 min-w-0">
                <FileText class="w-4 h-4 text-slate-500 flex-shrink-0" />
                <h2 class="font-bold text-white text-sm truncate">{filename}</h2>
            </div>
            {#if saveMessage}
                <span class="text-xs text-[#78FAAE] animate-in fade-in">{saveMessage}</span>
            {/if}
        </div>

        <div class="flex items-center gap-2">
            {#if !isEditing}
                <button onclick={startEditing} class="flex items-center gap-1.5 px-4 py-2 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 rounded-xl text-xs font-bold transition-all">
                    <Edit3 class="w-3.5 h-3.5" />
                    Edit
                </button>
                <button onclick={loadHistory} class="flex items-center gap-1.5 px-3 py-2 hover:bg-slate-800 rounded-xl text-xs font-bold transition-all text-slate-400" class:bg-slate-800={showHistory}>
                    <Clock class="w-3.5 h-3.5" />
                    History
                </button>
            {:else}
                <button onclick={() => showSource = !showSource} class="px-3 py-2 hover:bg-slate-800 rounded-xl text-xs font-bold transition-all text-slate-400" class:bg-slate-800={showSource}>
                    {showSource ? 'WYSIWYG' : 'Source'}
                </button>
                <button onclick={cancelEditing} class="px-3 py-2 hover:bg-slate-800 rounded-xl text-xs font-bold transition-all text-slate-400">
                    Cancel
                </button>
                <button onclick={handleSave} disabled={isSaving} class="flex items-center gap-1.5 px-4 py-2 bg-[#78FAAE] hover:bg-[#78FAAE]/80 text-black rounded-xl text-xs font-bold transition-all disabled:opacity-50">
                    {#if isSaving}
                        <div class="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin"></div>
                        Saving...
                    {:else}
                        <Save class="w-3.5 h-3.5" />
                        Save
                    {/if}
                </button>
            {/if}
        </div>
    </header>

    <!-- Editor toolbar (when editing) -->
    {#if isEditing && !showSource}
        <div class="flex items-center gap-1 px-4 py-2 border-b border-slate-800 bg-slate-900/30 overflow-x-auto">
            <button onclick={() => execCmd('bold')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('bold')} title="Bold"><Bold class="w-4 h-4" /></button>
            <button onclick={() => execCmd('italic')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('italic')} title="Italic"><Italic class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-slate-700 mx-1"></span>
            <button onclick={() => execCmd('h1')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all text-xs font-bold" class:bg-slate-800={editorState.editor?.isActive('heading', { level: 1 })} title="Heading 1"><Heading1 class="w-4 h-4" /></button>
            <button onclick={() => execCmd('h2')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all text-xs font-bold" class:bg-slate-800={editorState.editor?.isActive('heading', { level: 2 })} title="Heading 2"><Heading2 class="w-4 h-4" /></button>
            <button onclick={() => execCmd('h3')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all text-xs font-bold" class:bg-slate-800={editorState.editor?.isActive('heading', { level: 3 })} title="Heading 3"><Heading3 class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-slate-700 mx-1"></span>
            <button onclick={() => execCmd('bulletList')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('bulletList')} title="Bullet List"><List class="w-4 h-4" /></button>
            <button onclick={() => execCmd('orderedList')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('orderedList')} title="Numbered List"><ListOrdered class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-slate-700 mx-1"></span>
            <button onclick={() => execCmd('codeBlock')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('codeBlock')} title="Code Block"><Code class="w-4 h-4" /></button>
            <button onclick={() => execCmd('blockquote')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('blockquote')} title="Blockquote"><Quote class="w-4 h-4" /></button>
            <button onclick={() => execCmd('link')} class="p-1.5 hover:bg-slate-800 rounded-lg transition-all" class:bg-slate-800={editorState.editor?.isActive('link')} title="Link"><LinkIcon class="w-4 h-4" /></button>
        </div>
    {/if}

    <!-- Content area -->
    <div class="flex-1 flex overflow-hidden">
        <!-- Main content -->
        <div class="flex-1 overflow-y-auto">
            {#if isLoading}
                <div class="flex items-center justify-center h-full">
                    <div class="w-8 h-8 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
                </div>
            {:else if fileNotFound}
                <div class="flex flex-col items-center justify-center h-full gap-4 text-slate-500">
                    <FileText class="w-16 h-16 text-slate-700" />
                    <p class="text-lg">File not found</p>
                    <p class="text-sm text-slate-600">The requested document doesn't exist in this repository.</p>
                </div>
            {:else if !isEditing}
                <!-- View mode -->
                <div class="h-full p-8">
                    <div class="prose prose-invert prose-headings:text-white prose-a:text-[#78FAAE] prose-strong:text-white prose-code:text-[#78FAAE] prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-800 prose-blockquote:border-[#78FAAE] prose-blockquote:text-slate-400 max-w-none">
                        {@html renderedContent}
                    </div>
                </div>
            {:else if showSource}
                <!-- Raw markdown editing -->
                <div class="h-full p-8">
                    <textarea 
                        class="w-full h-full bg-transparent border-none outline-none text-sm font-mono text-slate-300 resize-none"
                        value={(() => {
                            if (editorState.editor) {
                                return turndownService.turndown(editorState.editor.getHTML());
                            }
                            return content;
                        })()}
                        oninput={(e) => {
                            if (editorState.editor) {
                                const md = (e.target as HTMLTextAreaElement).value;
                                const html = marked.parse(md, { async: false }) as string;
                                editorState.editor.commands.setContent(html);
                            }
                        }}
                    ></textarea>
                </div>
            {:else}
                <!-- WYSIWYG editor -->
                <div class="h-full p-8">
                    <div bind:this={editorEl} class="prose prose-invert prose-headings:text-white prose-a:text-[#78FAAE] prose-strong:text-white prose-code:text-[#78FAAE] prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-800 prose-blockquote:border-[#78FAAE] prose-blockquote:text-slate-400 max-w-none h-full outline-none"></div>
                </div>
            {/if}
        </div>

        <!-- History sidebar -->
        {#if showHistory}
            <aside class="w-80 border-l border-slate-800 bg-slate-950/50 overflow-y-auto flex-shrink-0">
                <div class="p-4 border-b border-slate-800 flex items-center justify-between">
                    <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                        <Clock class="w-3.5 h-3.5" />
                        History
                    </h3>
                    <button onclick={() => { showHistory = false; selectedHistoryItem = null; diffContent = null; }} class="p-1 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-white transition-all">
                        <X class="w-4 h-4" />
                    </button>
                </div>

                {#if loadingHistory}
                    <div class="flex items-center justify-center py-8">
                        <div class="w-5 h-5 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
                    </div>
                {:else if historyEntries.length === 0}
                    <p class="text-sm text-slate-600 italic p-4">No history available.</p>
                {:else}
                    <div class="p-3 space-y-2">
                        {#each historyEntries as entry}
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div
                                role="button"
                                tabindex="0"
                                onkeydown={(e) => e.key === 'Enter' && viewDiff(entry)}
                                class={"w-full p-3 rounded-xl transition-all cursor-pointer border " + (selectedHistoryItem?.oid === entry.oid ? 'border-[#78FAAE]/40' : 'border-slate-800 hover:border-slate-700')}
                                onclick={() => viewDiff(entry)}
                            >
                                <div class="flex items-start justify-between gap-2">
                                    <div class="min-w-0">
                                        <p class="text-xs font-mono text-slate-500 mb-1">{entry.oid.slice(0, 7)}</p>
                                        <p class="text-sm text-slate-200 truncate">{entry.message}</p>
                                        <p class="text-[10px] text-slate-600 mt-1">
                                            {entry.author} · {new Date(entry.date).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <button 
                                        onclick={(e) => { e.stopPropagation(); handleRevert(entry.oid); }}
                                        class="p-1 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-[#78FAAE] transition-all flex-shrink-0"
                                        title="Revert to this version"
                                    >
                                        <RotateCcw class="w-3.5 h-3.5" />
                                    </button>
                                </div>

                                {#if selectedHistoryItem?.oid === entry.oid && diffContent !== null}
                                    <div class="mt-3 pt-3 border-t border-slate-800">
                                        {#if loadingDiff}
                                            <div class="flex items-center justify-center py-4">
                                                <div class="w-4 h-4 border-2 border-[#78FAAE]/20 border-t-[#78FAAE] rounded-full animate-spin"></div>
                                            </div>
                                        {:else if diffContent === '(Initial commit)'}
                                            <p class="text-xs text-slate-500 italic">Initial version</p>
                                        {:else}
                                            <pre class="text-[11px] font-mono text-slate-400 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">{diffContent}</pre>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
            </aside>
        {/if}
    </div>
</div>

<!-- Tippy styling for placeholder -->
<style>
    :global(.tiptap p.is-editor-empty:first-child::before) {
        color: #475569;
        content: attr(data-placeholder);
        float: left;
        height: 0;
        pointer-events: none;
    }
    :global(.tiptap) {
        outline: none;
        min-height: 100%;
    }
    :global(.tiptap h1) { font-size: 1.875rem; font-weight: 700; margin-bottom: 0.75rem; }
    :global(.tiptap h2) { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    :global(.tiptap h3) { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    :global(.tiptap p) { margin-bottom: 0.5rem; }
    :global(.tiptap ul), :global(.tiptap ol) { padding-left: 1.5rem; margin-bottom: 0.5rem; }
    :global(.tiptap li) { margin-bottom: 0.25rem; }
    :global(.tiptap pre) { background: #0f172a; padding: 0.75rem; border-radius: 0.75rem; border: 1px solid #1e293b; margin-bottom: 0.5rem; }
    :global(.tiptap code) { font-size: 0.875rem; }
    :global(.tiptap blockquote) { border-left: 3px solid #78FAAE; padding-left: 1rem; color: #94a3b8; margin-bottom: 0.5rem; }
    :global(.tiptap a) { color: #78FAAE; text-decoration: underline; }
</style>