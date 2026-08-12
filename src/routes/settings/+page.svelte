<script lang="ts">
    import ChevronLeft from '@lucide/svelte/icons/chevron-left';
    import Copy from '@lucide/svelte/icons/copy';
    import Check from '@lucide/svelte/icons/check';
    import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
    import CircleCheck from '@lucide/svelte/icons/circle-check';
    import Terminal from '@lucide/svelte/icons/terminal';
    import Plug from '@lucide/svelte/icons/plug';
    import ShieldCheck from '@lucide/svelte/icons/shield-check';
    import ThemeToggle from '$lib/components/ThemeToggle.svelte';

    let { data } = $props();

    let copied = $state<string | null>(null);
    let copyError = $state<string | null>(null);

    async function copy(text: string, key: string) {
        try {
            await navigator.clipboard.writeText(text);
            copied = key;
            setTimeout(() => (copied = copied === key ? null : copied), 1500);
        } catch {
            // Clipboard access can be refused (insecure origin, denied permission).
            // The text is on screen and selectable, so say so rather than failing
            // silently.
            copyError = 'Copying was blocked by the browser — select the text and copy it manually.';
        }
    }

    const cliCommand = $derived(`claude mcp add --transport http archie ${data.mcpUrl}`);

    const jsonConfig = $derived(
        JSON.stringify({ mcpServers: { archie: { type: 'http', url: data.mcpUrl } } }, null, 2)
    );

    /** Ready to connect only when there is an issuer and we can actually reach it. */
    const ready = $derived(!!data.issuer && !!data.idp?.reachable);
</script>

<svelte:head><title>Settings · Archie</title></svelte:head>

<div class="min-h-screen p-6 max-w-4xl mx-auto">
    <nav class="mb-5 flex items-center justify-between">
        <a href="/" class="btn btn-ghost btn-sm -ml-2.5">
            <ChevronLeft class="w-4 h-4" />
            Back to chat
        </a>
        <ThemeToggle />
    </nav>

    <header class="mb-6">
        <h1 class="page-title">Connect apps</h1>
        <p class="page-subtitle mt-1 max-w-2xl">
            Archie speaks Model Context Protocol, so an AI assistant — Claude Code, Claude Desktop, or
            anything else that speaks MCP — can ask the knowledge base from your editor instead of this
            page. Signing in happens through the same identity provider you use here; the client gets its
            own access token and there is nothing to copy or keep secret.
        </p>
    </header>

    {#if copyError}
        <div class="card p-4 mb-5 border-danger" role="alert">
            <p class="text-[13px] text-danger flex items-start gap-2">
                <TriangleAlert class="w-4 h-4 flex-shrink-0 mt-0.5" />
                {copyError}
            </p>
        </div>
    {/if}

    <!-- ── Readiness ─────────────────────────────────────────────────────── -->
    <section class="card p-5">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-body">
            <ShieldCheck class="w-4 h-4 text-faint" />
            Authorization
        </h2>

        {#if !data.issuer}
            <p class="text-[13px] text-body mt-3 flex items-start gap-2">
                <TriangleAlert class="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <span>
                    No identity provider is configured, so MCP access cannot be authorized. An administrator
                    needs to set <code class="font-mono">OIDC_ISSUER</code> and
                    <code class="font-mono">OIDC_CLIENT_ID</code> — MCP uses OAuth exclusively and has no
                    password or token fallback.
                </span>
            </p>
        {:else}
            <dl class="mt-3 divide-y divide-[var(--line-subtle)]">
                <div class="flex items-start justify-between gap-4 py-2.5">
                    <dt class="text-[13px] text-dim">Authorization server</dt>
                    <dd class="text-xs font-mono text-body text-right break-all">{data.issuer}</dd>
                </div>
                <div class="flex items-start justify-between gap-4 py-2.5">
                    <dt class="text-[13px] text-dim">Provider reachable</dt>
                    <dd>
                        {#if data.idp?.reachable}
                            <span class="badge badge-success">Yes</span>
                        {:else}
                            <span class="badge badge-danger">No</span>
                        {/if}
                    </dd>
                </div>
                <div class="flex items-start justify-between gap-4 py-2.5">
                    <dt class="text-[13px] text-dim">
                        Client self-registration
                        <span class="block text-xs text-faint mt-0.5">
                            Dynamic Client Registration (RFC 7591), which Claude clients rely on
                        </span>
                    </dt>
                    <dd>
                        {#if data.idp?.dynamicRegistration}
                            <span class="badge badge-success">Available</span>
                        {:else}
                            <span class="badge badge-warning">Not offered</span>
                        {/if}
                    </dd>
                </div>
                <div class="flex items-start justify-between gap-4 py-2.5">
                    <dt class="text-[13px] text-dim">
                        Expected token audience
                        <span class="block text-xs text-faint mt-0.5">
                            A token is accepted only if its <code class="font-mono">aud</code> matches
                        </span>
                    </dt>
                    <dd class="text-xs font-mono text-body text-right break-all">{data.audiences.join(', ')}</dd>
                </div>
            </dl>

            {#if !data.idp?.reachable}
                <p class="text-xs text-danger mt-3">
                    {data.idp?.reason ?? 'The provider’s discovery document could not be read.'}
                    Access tokens cannot be verified until this is fixed.
                </p>
            {/if}

            {#if data.idp?.reachable && !data.idp.dynamicRegistration}
                <p class="text-xs text-faint mt-3">
                    Clients that cannot self-register need a client ID created on the provider by an
                    administrator, and a client that accepts one (VS Code, or
                    <code class="font-mono">mcp-remote --client-id</code>).
                </p>
            {/if}
        {/if}
    </section>

    <!-- ── Connecting a client ───────────────────────────────────────────── -->
    <section class="card p-5 mt-5">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-body">
            <Plug class="w-4 h-4 text-faint" />
            Connect a client
        </h2>
        <p class="text-xs text-faint mt-1">
            Add the endpoint below. On first use the client opens a browser, you sign in as usual, and it
            keeps the token it receives.
            {#if !ready}
                <span class="text-warning">Authorization is not ready yet — see above.</span>
            {/if}
        </p>

        <div class="mt-4">
            <div class="flex items-center justify-between gap-2">
                <p class="text-[13px] font-medium text-body flex items-center gap-1.5">
                    <Terminal class="w-3.5 h-3.5 text-faint" />
                    Claude Code
                </p>
                <button class="btn btn-ghost btn-sm" onclick={() => copy(cliCommand, 'cli')}>
                    {#if copied === 'cli'}<Check class="w-4 h-4" />Copied{:else}<Copy class="w-4 h-4" />Copy{/if}
                </button>
            </div>
            <pre class="mt-1.5 text-xs font-mono bg-raised border border-line rounded-lg p-3 overflow-x-auto"><code>{cliCommand}</code></pre>
            <p class="text-xs text-faint mt-1.5">
                Then run <code class="font-mono">/mcp</code> in Claude Code and choose to authenticate.
            </p>
        </div>

        <div class="mt-4">
            <div class="flex items-center justify-between gap-2">
                <p class="text-[13px] font-medium text-body">Other clients (JSON config)</p>
                <button class="btn btn-ghost btn-sm" onclick={() => copy(jsonConfig, 'json')}>
                    {#if copied === 'json'}<Check class="w-4 h-4" />Copied{:else}<Copy class="w-4 h-4" />Copy{/if}
                </button>
            </div>
            <pre class="mt-1.5 text-xs font-mono bg-raised border border-line rounded-lg p-3 overflow-x-auto"><code>{jsonConfig}</code></pre>
            <p class="text-xs text-faint mt-1.5">
                For a client that only speaks stdio, bridge it with
                <code class="font-mono">npx mcp-remote {data.mcpUrl}</code>, which runs the same OAuth flow.
            </p>
        </div>

        <div class="mt-5 pt-4 border-t border-line-subtle">
            <p class="text-[13px] font-medium text-body">What the client can do</p>
            <ul class="mt-2 space-y-1 text-xs text-dim">
                <li><code class="font-mono text-faint">ask</code> — a grounded, cited answer; the same pipeline as this chat</li>
                <li><code class="font-mono text-faint">search_knowledge</code> — topics and facts, without writing an answer</li>
                <li><code class="font-mono text-faint">list_conversations</code> / <code class="font-mono text-faint">get_conversation</code> — your threads, shared with this page</li>
                <li><code class="font-mono text-faint">pin_conversation</code> / <code class="font-mono text-faint">delete_conversation</code> — the same rules as the sidebar</li>
                <li><code class="font-mono text-faint">rate_answer</code> — thumbs up or down on an answer</li>
            </ul>
            <p class="text-xs text-faint mt-3">
                A client acts as you: it sees your conversations and nothing else, and it cannot reach the
                admin APIs or the wiki whatever your role.
            </p>
        </div>
    </section>

    {#if data.isAdmin}
        <!-- ── Administrator notes ───────────────────────────────────────── -->
        <section class="card p-5 mt-5">
            <h2 class="text-sm font-semibold text-body">Provider configuration</h2>
            <p class="text-xs text-faint mt-1">
                Two things must be true on <code class="font-mono">{data.issuer ?? 'the identity provider'}</code>
                for a client to connect:
            </p>
            <ol class="mt-3 space-y-2.5 text-xs text-dim list-decimal list-inside">
                <li>
                    Tokens issued for this server carry an audience Archie accepts. Either the provider honours
                    the <code class="font-mono">resource</code> parameter (RFC 8707) and stamps
                    <code class="font-mono">{data.mcpUrl}</code>, or add an audience mapper and set
                    <code class="font-mono">MCP_OAUTH_AUDIENCE</code> to whatever it emits.
                    {#if data.audiences.length > 0}
                        Currently accepting: <code class="font-mono">{data.audiences.join(', ')}</code>.
                    {/if}
                </li>
                <li>
                    MCP clients can obtain a client ID — either by enabling dynamic client registration, or by
                    pre-registering a public client (authorization code + PKCE, with the client's loopback
                    redirect URI) and giving users its ID.
                </li>
            </ol>
            <p class="text-xs text-faint mt-3">
                Metadata clients read: <code class="font-mono break-all">{data.metadataUrl}</code>
            </p>
        </section>
    {/if}
</div>
