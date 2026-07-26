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
    import { fade, fly } from 'svelte/transition';
    import MessageBubble from '$lib/components/MessageBubble.svelte';
    import ThemeToggle from '$lib/components/ThemeToggle.svelte';

    type Conversation = { id: string; title: string };
    type Message = { role: 'user' | 'assistant', content: string, sources?: any[] };

    let { data } = $props();
    let user = $derived(data.user);
    let conversations = $state<Conversation[]>(untrack(() => (data.conversations as Conversation[]) || []));
    let currentConversationId = $state<string | null>(null);
    let messages: Message[] = $state([]);
    let currentPrompt = $state('');
    let isChatting = $state(false);
    let isUserMenuOpen = $state(false);
    let isSidebarOpen = $state(true);
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

    async function startNewChat() {
        if (isChatting) return;
        currentConversationId = null;
        messages = [];
        currentPrompt = '';
    }

    async function deleteConversation(id: string, e: MouseEvent) {
        e.stopPropagation();
        if (!confirm('Are you sure you want to delete this conversation?')) return;
        
        try {
            const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
            if (res.ok) {
                conversations = conversations.filter((c: Conversation) => c.id !== id);
                if (currentConversationId === id) {
                    startNewChat();
                }
            }
        } catch (err) {
            console.error(err);
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
                conversations = [{ id: newConvId, title: prompt.slice(0, 50) }, ...conversations];
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
        }
    }

    onMount(() => {
        if (conversations.length > 0) {
            loadConversation(conversations[0].id);
        }

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
    });
</script>

<div class="flex h-screen bg-page text-body font-sans overflow-hidden">
    <!-- Sidebar -->
    <aside
        class="sidebar-panel w-72 bg-surface border-r border-line flex flex-col z-20 {isSidebarOpen ? 'sidebar-visible' : 'sidebar-hidden'}"
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

            <div class="p-3">
                <button onclick={startNewChat} class="btn btn-primary w-full">
                    <Plus class="w-4 h-4" />
                    New conversation
                </button>
            </div>

            <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
                <p class="eyebrow px-3 py-2">Recent</p>
                {#each conversations as conv}
                    <div
                        role="button"
                        tabindex="0"
                        onclick={() => loadConversation(conv.id)}
                        onkeydown={(e) => e.key === 'Enter' && loadConversation(conv.id)}
                        class="nav-item group cursor-pointer justify-between {currentConversationId === conv.id ? 'nav-item-active' : ''}"
                    >
                        <div class="flex items-center gap-2.5 overflow-hidden">
                            <MessageSquare class="w-4 h-4 flex-shrink-0 {currentConversationId === conv.id ? 'text-accent' : 'text-ghost'}" />
                            <span class="truncate">{conv.title}</span>
                        </div>
                        <button
                            onclick={(e) => deleteConversation(conv.id, e)}
                            class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded-md text-faint hover:text-danger transition-colors"
                            aria-label="Delete conversation"
                            title="Delete conversation"
                        >
                            <Trash class="w-3.5 h-3.5" />
                        </button>
                    </div>
                {/each}
            </div>

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
                <span class="text-xs text-ghost tabular-nums">v1.1.0</span>
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

        <footer class="px-4 pb-5 pt-2 bg-page">
            <div class="max-w-3xl mx-auto">
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
        transition: transform 0.25s ease, opacity 0.25s ease;
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
