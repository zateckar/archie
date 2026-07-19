<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import Send from 'lucide-svelte/icons/send';
import Bot from 'lucide-svelte/icons/bot';
import Mic from 'lucide-svelte/icons/mic';
import MicOff from 'lucide-svelte/icons/mic-off';
import Plus from 'lucide-svelte/icons/plus';
import LayoutDashboard from 'lucide-svelte/icons/layout-dashboard';
import LogOut from 'lucide-svelte/icons/log-out';
import ChevronDown from 'lucide-svelte/icons/chevron-down';
import MessageSquare from 'lucide-svelte/icons/message-square';
import Trash from 'lucide-svelte/icons/trash';
import PanelLeftClose from 'lucide-svelte/icons/panel-left-close';
import PanelLeftOpen from 'lucide-svelte/icons/panel-left-open';
import Network from 'lucide-svelte/icons/network';
import Info from 'lucide-svelte/icons/info';
import BookOpen from 'lucide-svelte/icons/book-open';
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

<div class="flex h-screen bg-[var(--bg-page)] text-[var(--text-page)] font-sans overflow-hidden">
    <!-- Sidebar -->
    <aside 
        class="sidebar-panel w-72 bg-[var(--bg-surface)] border-r border-[var(--border-secondary)] flex flex-col z-20 {isSidebarOpen ? 'sidebar-visible' : 'sidebar-hidden'}"
    >
            <div class="p-4 border-b border-[var(--border-secondary)] flex items-center justify-between">
                <h1 class="text-xs font-black bg-gradient-to-r from-[#78FAAE] to-[#0E3A2F] bg-clip-text text-transparent uppercase tracking-[0.2em]">
                    ARCHIE
                </h1>
                <button 
                    onclick={() => isSidebarOpen = false}
                    class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-muted)] transition-colors"
                >
                    <PanelLeftClose class="w-4 h-4" />
                </button>
            </div>

            <div class="p-3">
                <button 
                    onclick={startNewChat}
                    class="w-full flex items-center gap-3 px-4 py-3 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] rounded-xl transition-all shadow-lg shadow-[#0E3A2F]/20 font-bold text-xs uppercase tracking-wider group border border-[#78FAAE]/20"
                >
                    <Plus class="w-4 h-4 group-hover:rotate-90 transition-transform" />
                    New Conversation
                </button>
            </div>

            <div class="flex-1 overflow-y-auto px-2 space-y-1 custom-scrollbar">
                <div class="px-3 py-2 text-[10px] font-bold text-[var(--text-faint)] uppercase tracking-widest">Recent Chats</div>
                {#each conversations as conv}
                    <div 
                        role="button"
                        tabindex="0"
                        onclick={() => loadConversation(conv.id)}
                        onkeydown={(e) => e.key === 'Enter' && loadConversation(conv.id)}
                        class="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl transition-all group cursor-pointer
                        {currentConversationId === conv.id ? 'bg-[#0E3A2F] text-[#78FAAE] border border-[#78FAAE]/20' : 'text-[var(--text-muted)] hover:bg-[var(--hover-surface)] hover:text-[var(--text-secondary)] border border-transparent'}"
                    >
                        <div class="flex items-center gap-3 overflow-hidden">
                            <MessageSquare class="w-4 h-4 flex-shrink-0 {currentConversationId === conv.id ? 'text-[#78FAAE]' : 'text-[var(--text-faintest)]'}" />
                            <span class="text-xs font-medium truncate">{conv.title}</span>
                        </div>
                        <button 
                            onclick={(e) => deleteConversation(conv.id, e)}
                            class="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-900/20 hover:text-red-400 rounded-md transition-all"
                            aria-label="Delete conversation"
                        >
                            <Trash class="w-3 h-3" />
                        </button>
                    </div>
                {/each}
            </div>

            <div class="p-4 border-t border-[var(--border-secondary)]">
                <div class="relative">
                    <button 
                        onclick={() => isUserMenuOpen = !isUserMenuOpen}
                        class="w-full flex items-center gap-3 p-2 hover:bg-[var(--hover-surface)] rounded-xl transition-all border border-transparent hover:border-[var(--border-primary)]"
                    >
                        <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-[#0E3A2F] to-[#78FAAE] flex items-center justify-center text-[10px] font-bold shadow-lg shadow-[#0E3A2F]/20 text-[#0E3A2F]">
                            {user?.username.slice(0, 2).toUpperCase()}
                        </div>
                        <div class="flex-1 text-left overflow-hidden">
                            <p class="text-xs font-bold text-[var(--text-secondary)] truncate">{user?.username}</p>
                            <p class="text-[10px] text-[var(--text-faint)] uppercase tracking-tighter">{user?.role}</p>
                        </div>
                        <ChevronDown class="w-4 h-4 text-[var(--text-faint)] transition-transform {isUserMenuOpen ? 'rotate-180' : ''}" />
                    </button>

                    {#if isUserMenuOpen}
                        <div 
                            transition:fly={{ y: 10, duration: 200 }}
                            class="absolute bottom-full left-0 right-0 mb-2 bg-[var(--bg-raised)] border border-[var(--border-primary)] rounded-2xl shadow-2xl py-2 z-50 overflow-hidden"
                        >
                            <a href="/knowledge" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-[var(--hover-surface-solid)] hover:text-white transition-colors uppercase tracking-wider">
                                <Network class="w-4 h-4 text-cyan-400" />
                                Knowledge Graph
                            </a>
                            <a href="/wiki" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-[var(--hover-surface-solid)] hover:text-white transition-colors uppercase tracking-wider">
                                <BookOpen class="w-4 h-4 text-emerald-400" />
                                Wiki
                            </a>
                            <a href="/about" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-[var(--hover-surface-solid)] hover:text-white transition-colors uppercase tracking-wider">
                                <Info class="w-4 h-4 text-purple-400" />
                                About
                            </a>
                            <div class="my-1 border-t border-[var(--border-secondary)]"></div>
                            {#if user?.role === 'admin'}
                                <a href="/admin" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-[var(--hover-surface-solid)] hover:text-white transition-colors uppercase tracking-wider">
                                    <LayoutDashboard class="w-4 h-4 text-[#78FAAE]" />
                                    Admin Dashboard
                                </a>
                                <div class="my-1 border-t border-[var(--border-secondary)]"></div>
                            {/if}
                            <form method="POST" action="/api/auth/logout">
                                <button type="submit" class="w-full flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-red-400 hover:bg-red-900/20 transition-colors uppercase tracking-wider">
                                    <LogOut class="w-4 h-4" />
                                    Logout
                                </button>
                            </form>
                        </div>
                    {/if}
                </div>
            </div>
    </aside>

    <!-- Main: Chat Interface -->
    <main class="flex-1 flex flex-col relative w-full bg-[var(--bg-page)]">
        <header class="h-14 px-4 border-b border-[var(--border-secondary)] flex items-center justify-between bg-[var(--bg-page)]/80 backdrop-blur-xl sticky top-0 z-10">
            <div class="flex items-center gap-4">
                <a href="/wiki" class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--bg-slate-900)] border border-[var(--border-primary)] hover:border-[#78FAAE]/50 transition-all group">
                    <BookOpen class="w-4 h-4 text-[#78FAAE] group-hover:scale-110 transition-transform" />
                    <span class="text-[10px] font-bold text-[var(--text-muted)] group-hover:text-white uppercase tracking-widest">Wiki</span>
                </a>
                {#if !isSidebarOpen}
                    <button 
                        onclick={() => isSidebarOpen = true}
                        class="p-1.5 hover:bg-[var(--hover-surface)] rounded-lg text-[var(--text-muted)] transition-colors"
                    >
                        <PanelLeftOpen class="w-4 h-4" />
                    </button>
                {/if}
            </div>

            <div class="flex items-center gap-3">
                <ThemeToggle />
                <div class="h-4 w-px bg-slate-800"></div>
                <span class="text-[10px] font-bold text-[var(--text-faintest)] uppercase tracking-widest">v1.1.0</span>
            </div>
        </header>

        <div class="flex-1 overflow-y-auto p-4 space-y-8 scroll-smooth custom-scrollbar">
            {#if messages.length === 0}
                <div class="h-full flex flex-col items-center justify-center text-center space-y-6 max-w-md mx-auto" in:fade>
                    <div class="w-16 h-16 rounded-3xl bg-gradient-to-br from-[#0E3A2F] to-[#78FAAE] flex items-center justify-center shadow-2xl shadow-[#0E3A2F]/40 rotate-12">
                        <Bot class="w-8 h-8 text-[#0E3A2F]" />
                    </div>
                    <div class="space-y-2">
                        <h2 class="text-xl font-black tracking-tight text-[var(--text-primary)]">How can I help you today?</h2>
                        <p class="text-sm text-[var(--text-faint)] leading-relaxed">
                            Ask me anything about your documents. I can search through your knowledge base and provide precise answers with sources.
                        </p>
                    </div>
                    <div class="grid grid-cols-2 gap-3 w-full">
                        <button class="p-3 rounded-2xl bg-[var(--bg-slate-900)]/50 border border-[var(--border-primary)] hover:border-[#78FAAE]/50 transition-all text-left group">
                            <p class="text-[10px] font-bold text-[#78FAAE] uppercase tracking-wider mb-1">Analyze</p>
                            <p class="text-xs text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">Summarize the latest project docs</p>
                        </button>
                        <button class="p-3 rounded-2xl bg-[var(--bg-slate-900)]/50 border border-[var(--border-primary)] hover:border-[#78FAAE]/50 transition-all text-left group">
                            <p class="text-[10px] font-bold text-[#78FAAE] uppercase tracking-wider mb-1">Search</p>
                            <p class="text-xs text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">Find technical specs for TS-FIV</p>
                        </button>
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
                    <div class="flex space-x-4">
                        <div class="w-9 h-9 rounded-xl bg-[var(--bg-slate-900)] border border-[var(--border-primary)] flex items-center justify-center">
                            <Bot class="w-5 h-5 text-[#78FAAE] animate-pulse" />
                        </div>
                        <div class="bg-[var(--bg-raised)] border border-[var(--border-secondary)] p-5 rounded-2xl rounded-tl-none shadow-inner flex items-center gap-3">
                            <div class="flex gap-1">
                                <div class="w-1.5 h-1.5 bg-[#78FAAE] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                <div class="w-1.5 h-1.5 bg-[#78FAAE] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                <div class="w-1.5 h-1.5 bg-[#78FAAE] rounded-full animate-bounce"></div>
                            </div>
                            <span class="text-[10px] font-bold text-[var(--text-faint)] uppercase tracking-widest">Archie is thinking</span>
                        </div>
                    </div>
                </div>
            {/if}
        </div>

        <footer class="p-6 bg-gradient-to-t from-[var(--bg-page)] via-[var(--bg-page)] to-transparent">
            <div class="max-w-4xl mx-auto relative group">
                <div class="absolute -inset-1 bg-gradient-to-r from-[#0E3A2F] to-[#78FAAE] rounded-2xl blur opacity-20 group-focus-within:opacity-40 transition duration-500"></div>
                <textarea 
                    bind:value={currentPrompt}
                    onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleChat())}
                    placeholder="Ask anything about your documents..."
                    class="relative w-full bg-[var(--bg-surface)] border border-[var(--border-primary)] rounded-2xl py-5 pl-6 pr-28 focus:outline-none focus:border-[#78FAAE]/50 transition-all resize-none shadow-2xl text-sm text-[var(--text-secondary)] placeholder:text-[var(--text-faintest)]"
                    rows="1"
                ></textarea>
                <div class="absolute right-3 bottom-3 flex items-center gap-2">
                    {#if speechSupported}
                        <button
                            onclick={toggleVoiceInput}
                            disabled={isChatting}
                            class="p-2.5 rounded-xl transition-all shadow-lg border {micError ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/40' : isRecording ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border-red-500/30 animate-pulse' : 'bg-[var(--bg-slate-800)] hover:bg-[var(--hover-surface-solid)] text-[var(--text-muted)] border-[var(--border-hover)]'} disabled:bg-[var(--bg-slate-800)] disabled:text-[var(--text-faintest)] disabled:border-[var(--border-primary)]"
                            aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
                            title={micError ?? (isRecording ? 'Stop recording' : 'Start voice input')}
                        >
                            {#if isRecording}
                                <MicOff class="w-5 h-5" />
                            {:else}
                                <Mic class="w-5 h-5" />
                            {/if}
                        </button>
                    {/if}
                    <button
                        onclick={() => handleChat()}
                        disabled={!currentPrompt.trim() || isChatting}
                        class="p-2.5 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] disabled:bg-[var(--bg-slate-800)] disabled:text-[var(--text-faintest)] rounded-xl transition-all shadow-lg shadow-[#0E3A2F]/20 border border-[#78FAAE]/20"
                    >
                        <Send class="w-5 h-5" />
                    </button>
                </div>
            </div>
            {#if micError}
                <div class="max-w-4xl mx-auto mt-3 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs text-center" in:fade>
                    {micError}
                </div>
            {/if}
            <div class="flex items-center justify-center gap-6 mt-4">
                <p class="text-[9px] text-[var(--text-faintest)] uppercase tracking-[0.3em] font-black">
                    Powered by SQLite-Vector & Gemini AI
                </p>
            </div>
        </footer>
    </main>
</div>

<style>
    :global(body) {
        margin: 0;
        background: var(--bg-page);
    }

    .sidebar-panel {
        transition: transform 0.3s ease, opacity 0.3s ease;
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

    .custom-scrollbar::-webkit-scrollbar {
        width: 4px;
    }

    .custom-scrollbar::-webkit-scrollbar-track {
        background: transparent;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb);
        border-radius: 10px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
        background: var(--scrollbar-hover);
    }

    :global(.prose pre) {
        background: var(--code-bg) !important;
        border: 1px solid var(--code-border);
        border-radius: 12px;
    }

    :global(.prose code) {
        color: var(--code-text) !important;
        font-family: 'JetBrains Mono', monospace;
    }
</style>
