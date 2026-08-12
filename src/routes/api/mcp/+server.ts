import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '$lib/server/mcp/server';
import { checkRateLimit } from '$lib/server/rate-limit';
import { bearerChallenge, resourceMetadataUrl } from '$lib/server/oauth-resource';
import type { RequestHandler } from './$types';

/**
 * The MCP endpoint: Archie's chat, spoken as Model Context Protocol.
 *
 * Transport is Streamable HTTP, which the SDK implements over Web Standard
 * `Request`/`Response` — so it drops straight into SvelteKit with no Node
 * stream shims. The tools themselves are in `$lib/server/mcp/server`.
 *
 * ── Authorization ────────────────────────────────────────────────────────────
 * OAuth 2.1, with the app's configured OIDC provider as the authorization server
 * and this endpoint as the protected resource. `hooks.server.ts` runs the check
 * (see OAUTH_ROUTE there) and returns the 401 with its `WWW-Authenticate:
 * … resource_metadata="…"` challenge, which is what points a client at
 * `/.well-known/oauth-protected-resource/api/mcp` and from there at the issuer.
 * By the time a request reaches this file `locals.user` is the user named by a
 * verified access token; the guard below is a belt-and-braces assertion, not the
 * check.
 *
 * ── Stateless, one server per request ────────────────────────────────────────
 * No `sessionIdGenerator`, so no MCP session state is kept between requests. The
 * MCP server object is built per request from the authenticated user, which is
 * what makes it impossible for one user's tools to answer another's call: there
 * is no shared, long-lived server whose identity could drift from the caller's.
 * It also means the deployment can be restarted or scaled without invalidating
 * anyone's client, since there is nothing to resume.
 *
 * Responses stream as SSE (the transport's default) rather than a single JSON
 * body: `ask` routinely runs for tens of seconds, and the transport's periodic
 * keep-alive frames are what stop an idle-timeout proxy between the client and
 * this server from severing an answer that is still being written.
 */

/**
 * Ceiling on MCP requests per user per minute.
 *
 * Generous, because it is not the interesting limit: `ask` is separately capped
 * by CHAT_RATE_LIMIT inside the pipeline, which is where the provider spend is.
 * This one exists so a looping agent calling the cheap read tools cannot pin the
 * database, and it is high enough that no real client sequence approaches it.
 */
const MCP_RATE_LIMIT = { max: Number(process.env.MCP_RATE_LIMIT_PER_MIN) || 120, windowMs: 60_000 };

function jsonRpcError(status: number, code: number, message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
    const user = locals.user;
    if (!user) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }), {
            status: 401,
            headers: {
                'Content-Type': 'application/json',
                'WWW-Authenticate': bearerChallenge({ resourceMetadataUrl: resourceMetadataUrl(url.origin) })
            }
        });
    }

    const { allowed, resetAt } = checkRateLimit(`mcp:${user.id}`, MCP_RATE_LIMIT);
    if (!allowed) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        return new Response(
            JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: `Too many requests. Try again in ${retryAfter} seconds.` },
                id: null
            }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } }
        );
    }

    const server = createMcpServer(user);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    // Deliberately not closed here. In SSE mode `handleRequest` resolves as soon
    // as the response stream exists — the tool call is still running — so closing
    // now would cut the answer off. The transport ends its own stream when the
    // last response for the request has been written (and clears its keep-alive
    // timer if the client disconnects first), after which both objects are
    // garbage; there is no per-request state outside them.
    return transport.handleRequest(request);
};

/**
 * The spec lets a server decline the optional halves of Streamable HTTP, and this
 * one does.
 *
 * GET would open a standalone SSE stream for server-initiated messages: we send
 * none, and a stateless server cannot resume one, so accepting it would only leak
 * a keep-alive timer per client. DELETE terminates a session, and there are no
 * sessions here. Clients treat 405 on both as "this server does not offer that"
 * and carry on with POST, which is the whole protocol as far as tools are
 * concerned.
 */
const methodNotAllowed: RequestHandler = async () =>
    jsonRpcError(405, -32000, 'Method Not Allowed: this MCP endpoint accepts POST only');

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
