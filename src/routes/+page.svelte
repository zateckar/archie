<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import Send from '@lucide/svelte/icons/send';
import Bot from '@lucide/svelte/icons/bot';
import Mic from '@lucide/svelte/icons/mic';
import MicOff from '@lucide/svelte/icons/mic-off';
import Plus from '@lucide/svelte/icons/plus';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import LogOut from '@lucide/svelte/icons/log-out';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import MessageSquare from '@lucide/svelte/icons/message-square';
import Trash from '@lucide/svelte/icons/trash';
import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
import Network from '@lucide/svelte/icons/network';
import Info from '@lucide/svelte/icons/info';
import BookOpen from '@lucide/svelte/icons/book-open';
import Search from '@lucide/svelte/icons/search';
import X from '@lucide/svelte/icons/x';
import Pin from '@lucide/svelte/icons/pin';
import PinOff from '@lucide/svelte/icons/pin-off';
    import { fade, fly } from 'svelte/transition';
    import MessageBubble from '$lib/components/MessageBubble.svelte';
    import ThemeToggle from '$lib/components/ThemeToggle.svelte';
    import { conversationTitle } from '$lib/conversation-title';
    import {
        SIDEBAR_WIDTH_KEY,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
        SIDEBAR_DEFAULT_WIDTH,
        clampSidebarWidth
    } from '$lib/prefs';

    type Conversation = { id: string; title: string; pinned: number; updated_at: string };
    type Message = { role: 'user' | 'assistant', content: string, sources?: any[] };

    /** Newest first. The pinned/recent split is a filter over this one order. */
    function byUpdatedDesc(list: Conversation[]): Conversation[] {
        return [...list].sort(
            (a, b) => (parseTimestamp(b.updated_at)?.getTime() ?? 0) - (parseTimestamp(a.updated_at)?.getTime() ?? 0)
        );
    }

    let { data } = $props();
    let user = $derived(data.user);
    let conversations = $state<Conversation[]>(
        untrack(() => byUpdatedDesc((data.conversations as Conversation[]) || []))
    );
    let currentConversationId = $state<string | null>(null);
    let messages: Message[] = $state([]);
    let currentPrompt = $state('');
    let isChatting = $state(false);
    let isUserMenuOpen = $state(false);
    let isSidebarOpen = $state(true);
    let sidebarWidth = $state<number>(
        untrack(() => clampSidebarWidth(Number(data.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH)))
    );
    let isResizing = $state(false);
    let searchQuery = $state('');
    /** Ids the server matched for the active query; null means "not searching". */
    let searchHits = $state<Set<string> | null>(null);
    let isSearching = $state(false);
    let listError = $state<string | null>(null);
    let isRecording = $state(false);
    let recognition: any = null;
    let speechSupported = $state(false);
    let micError = $state<string | null>(null);
    let textareaEl = $state<HTMLTextAreaElement>();

    // Starter prompts on the empty state. They fill the composer rather than
    // sending immediately, so the wording stays editable.
    const starters = [
        { label: 'Summarise', text: 'Summarise the latest project documents.' },
        { label: 'Find', text: 'Find the technical specification for TS-FIV.' }
    ];

    /** Grow the composer with its content, up to a scroll cap. */
    function resizeComposer() {
        if (!textareaEl) return;
        textareaEl.style.height = 'auto';
        textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 200)}px`;
    }

    function useStarter(text: string) {
        currentPrompt = text;
        textareaEl?.focus();
        requestAnimationFrame(resizeComposer);
    }

    const SPEECH_ERROR_MESSAGES: Record<string, string> = {
        'not-allowed': 'Microphone blocked. Allow microphone access for this site, and in Edge check Settings > Privacy, search, and services > Speech > "Online speech recognition" is turned on.',
        'service-not-allowed': 'Speech service blocked. In Edge check Settings > Privacy, search, and services > Speech > "Online speech recognition" is turned on.',
        'audio-capture': 'No microphone was found. Check that a microphone is connected and enabled.',
        'no-speech': 'No speech detected. Try again.',
        'network': 'Speech recognition network error. Check your internet connection.',
        'aborted': 'Voice input was cancelled.'
    };

    function toggleVoiceInput() {
        if (!speechSupported) return;

        if (isRecording) {
            recognition?.stop();
            isRecording = false;
        } else {
            micError = null;
            try {
                recognition?.start();
                isRecording = true;
            } catch (err) {
                console.error('Failed to start speech recognition:', err);
                isRecording = false;
                micError = 'Could not start voice input. Please try again.';
            }
        }
    }

    // ── Recents list: timestamps ────────────────────────────────────────────

    /** Ticks once a minute so "5m" ages into "6m" without a reload. */
    let nowTick = $state(Date.now());

    /**
     * SQLite's CURRENT_TIMESTAMP is `YYYY-MM-DD HH:MM:SS` in UTC with no zone
     * marker, which `new Date()` reads as local time — every row would look
     * hours off. Stamp the Z ourselves; ISO strings minted client-side already
     * carry one.
     */
    function parseTimestamp(value: string | undefined): Date | null {
        if (!value) return null;
        const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    /**
     * A few characters at most — this sits in the row's narrow right column.
     *
     * `now` is passed in rather than read from the clock so the template can
     * re-run this off a ticking value; a pure Date.now() here would render once
     * and then quietly go stale.
     */
    function shortTime(value: string, now: number): string {
        const date = parseTimestamp(value);
        if (!date) return '';
        const minutes = Math.floor((now - date.getTime()) / 60000);
        if (minutes < 1) return 'now';
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d`;
        const sameYear = date.getFullYear() === new Date(now).getFullYear();
        return sameYear
            ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
            : date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    }

    /** The full stamp, for the row's tooltip. */
    function fullTime(value: string): string {
        return parseTimestamp(value)?.toLocaleString() ?? '';
    }

    // ── Recents list: search ────────────────────────────────────────────────

    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    let searchController: AbortController | null = null;

    /**
     * Searches titles and message bodies server-side, then keeps the result as a
     * set of ids used to filter the local list. Filtering rather than replacing
     * means pin and delete keep mutating one authoritative array.
     */
    async function runSearch(query: string) {
        searchController?.abort();
        if (!query) {
            searchHits = null;
            isSearching = false;
            return;
        }

        const controller = new AbortController();
        searchController = controller;
        isSearching = true;
        try {
            const res = await fetch(`/api/conversations?q=${encodeURIComponent(query)}`, {
                signal: controller.signal
            });
            if (!res.ok) throw new Error('Search failed');
            const hits = (await res.json()) as Conversation[];
            searchHits = new Set(hits.map((c) => c.id));
            // A conversation created in another tab can match without being in the
            // local list; fold those in so the hit is actually reachable.
            const known = new Set(conversations.map((c) => c.id));
            const extras = hits.filter((c) => !known.has(c.id));
            if (extras.length) conversations = byUpdatedDesc([...conversations, ...extras]);
            listError = null;
        } catch (err) {
            if ((err as any)?.name === 'AbortError') return;
            console.error(err);
            listError = 'Search failed.';
        } finally {
            if (searchController === controller) isSearching = false;
        }
    }

    function onSearchInput() {
        const query = searchQuery.trim();
        if (searchTimer) clearTimeout(searchTimer);
        // Immediate on clear so the full list snaps back without a delay.
        if (!query) {
            searchController?.abort();
            searchHits = null;
            isSearching = false;
            return;
        }
        isSearching = true;
        searchTimer = setTimeout(() => runSearch(query), 200);
    }

    function clearSearch() {
        searchQuery = '';
        onSearchInput();
    }

    let visibleConversations = $derived(
        searchHits ? conversations.filter((c) => searchHits!.has(c.id)) : conversations
    );
    let pinnedConversations = $derived(visibleConversations.filter((c) => c.pinned));
    let recentConversations = $derived(visibleConversations.filter((c) => !c.pinned));

    // ── Recents list: pinning ───────────────────────────────────────────────

    async function togglePin(conv: Conversation, e: MouseEvent) {
        e.stopPropagation();
        const next = conv.pinned ? 0 : 1;
        // Optimistic: the row jumps sections immediately, and reverts if the
        // write fails.
        conversations = conversations.map((c) => (c.id === conv.id ? { ...c, pinned: next } : c));
        try {
            const res = await fetch(`/api/conversations/${conv.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pinned: next === 1 })
            });
            if (!res.ok) throw new Error('Pin failed');
            listError = null;
        } catch (err) {
            console.error(err);
            conversations = conversations.map((c) =>
                c.id === conv.id ? { ...c, pinned: conv.pinned } : c
            );
            listError = 'Could not update the pin.';
        }
    }

    // ── Recents list: resizable width ───────────────────────────────────────

    let widthSaveTimer: ReturnType<typeof setTimeout> | null = null;

    function saveSidebarWidth(width: number) {
        if (widthSaveTimer) clearTimeout(widthSaveTimer);
        widthSaveTimer = setTimeout(() => {
            fetch('/api/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [SIDEBAR_WIDTH_KEY]: width })
            }).catch((err) => console.error('Failed to save sidebar width:', err));
        }, 400);
    }

    function setSidebarWidth(width: number) {
        sidebarWidth = clampSidebarWidth(width);
        saveSidebarWidth(sidebarWidth);
    }

    function startResize(e: PointerEvent) {
        e.preventDefault();
        isResizing = true;
        const startX = e.clientX;
        const startWidth = sidebarWidth;

        const onMove = (move: PointerEvent) => {
            // No save per frame — the drag only moves the panel; the width is
            // persisted once on release.
            sidebarWidth = clampSidebarWidth(startWidth + (move.clientX - startX));
        };
        const onUp = () => {
            isResizing = false;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            saveSidebarWidth(sidebarWidth);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    function onResizeKey(e: KeyboardEvent) {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSidebarWidth(sidebarWidth - step);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSidebarWidth(sidebarWidth + step);
        } else if (e.key === 'Home') {
            e.preventDefault();
            setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
        }
    }

    async function loadConversation(id: string) {
        if (isChatting) return;
        currentConversationId = id;
        try {
            const res = await fetch(`/api/chat/history?conversationId=${id}`);
            if (res.ok) {
                messages = await res.json();
            }
        } catch (err) {
            console.error(err);
        }
    }

    /**
     * `resetSearch` is off when this is called as cleanup after deleting the open
     * conversation — the user is mid-search there and should keep their results.
     * The New-conversation button does reset, or the new entry would land outside
     * the active filter and the sidebar would look like it swallowed it.
     */
    async function startNewChat(resetSearch = true) {
        if (isChatting) return;
        currentConversationId = null;
        messages = [];
        currentPrompt = '';
        if (resetSearch) clearSearch();
    }

    async function deleteConversation(conv: Conversation, e: MouseEvent) {
        e.stopPropagation();
        if (conv.pinned) return; // guarded in markup too; the API refuses as well
        if (!confirm('Are you sure you want to delete this conversation?')) return;

        try {
            const res = await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
            if (res.ok) {
                conversations = conversations.filter((c: Conversation) => c.id !== conv.id);
                if (currentConversationId === conv.id) {
                    startNewChat(false);
                }
                listError = null;
            } else {
                const body = await res.json().catch(() => ({}));
                listError = body.error ?? 'Could not delete the conversation.';
            }
        } catch (err) {
            console.error(err);
            listError = 'Could not delete the conversation.';
        }
    }

    async function handleChat(skipAnalysis = false) {
        if (!currentPrompt.trim() || isChatting) return;

        if (isRecording) {
            recognition?.stop();
            isRecording = false;
        }

        const prompt = currentPrompt;
        currentPrompt = '';
        requestAnimationFrame(resizeComposer);
        messages = [...messages, { role: 'user', content: prompt }];

        isChatting = true;
        try {
            const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, history, conversationId: currentConversationId, skipAnalysis })
            });

            // Handle non-streaming responses (clarification, low confidence)
            const contentType = res.headers.get('Content-Type');
            if (contentType?.includes('application/json')) {
                const data = await res.json();

                if (data.type === 'clarification') {
                    messages = [...messages, {
                        role: 'assistant',
                        content: `I need a bit more context to help you better:\n\n${data.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}\n\nCould you provide more details?`
                    }];
                    isChatting = false;
                    return;
                }

                if (data.type === 'low_confidence') {
                    messages = [...messages, {
                        role: 'assistant',
                        content: `I found some potentially relevant information, but I'm not very confident it answers your question.\n\nTo help me find better results, could you:\n\n${data.refinements.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}\n\nOr you can rephrase your question to be more specific.`,
                        sources: data.chunks
                    }];
                    isChatting = false;
                    return;
                }
            }

            if (!res.body) throw new Error('No response body');

            const newConvId = res.headers.get('X-Conversation-Id');
            if (newConvId && !currentConversationId) {
                currentConversationId = newConvId;
                conversations = [
                    {
                        id: newConvId,
                        title: conversationTitle(prompt),
                        pinned: 0,
                        updated_at: new Date().toISOString()
                    },
                    ...conversations
                ];
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let assistantMessage = { role: 'assistant' as const, content: '', sources: [] };
            messages = [...messages, assistantMessage];

            // Batch stream updates to avoid excessive reactivity (max every 60ms)
            let lastFlush = 0;
            let pendingUpdate: (() => void) | null = null;
            const FLUSH_INTERVAL = 60;

            function flushUpdate() {
                if (pendingUpdate) {
                    pendingUpdate();
                    pendingUpdate = null;
                }
                lastFlush = Date.now();
            }

            // The server emits newline-delimited JSON objects, but reader.read()
            // yields arbitrary byte boundaries — a single JSON line (especially a
            // large "sources" payload) can be split across multiple reads. Buffer
            // the incomplete trailing line and only parse complete lines.
            let buffer = '';

            function processLine(line: string) {
                if (!line.trim()) return;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === 'sources') {
                        assistantMessage.sources = parsed.data;
                    } else if (parsed.type === 'chunk') {
                        assistantMessage.content += parsed.data;
                    }
                    // Schedule a batched update
                    pendingUpdate = () => {
                        messages[messages.length - 1] = { ...assistantMessage };
                    };
                    const now = Date.now();
                    if (now - lastFlush >= FLUSH_INTERVAL) {
                        flushUpdate();
                    }
                } catch (e) {
                    console.error('Failed to parse stream chunk:', line, e);
                }
            }

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Split off complete lines; keep the last (possibly partial) piece.
                let newlineIdx: number;
                while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIdx);
                    buffer = buffer.slice(newlineIdx + 1);
                    processLine(line);
                }
            }
            // Flush the decoder and process any trailing line without a newline.
            buffer += decoder.decode();
            if (buffer.trim()) processLine(buffer);

            // Flush any remaining batch
            flushUpdate();
        } catch (err) {
            console.error(err);
            messages = [...messages, { role: 'assistant', content: 'Sorry, something went wrong.' }];
        } finally {
            isChatting = false;
            // The server bumped conversations.updated_at for this turn; mirror it
            // so the row's stamp and its place in the list stay honest.
            if (currentConversationId) {
                const now = new Date().toISOString();
                conversations = byUpdatedDesc(
                    conversations.map((c) => (c.id === currentConversationId ? { ...c, updated_at: now } : c))
                );
            }
        }
    }

    let tickInterval: ReturnType<typeof setInterval> | null = null;

    onMount(() => {
        if (conversations.length > 0) {
            loadConversation(conversations[0].id);
        }

        tickInterval = setInterval(() => (nowTick = Date.now()), 60_000);

        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
            speechSupported = true;
            recognition = new SpeechRecognition();
            recognition.lang = 'en-US';
            recognition.interimResults = true;
            recognition.continuous = false;

            recognition.onstart = () => {
                micError = null;
            };

            recognition.onresult = (event: any) => {
                let transcript = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    transcript += event.results[i][0].transcript;
                }
                currentPrompt = transcript;
            };

            recognition.onend = () => {
                isRecording = false;
            };

            recognition.onerror = (event: any) => {
                console.error('Speech recognition error:', event.error);
                isRecording = false;
                micError = SPEECH_ERROR_MESSAGES[event.error] ?? `Speech recognition error: ${event.error}`;
            };
        }
    });

    onDestroy(() => {
        if (recognition) {
            recognition.abort();
        }
        if (tickInterval) clearInterval(tickInterval);
        if (searchTimer) clearTimeout(searchTimer);
        searchController?.abort();
        // Flush a pending width save rather than dropping it on navigation.
        if (widthSaveTimer) {
            clearTimeout(widthSaveTimer);
            navigator.sendBeacon?.(
                '/api/preferences',
                new Blob([JSON.stringify({ [SIDEBAR_WIDTH_KEY]: sidebarWidth })], {
                    type: 'application/json'
                })
            );
        }
    });
</script>

<div class="flex h-screen bg-page text-body font-sans overflow-hidden">
    <!-- Sidebar -->
    <aside
        style="width: {sidebarWidth}px"
        class="sidebar-panel bg-surface border-r border-line flex flex-col z-20 {isSidebarOpen ? 'sidebar-visible' : 'sidebar-hidden'} {isResizing ? 'is-resizing' : ''}"
    >
            <div class="h-14 px-4 border-b border-line-subtle flex items-center justify-between">
                <p class="wordmark">Archie<span class="wordmark-dot ml-1"></span></p>
                <button
                    onclick={() => isSidebarOpen = false}
                    class="btn btn-ghost btn-icon"
                    aria-label="Hide sidebar"
                    title="Hide sidebar"
                >
                    <PanelLeftClose class="w-4 h-4" />
                </button>
            </div>

            <div class="p-3 space-y-2">
                <button onclick={() => startNewChat()} class="btn btn-primary w-full">
                    <Plus class="w-4 h-4" />
                    New conversation
                </button>

                <div class="relative">
                    <Search class="w-3.5 h-3.5 text-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                        bind:value={searchQuery}
                        oninput={onSearchInput}
                        onkeydown={(e) => e.key === 'Escape' && clearSearch()}
                        type="search"
                        placeholder="Search conversations…"
                        aria-label="Search conversations"
                        class="field search-field"
                    />
                    {#if searchQuery}
                        <button
                            onclick={clearSearch}
                            class="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-faint hover:text-body transition-colors"
                            aria-label="Clear search"
                            title="Clear search"
                        >
                            <X class="w-3.5 h-3.5" />
                        </button>
                    {/if}
                </div>
            </div>

            {#if listError}
                <p class="px-4 pb-2 text-xs text-danger" in:fade>{listError}</p>
            {/if}

            <div class="flex-1 overflow-y-auto px-2 pb-2">
                {#snippet conversationRow(conv: Conversation)}
                    <div
                        class="conv-item {currentConversationId === conv.id ? 'conv-item-active' : ''}"
                    >
                        <button
                            onclick={() => loadConversation(conv.id)}
                            class="conv-open"
                            title={conv.title}
                            aria-current={currentConversationId === conv.id ? 'true' : undefined}
                        >
                            <MessageSquare class="w-4 h-4 flex-shrink-0 mt-0.5 {currentConversationId === conv.id ? 'text-accent' : 'text-ghost'}" />
                            <span class="conv-title">{conv.title}</span>
                        </button>

                        <!-- One fixed-width column: the timestamp by default, the
                             row's actions on hover or keyboard focus. Swapping in
                             place keeps both compact and costs no extra height. -->
                        <div class="conv-meta">
                            <span class="conv-time" title={fullTime(conv.updated_at)}>
                                {shortTime(conv.updated_at, nowTick)}
                            </span>
                            <div class="conv-actions">
                                <button
                                    onclick={(e) => togglePin(conv, e)}
                                    class="conv-action {conv.pinned ? 'conv-action-pinned' : ''}"
                                    aria-label={conv.pinned ? 'Unpin conversation' : 'Pin conversation'}
                                    title={conv.pinned ? 'Unpin conversation' : 'Pin conversation'}
                                >
                                    {#if conv.pinned}
                                        <PinOff class="w-3.5 h-3.5" />
                                    {:else}
                                        <Pin class="w-3.5 h-3.5" />
                                    {/if}
                                </button>
                                {#if !conv.pinned}
                                    <button
                                        onclick={(e) => deleteConversation(conv, e)}
                                        class="conv-action conv-action-danger"
                                        aria-label="Delete conversation"
                                        title="Delete conversation"
                                    >
                                        <Trash class="w-3.5 h-3.5" />
                                    </button>
                                {/if}
                            </div>
                        </div>
                    </div>
                {/snippet}

                {#if pinnedConversations.length > 0}
                    <p class="eyebrow px-3 py-2 flex items-center gap-1.5">
                        <Pin class="w-3 h-3" />
                        Pinned
                    </p>
                    <div class="space-y-0.5">
                        {#each pinnedConversations as conv (conv.id)}
                            {@render conversationRow(conv)}
                        {/each}
                    </div>
                    <div class="mx-3 my-2 border-t border-line-subtle"></div>
                {/if}

                <!-- Suppressed when everything on show is pinned, so the panel
                     never ends on a heading with nothing under it. -->
                {#if recentConversations.length > 0 || pinnedConversations.length === 0}
                    <p class="eyebrow px-3 py-2">
                        {searchHits ? 'Results' : 'Recent'}
                    </p>
                    <div class="space-y-0.5">
                        {#each recentConversations as conv (conv.id)}
                            {@render conversationRow(conv)}
                        {/each}
                    </div>
                {/if}

                {#if visibleConversations.length === 0}
                    <p class="px-3 py-2 text-xs text-faint">
                        {#if isSearching}
                            Searching…
                        {:else if searchHits}
                            No conversations match “{searchQuery.trim()}”.
                        {:else}
                            No conversations yet.
                        {/if}
                    </p>
                {/if}
            </div>

            <!-- Drag the panel edge; arrow keys nudge it, Home restores the default.
                 A focusable separator with aria-valuenow is the ARIA window-splitter
                 pattern; Svelte's checker classifies every separator as
                 non-interactive and can't see the distinction. -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize conversations panel"
                aria-valuenow={sidebarWidth}
                aria-valuemin={SIDEBAR_MIN_WIDTH}
                aria-valuemax={SIDEBAR_MAX_WIDTH}
                tabindex="0"
                class="resize-handle {isResizing ? 'is-active' : ''}"
                onpointerdown={startResize}
                onkeydown={onResizeKey}
                ondblclick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
                title="Drag to resize · double-click to reset"
            ></div>

            <div class="p-3 border-t border-line-subtle">
                <div class="relative">
                    <button
                        onclick={() => isUserMenuOpen = !isUserMenuOpen}
                        class="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-[var(--hover-surface)] transition-colors"
                    >
                        <div class="w-8 h-8 rounded-lg bg-accent-solid text-on-accent flex items-center justify-center text-[11px] font-semibold flex-shrink-0">
                            {user?.username.slice(0, 2).toUpperCase()}
                        </div>
                        <div class="flex-1 text-left overflow-hidden">
                            <p class="text-[13px] font-medium text-body truncate">{user?.username}</p>
                            <p class="text-xs text-faint capitalize">{user?.role}</p>
                        </div>
                        <ChevronDown class="w-4 h-4 text-faint transition-transform {isUserMenuOpen ? 'rotate-180' : ''}" />
                    </button>

                    {#if isUserMenuOpen}
                        <div
                            transition:fly={{ y: 6, duration: 150 }}
                            class="absolute bottom-full left-0 right-0 mb-2 bg-raised border border-line rounded-2xl shadow-xl p-1.5 z-50"
                        >
                            <a href="/knowledge" class="nav-item">
                                <Network class="w-4 h-4 text-faint" />
                                Knowledge graph
                            </a>
                            <a href="/wiki" class="nav-item">
                                <BookOpen class="w-4 h-4 text-faint" />
                                Wiki
                            </a>
                            <a href="/about" class="nav-item">
                                <Info class="w-4 h-4 text-faint" />
                                About
                            </a>
                            {#if user?.role === 'admin'}
                                <a href="/admin" class="nav-item">
                                    <LayoutDashboard class="w-4 h-4 text-faint" />
                                    Admin dashboard
                                </a>
                            {/if}
                            <div class="my-1.5 border-t border-line-subtle"></div>
                            <form method="POST" action="/api/auth/logout">
                                <button type="submit" class="nav-item w-full text-danger hover:text-danger">
                                    <LogOut class="w-4 h-4" />
                                    Sign out
                                </button>
                            </form>
                        </div>
                    {/if}
                </div>
            </div>
    </aside>

    <!-- Main: Chat Interface -->
    <main class="flex-1 flex flex-col relative w-full bg-page">
        <header class="h-14 px-4 border-b border-line-subtle flex items-center justify-between bg-page/90 backdrop-blur-md sticky top-0 z-10">
            <div class="flex items-center gap-2">
                {#if !isSidebarOpen}
                    <button
                        onclick={() => isSidebarOpen = true}
                        class="btn btn-ghost btn-icon"
                        aria-label="Show sidebar"
                        title="Show sidebar"
                    >
                        <PanelLeftOpen class="w-4 h-4" />
                    </button>
                {/if}
                <a href="/wiki" class="btn btn-ghost btn-sm">
                    <BookOpen class="w-4 h-4" />
                    Wiki
                </a>
                <a href="/knowledge" class="btn btn-ghost btn-sm">
                    <Network class="w-4 h-4" />
                    Knowledge graph
                </a>
            </div>

            <div class="flex items-center gap-3">
                <ThemeToggle />
                <span class="text-xs text-ghost tabular-nums">v1.2.0</span>
            </div>
        </header>

        <div class="flex-1 overflow-y-auto px-4 py-6 space-y-6 scroll-smooth">
            {#if messages.length === 0}
                <div class="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto" in:fade>
                    <div class="w-11 h-11 rounded-2xl bg-surface border border-line flex items-center justify-center">
                        <Bot class="w-5 h-5 text-accent" />
                    </div>
                    <h2 class="page-title mt-5">How can I help?</h2>
                    <p class="text-[13px] text-mute leading-relaxed mt-2">
                        Ask about anything in your documents. Answers cite the sources they came from.
                    </p>
                    <div class="grid grid-cols-2 gap-2 w-full mt-7">
                        {#each starters as starter}
                            <button
                                onclick={() => useStarter(starter.text)}
                                class="card card-hover p-3 text-left"
                            >
                                <p class="eyebrow eyebrow-accent">{starter.label}</p>
                                <p class="text-[13px] text-dim mt-1.5 leading-snug">{starter.text}</p>
                            </button>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Messages share the composer's width cap so answers can use the
                 full column instead of a narrow bubble. -->
            <div class="chat-column space-y-6">
            {#each messages as msg, i}
                <MessageBubble
                    {msg}
                    conversationId={currentConversationId}
                    messageIndex={i}
                    streaming={isChatting && i === messages.length - 1 && msg.role === 'assistant'}
                />
            {/each}

            {#if isChatting}
                <div class="flex justify-start" in:fade>
                    <div class="flex gap-3">
                        <div class="w-8 h-8 rounded-lg bg-surface border border-line flex items-center justify-center flex-shrink-0">
                            <Bot class="w-4 h-4 text-accent" />
                        </div>
                        <div class="bg-raised border border-line-subtle px-4 py-3 rounded-2xl rounded-tl-sm flex items-center gap-2.5">
                            <div class="flex gap-1" aria-hidden="true">
                                <div class="w-1.5 h-1.5 bg-accent-quiet rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                <div class="w-1.5 h-1.5 bg-accent-quiet rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                <div class="w-1.5 h-1.5 bg-accent-quiet rounded-full animate-bounce"></div>
                            </div>
                            <span class="text-[13px] text-mute">Searching your documents…</span>
                        </div>
                    </div>
                </div>
            {/if}
            </div>
        </div>

        <footer class="px-4 pb-5 pt-2 bg-page">
            <div class="chat-column">
                <div class="composer">
                    <textarea
                        bind:this={textareaEl}
                        bind:value={currentPrompt}
                        oninput={resizeComposer}
                        onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleChat())}
                        placeholder="Ask about your documents…"
                        class="composer-input"
                        rows="1"
                    ></textarea>
                    <div class="flex items-center gap-1.5 pb-2 pr-2">
                        {#if speechSupported}
                            <button
                                onclick={toggleVoiceInput}
                                disabled={isChatting}
                                class="btn btn-icon {micError || isRecording ? 'btn-danger' : 'btn-ghost'}"
                                aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
                                title={micError ?? (isRecording ? 'Stop recording' : 'Start voice input')}
                            >
                                {#if isRecording}
                                    <MicOff class="w-4 h-4" />
                                {:else}
                                    <Mic class="w-4 h-4" />
                                {/if}
                            </button>
                        {/if}
                        <button
                            onclick={() => handleChat()}
                            disabled={!currentPrompt.trim() || isChatting}
                            class="btn btn-primary btn-icon"
                            aria-label="Send message"
                            title="Send message"
                        >
                            <Send class="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {#if micError}
                    <p class="mt-2 text-xs text-danger text-center" in:fade>{micError}</p>
                {/if}
                <p class="mt-2.5 text-xs text-faint text-center">
                    Enter to send · Shift + Enter for a new line
                </p>
            </div>
        </footer>
    </main>
</div>

<style>
    .sidebar-panel {
        position: relative;
        flex-shrink: 0;
        transition: transform 0.25s ease, opacity 0.25s ease;
    }

    /* Width is driven by the pointer during a drag; animating it would lag the
       cursor. Selection is killed for the same reason — dragging across the
       list otherwise highlights every title it passes. */
    .sidebar-panel.is-resizing,
    .sidebar-panel.is-resizing * {
        user-select: none;
    }

    .sidebar-visible {
        transform: translateX(0);
        opacity: 1;
    }

    .sidebar-hidden {
        transform: translateX(-100%);
        opacity: 0;
        position: absolute;
        height: 100%;
    }

    /* Resize grip ---------------------------------------------------------- */
    /* A 4px hit area straddling the panel's border: invisible until you reach
       for it, then an accent rail. */
    .resize-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        right: -2px;
        width: 5px;
        cursor: col-resize;
        background: transparent;
        transition: background-color 0.15s ease;
        touch-action: none;
        z-index: 30;
    }

    .resize-handle:hover,
    .resize-handle:focus-visible,
    .resize-handle.is-active {
        background: var(--accent);
        outline: none;
    }

    /* Search --------------------------------------------------------------- */
    .search-field {
        padding-left: 2rem;
        padding-right: 1.875rem;
    }

    /* The UA's own clear button would sit under ours. */
    .search-field::-webkit-search-cancel-button {
        display: none;
    }

    /* Conversation rows ---------------------------------------------------- */
    .conv-item {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 0.25rem;
        padding: 0.375rem 0.5rem 0.375rem 0.75rem;
        border-radius: var(--radius-xl);
        transition: background-color 0.15s ease;
    }

    .conv-item:hover { background: var(--hover-surface); }

    .conv-item-active {
        background: color-mix(in oklab, var(--accent) 10%, transparent);
    }

    .conv-item-active:hover {
        background: color-mix(in oklab, var(--accent) 14%, transparent);
    }

    /* Same 2px accent rail as .nav-item-active, so "you are here" reads the
       same here as everywhere else in the app. */
    .conv-item-active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 20%;
        bottom: 20%;
        width: 2px;
        border-radius: 9999px;
        background: var(--accent);
    }

    .conv-open {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: flex-start;
        gap: 0.625rem;
        background: transparent;
        border: 0;
        padding: 0;
        text-align: left;
        cursor: pointer;
        color: var(--text-muted);
        font-size: 0.8125rem;
        transition: color 0.15s ease;
    }

    .conv-item:hover .conv-open { color: var(--text-primary); }

    .conv-item-active .conv-open {
        color: var(--text-strong);
        font-weight: 600;
    }

    /* Two lines, then ellipsis. The single truncated line this replaces cut
       most titles before they said anything useful. */
    .conv-title {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        line-height: 1.3;
    }

    /* One fixed-width column shared by the stamp and the row actions: they
       occupy the same box, so revealing the actions costs no reflow. */
    .conv-meta {
        position: relative;
        flex-shrink: 0;
        width: 3.5rem;
        min-height: 1.5rem;
        display: flex;
        align-items: center;
        justify-content: flex-end;
    }

    .conv-time {
        font-size: 0.625rem;
        line-height: 1;
        color: var(--text-faintest);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        transition: opacity 0.15s ease;
    }

    .conv-actions {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.125rem;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
    }

    .conv-item:hover .conv-actions,
    .conv-item:focus-within .conv-actions {
        opacity: 1;
        pointer-events: auto;
    }

    .conv-item:hover .conv-time,
    .conv-item:focus-within .conv-time {
        opacity: 0;
    }

    .conv-action {
        padding: 0.25rem;
        border-radius: var(--radius-lg);
        color: var(--text-faint);
        background: transparent;
        border: 0;
        cursor: pointer;
        transition: color 0.15s ease, background-color 0.15s ease;
    }

    .conv-action:hover { background: var(--bg-muted); color: var(--text-primary); }

    /* These have to be component rules, not `text-accent` / `hover:text-danger`
       utilities: Svelte's scoped styles are unlayered and beat Tailwind's
       utilities layer no matter how specific the utility is. */
    .conv-action-pinned { color: var(--accent); }
    .conv-action-pinned:hover { color: var(--accent); }
    .conv-action-danger:hover { background: var(--bg-muted); color: var(--danger); }

    /* Touch has no hover: show the actions permanently and let the stamp go. */
    @media (hover: none) {
        .conv-actions { opacity: 1; pointer-events: auto; }
        .conv-time { display: none; }
    }

    /* Single width cap for the whole chat column — messages and composer stay
       aligned, and answers get the width instead of being boxed into a narrow
       bubble. Wide enough to use a maximised window, capped so long lines of
       body text stay readable. */
    .chat-column {
        width: 100%;
        max-width: 68rem;
        margin-inline: auto;
    }

    /* The composer is one field: the textarea and its buttons share a single
       border and focus state instead of the buttons floating over the input. */
    .composer {
        display: flex;
        align-items: flex-end;
        background: var(--bg-surface);
        border: 1px solid var(--line);
        border-radius: var(--radius-3xl);
        box-shadow: var(--elev-1);
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .composer:focus-within {
        border-color: var(--accent-quiet);
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 16%, transparent);
    }

    .composer-input {
        flex: 1;
        min-height: 2.75rem;
        max-height: 12.5rem;
        padding: 0.8125rem 0.25rem 0.8125rem 1rem;
        background: transparent;
        border: 0;
        resize: none;
        font-family: inherit;
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--text-primary);
    }

    .composer-input::placeholder { color: var(--text-faintest); }
    .composer-input:focus { outline: none; }
</style>
