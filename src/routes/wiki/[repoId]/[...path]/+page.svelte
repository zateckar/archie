<script lang="ts">
    import { page } from '$app/state';
    import { onMount, onDestroy } from 'svelte';
    import { Editor } from '@tiptap/core';
    import { StarterKit } from '@tiptap/starter-kit';
    import { Placeholder } from '@tiptap/extension-placeholder';
    import { Link } from '@tiptap/extension-link';
    import TurndownService from 'turndown';
    import { marked } from 'marked';
    import { renderMermaidBlocksIn } from '$lib/utils/mermaidRender';
    import { highlightText } from '$lib/utils/highlight';
    import MermaidEditorModal from '$lib/components/MermaidEditorModal.svelte';
    import Edit3 from '@lucide/svelte/icons/edit-3';
import Eye from '@lucide/svelte/icons/eye';
import Save from '@lucide/svelte/icons/save';
import Clock from '@lucide/svelte/icons/clock';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import Bold from '@lucide/svelte/icons/bold';
import Italic from '@lucide/svelte/icons/italic';
import Heading1 from '@lucide/svelte/icons/heading-1';
import Heading2 from '@lucide/svelte/icons/heading-2';
import Heading3 from '@lucide/svelte/icons/heading-3';
import List from '@lucide/svelte/icons/list';
import ListOrdered from '@lucide/svelte/icons/list-ordered';
import Code from '@lucide/svelte/icons/code';
import Quote from '@lucide/svelte/icons/quote';
import LinkIcon from '@lucide/svelte/icons/link';
import X from '@lucide/svelte/icons/x';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import FileText from '@lucide/svelte/icons/file-text';
import History from '@lucide/svelte/icons/history';
import Diff from '@lucide/svelte/icons/diff';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
import CheckCircle from '@lucide/svelte/icons/check-circle';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Workflow from '@lucide/svelte/icons/workflow';

    // ─── Props ───
    let { params, data }: {
        params: { repoId: string; path: string };
        data: { user: any };
    } = $props();

    let repoId = $derived(parseInt(params.repoId));
    let currentPath = $derived(params.path || '');
    let user = $derived(data?.user);
    let canEdit = $derived(user?.role === 'admin' || user?.role === 'contributor');

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
    // IMPORTANT: the TipTap Editor must NOT be stored in a deep `$state`.
    // Svelte 5 wraps `$state` values in a reactive Proxy, and proxying the
    // Editor breaks ProseMirror's internal view/state so live edits never reach
    // the instance — `getHTML()` then returns the original content and every
    // save commits the OLD document. Keep the instance in a plain (non-reactive)
    // variable and drive toolbar reactivity via a separate `editorTick` counter.
    let editor: Editor | null = null;
    let editorTick = $state(0);
    let viewContainerEl = $state<HTMLDivElement>();
    let mermaidModalOpen = $state(false);

    const turndownService = new TurndownService({ 
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-'
    });

    // Preserve language tags on fenced code blocks (e.g. ```mermaid).
    // The default Turndown rule strips the `language-*` class.
    turndownService.addRule('fencedCodeWithLang', {
        filter: (node: any) =>
            node.nodeName === 'PRE' &&
            node.firstChild &&
            node.firstChild.nodeName === 'CODE',
        replacement: (_content: string, node: any) => {
            const code = node.firstChild as HTMLElement;
            const className = code.getAttribute('class') || '';
            const langMatch = className.match(/language-(\S+)/);
            const lang = langMatch ? langMatch[1] : '';
            const text = code.textContent || '';
            const fence = '```';
            return '\n\n' + fence + lang + '\n' + text.replace(/\n$/, '') + '\n' + fence + '\n\n';
        }
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
        editor?.destroy();
        editor = null;
    });

    // Initialize editor when editing starts. We intentionally read only
    // `isEditing` and `editorEl` reactively (not `editor`, which is a plain
    // variable) so this effect does not re-run on every keystroke.
    $effect(() => {
        if (isEditing && editorEl && !editor) {
            const html = marked.parse(content, { async: false }) as string;
            editor = new Editor({
                element: editorEl,
                extensions: [
                    StarterKit.configure({
                        heading: { levels: [1, 2, 3] },
                        link: false,
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
                    // Bump a reactive counter so toolbar active-states refresh,
                    // without making the Editor itself reactive.
                    editorTick++;
                },
            });
            // Trigger initial toolbar state render.
            editorTick++;
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
        editor?.destroy();
        editor = null;
    }

    async function handleSave() {
        if (!editor) return;
        isSaving = true;
        saveMessage = '';

        // Convert HTML back to markdown
        const html = editor.getHTML();
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
                editor?.destroy();
                editor = null;
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
        if (!editor) return;
        const chain = editor.chain().focus();
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

    // Toolbar active-state helper. Reading `editorTick` makes callers re-evaluate
    // on every editor transaction, even though `editor` itself is not reactive.
    function isActive(name: string, attrs?: Record<string, any>): boolean {
        void editorTick; // reactive dependency
        return editor?.isActive(name, attrs as any) ?? false;
    }

    // ─── Mermaid post-render ───
    // After the view-mode markdown is injected via {@html}, replace fenced
    // mermaid code blocks with rendered SVGs.
    $effect(() => {
        // Re-run whenever rendered content or editing state changes.
        const _content = renderedContent;
        const _editing = isEditing;
        if (_editing) return;
        if (!viewContainerEl) return;
        if (!_content) return;
        // Defer one microtask so the {@html} has actually painted.
        queueMicrotask(() => {
            if (viewContainerEl && !isEditing) {
                renderMermaidBlocksIn(viewContainerEl);
            }
        });
    });

    // ─── Highlight sentences matching ?highlight= (from chat "Find sources") ───
    let highlightQuery = $derived(page.url.searchParams.get('highlight') || '');
    $effect(() => {
        const _content = renderedContent;
        const _editing = isEditing;
        const _q = highlightQuery;
        if (_editing) return;
        if (!viewContainerEl) return;
        if (!_content) return;
        if (!_q) return;
        // Defer so {@html} (and mermaid) have painted first.
        queueMicrotask(() => {
            if (!viewContainerEl || isEditing) return;
            const firstMark = highlightText(viewContainerEl, _q);
            if (firstMark) {
                firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    });

    // ─── Mermaid editor modal ───
    function openMermaidModal() {
        mermaidModalOpen = true;
    }

    function insertMermaidDiagram(code: string) {
        if (!editor) return;
        // Insert a fenced code block with language=mermaid.
        editor
            .chain()
            .focus()
            .insertContent({
                type: 'codeBlock',
                attrs: { language: 'mermaid' },
                content: [{ type: 'text', text: code }]
            })
            .run();
        mermaidModalOpen = false;
    }
</script>

<div class="h-full flex flex-col">
    <!-- Toolbar -->
    <header class="p-4 border-b border-[var(--border-primary)] flex items-center justify-between bg-[var(--bg-well)]/50 backdrop-blur-sm">
        <div class="flex items-center gap-3 min-w-0">
            <a href={`/wiki/${repoId}`} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all flex-shrink-0" title="Back to repo root">
                <ArrowLeft class="w-4 h-4" />
            </a>
            <div class="flex items-center gap-2 min-w-0">
                <FileText class="w-4 h-4 text-[var(--text-faint)] flex-shrink-0" />
                <h2 class="font-bold text-[var(--text-primary)] text-sm truncate">{filename}</h2>
            </div>
            {#if saveMessage}
                <span class="text-xs text-accent animate-in fade-in">{saveMessage}</span>
            {/if}
        </div>

        <div class="flex items-center gap-2">
            {#if !isEditing}
                {#if canEdit}
                    <button onclick={startEditing} class="btn btn-primary btn-sm">
                        <Edit3 class="w-3.5 h-3.5" />
                        Edit
                    </button>
                {/if}
                <button onclick={loadHistory} class="flex items-center gap-1.5 px-3 py-2 hover:bg-[var(--hover-surface)] rounded-xl text-xs font-bold transition-all text-[var(--text-muted)]" class:bg-[var(--hover-surface)]={showHistory}>
                    <Clock class="w-3.5 h-3.5" />
                    History
                </button>
            {:else}
                <button onclick={() => showSource = !showSource} class="px-3 py-2 hover:bg-[var(--hover-surface)] rounded-xl text-xs font-bold transition-all text-[var(--text-muted)]" class:bg-[var(--hover-surface)]={showSource}>
                    {showSource ? 'WYSIWYG' : 'Source'}
                </button>
                <button onclick={cancelEditing} class="px-3 py-2 hover:bg-[var(--hover-surface)] rounded-xl text-xs font-bold transition-all text-[var(--text-muted)]">
                    Cancel
                </button>
                <button onclick={handleSave} disabled={isSaving} class="btn btn-primary btn-sm">
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
        <div class="flex items-center gap-1 px-4 py-2 border-b border-[var(--border-primary)] bg-[var(--bg-page)]/30 overflow-x-auto">
            <button onclick={() => execCmd('bold')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('bold')} title="Bold"><Bold class="w-4 h-4" /></button>
            <button onclick={() => execCmd('italic')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('italic')} title="Italic"><Italic class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-[var(--border-hover)] mx-1"></span>
            <button onclick={() => execCmd('h1')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all text-xs font-bold" class:bg-[var(--hover-surface)]={isActive('heading', { level: 1 })} title="Heading 1"><Heading1 class="w-4 h-4" /></button>
            <button onclick={() => execCmd('h2')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all text-xs font-bold" class:bg-[var(--hover-surface)]={isActive('heading', { level: 2 })} title="Heading 2"><Heading2 class="w-4 h-4" /></button>
            <button onclick={() => execCmd('h3')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all text-xs font-bold" class:bg-[var(--hover-surface)]={isActive('heading', { level: 3 })} title="Heading 3"><Heading3 class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-[var(--border-hover)] mx-1"></span>
            <button onclick={() => execCmd('bulletList')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('bulletList')} title="Bullet List"><List class="w-4 h-4" /></button>
            <button onclick={() => execCmd('orderedList')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('orderedList')} title="Numbered List"><ListOrdered class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-[var(--border-hover)] mx-1"></span>
            <button onclick={() => execCmd('codeBlock')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('codeBlock')} title="Code Block"><Code class="w-4 h-4" /></button>
            <button onclick={() => execCmd('blockquote')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('blockquote')} title="Blockquote"><Quote class="w-4 h-4" /></button>
            <button onclick={() => execCmd('link')} class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg transition-all" class:bg-[var(--hover-surface)]={isActive('link')} title="Link"><LinkIcon class="w-4 h-4" /></button>
            <span class="w-px h-5 bg-[var(--border-hover)] mx-1"></span>
            <button onclick={openMermaidModal} class="btn btn-ghost btn-icon text-accent" title="Insert Mermaid diagram"><Workflow class="w-4 h-4" /></button>
        </div>
    {/if}

    <!-- Content area -->
    <div class="flex-1 flex overflow-hidden">
        <!-- Main content -->
        <div class="flex-1 overflow-y-auto">
            {#if isLoading}
                <div class="flex items-center justify-center h-full">
                    <div class="spinner w-7 h-7"></div>
                </div>
            {:else if fileNotFound}
                <div class="flex flex-col items-center justify-center h-full gap-4 text-[var(--text-faint)]">
                    <FileText class="w-16 h-16 text-ghost" />
                    <p class="text-lg">File not found</p>
                    <p class="text-sm text-[var(--text-faintest)]">The requested document doesn't exist in this repository.</p>
                </div>
            {:else if !isEditing}
                <!-- View mode -->
                <div class="h-full p-8">
                    <div bind:this={viewContainerEl} class="wiki-prose prose prose-invert prose-headings:text-[var(--text-primary)] prose-a:text-[var(--code-text)] prose-strong:text-[var(--text-primary)] prose-code:text-[var(--code-text)] prose-pre:bg-[var(--bg-page)] prose-pre:border prose-pre:border-[var(--border-primary)] prose-blockquote:border-[var(--code-text)] prose-blockquote:text-[var(--text-muted)] max-w-none">
                        {@html renderedContent}
                    </div>
                </div>
            {:else if showSource}
                <!-- Raw markdown editing -->
                <div class="h-full p-8">
                    <textarea 
                        class="w-full h-full bg-transparent border-none outline-none text-sm font-mono text-[var(--text-secondary)] resize-none"
                        value={(() => {
                            void editorTick; // re-read when the editor changes
                            if (editor) {
                                return turndownService.turndown(editor.getHTML());
                            }
                            return content;
                        })()}
                        oninput={(e) => {
                            if (editor) {
                                const md = (e.target as HTMLTextAreaElement).value;
                                const html = marked.parse(md, { async: false }) as string;
                                editor.commands.setContent(html);
                            }
                        }}
                    ></textarea>
                </div>
            {:else}
                <!-- WYSIWYG editor -->
                <div class="h-full p-8">
                    <div bind:this={editorEl} class="wiki-prose prose prose-invert prose-headings:text-[var(--text-primary)] prose-a:text-[var(--code-text)] prose-strong:text-[var(--text-primary)] prose-code:text-[var(--code-text)] prose-pre:bg-[var(--bg-page)] prose-pre:border prose-pre:border-[var(--border-primary)] prose-blockquote:border-[var(--code-text)] prose-blockquote:text-[var(--text-muted)] max-w-none h-full outline-none"></div>
                </div>
            {/if}
        </div>

        <!-- History sidebar -->
        {#if showHistory}
            <aside class="w-80 border-l border-[var(--border-primary)] bg-[var(--bg-well)]/50 overflow-y-auto flex-shrink-0">
                <div class="p-4 border-b border-[var(--border-primary)] flex items-center justify-between">
                    <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                        <Clock class="w-3.5 h-3.5" />
                        History
                    </h3>
                    <button onclick={() => { showHistory = false; selectedHistoryItem = null; diffContent = null; }} class="p-1 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-[var(--text-primary)] transition-all">
                        <X class="w-4 h-4" />
                    </button>
                </div>

                {#if loadingHistory}
                    <div class="flex items-center justify-center py-8">
                        <div class="spinner w-5 h-5"></div>
                    </div>
                {:else if historyEntries.length === 0}
                    <p class="text-sm text-[var(--text-faintest)] italic p-4">No history available.</p>
                {:else}
                    <div class="p-3 space-y-2">
                        {#each historyEntries as entry}
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div
                                role="button"
                                tabindex="0"
                                onkeydown={(e) => e.key === 'Enter' && viewDiff(entry)}
                                class={"w-full p-3 rounded-xl transition-all cursor-pointer border " + (selectedHistoryItem?.oid === entry.oid ? 'border-[color-mix(in_oklab,var(--accent)_30%,transparent)]' : 'border-[var(--border-primary)] hover:border-[var(--border-hover)]')}
                                onclick={() => viewDiff(entry)}
                            >
                                <div class="flex items-start justify-between gap-2">
                                    <div class="min-w-0">
                                        <p class="text-xs font-mono text-[var(--text-faint)] mb-1">{entry.oid.slice(0, 7)}</p>
                                        <p class="text-sm text-[var(--text-secondary)] truncate">{entry.message}</p>
                                        <p class="text-[11px] text-[var(--text-faintest)] mt-1">
                                            {entry.author} · {new Date(entry.date).toLocaleDateString()}
                                        </p>
                                    </div>
                                    {#if canEdit}
                                        <button 
                                            onclick={(e) => { e.stopPropagation(); handleRevert(entry.oid); }}
                                            class="p-1 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-faint)] hover:text-accent transition-all flex-shrink-0"
                                            title="Revert to this version"
                                        >
                                            <RotateCcw class="w-3.5 h-3.5" />
                                        </button>
                                    {/if}
                                </div>

                                {#if selectedHistoryItem?.oid === entry.oid && diffContent !== null}
                                    <div class="mt-3 pt-3 border-t border-[var(--border-primary)]">
                                        {#if loadingDiff}
                                            <div class="flex items-center justify-center py-4">
                                                <div class="spinner w-4 h-4"></div>
                                            </div>
                                        {:else if diffContent === '(Initial commit)'}
                                            <p class="text-xs text-[var(--text-faint)] italic">Initial version</p>
                                        {:else}
                                            <pre class="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">{diffContent}</pre>
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

<MermaidEditorModal
    open={mermaidModalOpen}
    onInsert={insertMermaidDiagram}
    onClose={() => mermaidModalOpen = false}
/>

<!-- Tippy styling for placeholder -->
<style>
    :global(.tiptap p.is-editor-empty:first-child::before) {
        color: var(--text-faintest);
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
    :global(.tiptap pre) { background: var(--bg-well); padding: 0.75rem; border-radius: 0.75rem; border: 1px solid var(--border-primary); margin-bottom: 0.5rem; }
    :global(.tiptap code) { font-size: 0.875rem; }
    :global(.tiptap blockquote) { border-left: 2px solid var(--accent-quiet); padding-left: 1rem; color: var(--text-muted); margin-bottom: 0.5rem; }
    :global(.tiptap a) { color: var(--accent-quiet); text-decoration: underline; }

    /* Tailwind Typography ships a very airy rhythm (1.75 line-height, 1.25em
       paragraph gaps) which reads like double-spacing in a wiki document.
       Tighten it for both the rendered view and the editor so they match.
       Declared after the .tiptap rules above so it wins on source order. */
    :global(.wiki-prose.prose) { line-height: 1.55; }
    :global(.wiki-prose p),
    :global(.wiki-prose li),
    :global(.wiki-prose blockquote),
    :global(.wiki-prose td),
    :global(.wiki-prose th) { line-height: 1.55; }
    :global(.wiki-prose p) { margin-top: 0.7em; margin-bottom: 0.7em; }
    :global(.wiki-prose ul), :global(.wiki-prose ol) { margin-top: 0.7em; margin-bottom: 0.7em; }
    :global(.wiki-prose li) { margin-top: 0.2em; margin-bottom: 0.2em; }
    :global(.wiki-prose li > p) { margin-top: 0.2em; margin-bottom: 0.2em; }
    :global(.wiki-prose h1) { margin-top: 1.2em; margin-bottom: 0.5em; line-height: 1.2; }
    :global(.wiki-prose h2) { margin-top: 1.1em; margin-bottom: 0.45em; line-height: 1.25; }
    :global(.wiki-prose h3), :global(.wiki-prose h4) { margin-top: 1em; margin-bottom: 0.4em; line-height: 1.3; }
    :global(.wiki-prose > :first-child) { margin-top: 0; }
    :global(.wiki-prose pre) { line-height: 1.5; margin-top: 0.8em; margin-bottom: 0.8em; }

    /* Highlight for sentences matching the chat "Find sources" selection. Uses
       the same treatment as the source panel's snippet highlight, so a match
       looks the same wherever it is shown. */
    :global(mark.doc-highlight) {
        background: color-mix(in oklab, var(--accent) 26%, transparent);
        color: var(--text-strong);
        border-radius: 3px;
        padding: 0.05em 0.15em;
        font-weight: 600;
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 18%, transparent);
        animation: doc-hl-pulse 1.2s ease-in-out 2;
    }
    @keyframes doc-hl-pulse {
        0%, 100% { box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 18%, transparent); }
        50% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--accent) 32%, transparent); }
    }
</style>