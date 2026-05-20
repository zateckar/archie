<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { 
        Send, Bot,
        Plus, LayoutDashboard, LogOut, ChevronDown,
        MessageSquare, Trash, PanelLeftClose, PanelLeftOpen, Network, Info, BookOpen
    } from 'lucide-svelte';
    import { fade, fly } from 'svelte/transition';
    import MessageBubble from '$lib/components/MessageBubble.svelte';

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

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.trim());

                for (const line of lines) {
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
            }
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
    });
</script>

<div class="flex h-screen bg-[#050505] text-slate-100 font-sans overflow-hidden">
    <!-- Sidebar -->
    <aside 
        class="sidebar-panel w-72 bg-[#0a0a0a] border-r border-slate-800/50 flex flex-col z-20 {isSidebarOpen ? 'sidebar-visible' : 'sidebar-hidden'}"
    >
            <div class="p-4 border-b border-slate-800/50 flex items-center justify-between">
                <h1 class="text-xs font-black bg-gradient-to-r from-[#78FAAE] to-[#0E3A2F] bg-clip-text text-transparent uppercase tracking-[0.2em]">
                    ARCHIE
                </h1>
                <button 
                    onclick={() => isSidebarOpen = false}
                    class="p-1.5 hover:bg-slate-800 rounded-lg text-slate-500 transition-colors"
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
                <div class="px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Recent Chats</div>
                {#each conversations as conv}
                    <div 
                        role="button"
                        tabindex="0"
                        onclick={() => loadConversation(conv.id)}
                        onkeydown={(e) => e.key === 'Enter' && loadConversation(conv.id)}
                        class="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl transition-all group cursor-pointer
                        {currentConversationId === conv.id ? 'bg-[#0E3A2F]/20 text-[#78FAAE] border border-[#78FAAE]/20' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200 border border-transparent'}"
                    >
                        <div class="flex items-center gap-3 overflow-hidden">
                            <MessageSquare class="w-4 h-4 flex-shrink-0 {currentConversationId === conv.id ? 'text-[#78FAAE]' : 'text-slate-600'}" />
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

            <div class="p-4 border-t border-slate-800/50">
                <div class="relative">
                    <button 
                        onclick={() => isUserMenuOpen = !isUserMenuOpen}
                        class="w-full flex items-center gap-3 p-2 hover:bg-slate-900 rounded-xl transition-all border border-transparent hover:border-slate-800"
                    >
                        <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-[#0E3A2F] to-[#78FAAE] flex items-center justify-center text-[10px] font-bold shadow-lg shadow-[#0E3A2F]/20 text-[#0E3A2F]">
                            {user?.username.slice(0, 2).toUpperCase()}
                        </div>
                        <div class="flex-1 text-left overflow-hidden">
                            <p class="text-xs font-bold text-slate-200 truncate">{user?.username}</p>
                            <p class="text-[10px] text-slate-500 uppercase tracking-tighter">{user?.role}</p>
                        </div>
                        <ChevronDown class="w-4 h-4 text-slate-500 transition-transform {isUserMenuOpen ? 'rotate-180' : ''}" />
                    </button>

                    {#if isUserMenuOpen}
                        <div 
                            transition:fly={{ y: 10, duration: 200 }}
                            class="absolute bottom-full left-0 right-0 mb-2 bg-[#0f0f0f] border border-slate-800 rounded-2xl shadow-2xl py-2 z-50 overflow-hidden"
                        >
                            <a href="/knowledge" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition-colors uppercase tracking-wider">
                                <Network class="w-4 h-4 text-cyan-400" />
                                Knowledge Graph
                            </a>
                            <a href="/wiki" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition-colors uppercase tracking-wider">
                                <BookOpen class="w-4 h-4 text-emerald-400" />
                                Wiki
                            </a>
                            <a href="/about" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition-colors uppercase tracking-wider">
                                <Info class="w-4 h-4 text-purple-400" />
                                About
                            </a>
                            <div class="my-1 border-t border-slate-800/50"></div>
                            {#if user?.role === 'admin'}
                                <a href="/admin" class="flex items-center gap-3 px-4 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition-colors uppercase tracking-wider">
                                    <LayoutDashboard class="w-4 h-4 text-[#78FAAE]" />
                                    Admin Dashboard
                                </a>
                                <div class="my-1 border-t border-slate-800/50"></div>
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
    <main class="flex-1 flex flex-col relative w-full bg-[#050505]">
        <header class="h-14 px-4 border-b border-slate-800/50 flex items-center justify-between bg-[#050505]/80 backdrop-blur-xl sticky top-0 z-10">
            <div class="flex items-center gap-4">
                <a href="/wiki" class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-[#78FAAE]/50 transition-all group">
                    <BookOpen class="w-4 h-4 text-[#78FAAE] group-hover:scale-110 transition-transform" />
                    <span class="text-[10px] font-bold text-slate-400 group-hover:text-white uppercase tracking-widest">Wiki</span>
                </a>
                {#if !isSidebarOpen}
                    <button 
                        onclick={() => isSidebarOpen = true}
                        class="p-1.5 hover:bg-slate-800 rounded-lg text-slate-500 transition-colors"
                    >
                        <PanelLeftOpen class="w-4 h-4" />
                    </button>
                {/if}
            </div>

            <div class="flex items-center gap-3">
                <div class="h-4 w-px bg-slate-800"></div>
                <span class="text-[10px] font-bold text-slate-600 uppercase tracking-widest">v1.0.4</span>
            </div>
        </header>

        <div class="flex-1 overflow-y-auto p-4 space-y-8 scroll-smooth custom-scrollbar">
            {#if messages.length === 0}
                <div class="h-full flex flex-col items-center justify-center text-center space-y-6 max-w-md mx-auto" in:fade>
                    <div class="w-16 h-16 rounded-3xl bg-gradient-to-br from-[#0E3A2F] to-[#78FAAE] flex items-center justify-center shadow-2xl shadow-[#0E3A2F]/40 rotate-12">
                        <Bot class="w-8 h-8 text-[#0E3A2F]" />
                    </div>
                    <div class="space-y-2">
                        <h2 class="text-xl font-black tracking-tight text-white">How can I help you today?</h2>
                        <p class="text-sm text-slate-500 leading-relaxed">
                            Ask me anything about your documents. I can search through your knowledge base and provide precise answers with sources.
                        </p>
                    </div>
                    <div class="grid grid-cols-2 gap-3 w-full">
                        <button class="p-3 rounded-2xl bg-slate-900/50 border border-slate-800 hover:border-[#78FAAE]/50 transition-all text-left group">
                            <p class="text-[10px] font-bold text-[#78FAAE] uppercase tracking-wider mb-1">Analyze</p>
                            <p class="text-xs text-slate-400 group-hover:text-slate-200 transition-colors">Summarize the latest project docs</p>
                        </button>
                        <button class="p-3 rounded-2xl bg-slate-900/50 border border-slate-800 hover:border-[#78FAAE]/50 transition-all text-left group">
                            <p class="text-[10px] font-bold text-[#78FAAE] uppercase tracking-wider mb-1">Search</p>
                            <p class="text-xs text-slate-400 group-hover:text-slate-200 transition-colors">Find technical specs for TS-FIV</p>
                        </button>
                    </div>
                </div>
            {/if}

            {#each messages as msg, i}
                <MessageBubble {msg} />
            {/each}

            {#if isChatting}
                <div class="flex justify-start" in:fade>
                    <div class="flex space-x-4">
                        <div class="w-9 h-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                            <Bot class="w-5 h-5 text-[#78FAAE] animate-pulse" />
                        </div>
                        <div class="bg-[#0f0f0f] border border-slate-800/50 p-5 rounded-2xl rounded-tl-none shadow-inner flex items-center gap-3">
                            <div class="flex gap-1">
                                <div class="w-1.5 h-1.5 bg-[#78FAAE] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                <div class="w-1.5 h-1.5 bg-[#78FAAE] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                <div class="w-1.5 h-1.5 bg-[#78FAAE] rounded-full animate-bounce"></div>
                            </div>
                            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Archie is thinking</span>
                        </div>
                    </div>
                </div>
            {/if}
        </div>

        <footer class="p-6 bg-gradient-to-t from-[#050505] via-[#050505] to-transparent">
            <div class="max-w-4xl mx-auto relative group">
                <div class="absolute -inset-1 bg-gradient-to-r from-[#0E3A2F] to-[#78FAAE] rounded-2xl blur opacity-20 group-focus-within:opacity-40 transition duration-500"></div>
                <textarea 
                    bind:value={currentPrompt}
                    onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleChat())}
                    placeholder="Ask anything about your documents..."
                    class="relative w-full bg-[#0a0a0a] border border-slate-800 rounded-2xl py-5 pl-6 pr-16 focus:outline-none focus:border-[#78FAAE]/50 transition-all resize-none shadow-2xl text-sm text-slate-200 placeholder:text-slate-600"
                    rows="1"
                ></textarea>
                <button
                    onclick={() => handleChat()}
                    disabled={!currentPrompt.trim() || isChatting}
                    class="absolute right-3 bottom-3 p-2.5 bg-[#0E3A2F] hover:bg-[#0E3A2F]/80 text-[#78FAAE] disabled:bg-slate-800 disabled:text-slate-600 rounded-xl transition-all shadow-lg shadow-[#0E3A2F]/20 border border-[#78FAAE]/20"
                >
                    <Send class="w-5 h-5" />
                </button>
            </div>
            <div class="flex items-center justify-center gap-6 mt-4">
                <p class="text-[9px] text-slate-700 uppercase tracking-[0.3em] font-black">
                    Powered by SQLite-Vector & Gemini AI
                </p>
            </div>
        </footer>
    </main>
</div>

<style>
    :global(body) {
        margin: 0;
        background: #050505;
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
        background: #1a1a1a;
        border-radius: 10px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
        background: #2a2a2a;
    }

    :global(.prose pre) {
        background: #0a0a0a !important;
        border: 1px solid #1a1a1a;
        border-radius: 12px;
    }

    :global(.prose code) {
        color: #78FAAE !important;
        font-family: 'JetBrains Mono', monospace;
    }
</style>
