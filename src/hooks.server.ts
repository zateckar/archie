import 'dotenv/config';

import { initAutoSync } from '$lib/server/git';
import { initLeanixSync } from '$lib/server/leanix';
import { initMarketResearch } from '$lib/server/market-research';

import { db } from '$lib/server/db';
import { hashPassword, purgeExpiredSessions } from '$lib/server/auth';
import { ensureEmbeddingsMigrated } from '$lib/server/rag';
import { warmVectorIndexes } from '$lib/server/vector-index';

// ── Production safety: require explicit ADMIN_PASSWORD ──
if (process.env.NODE_ENV === 'production') {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw || pw === 'admin') {
        console.error('[FATAL] In production you must set ADMIN_PASSWORD to a secure value.');
        process.exit(1);
    }
}

// ── Seed default admin if no users exist ──
(async () => {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
        const defaultPassword = process.env.ADMIN_PASSWORD || 'admin';
        const hash = await hashPassword(defaultPassword);
        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
        console.log('Created default admin user with username: admin');
    } else {
        // Ensure admin user exists and has correct admin role
        const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get('admin') as { id: number; username: string; password_hash: string; role: string } | undefined;
        if (adminUser) {
            if (adminUser.role !== 'admin') {
                db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run('admin');
                console.log("Ensured admin user has 'admin' role.");
            }
            if (adminUser.password_hash && (adminUser.password_hash.startsWith('sha256:') || !adminUser.password_hash.startsWith('scrypt:'))) {
                const defaultPassword = process.env.ADMIN_PASSWORD || 'admin';
                const hash = await hashPassword(defaultPassword);
                db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
                console.log('Upgraded admin password hash to scrypt.');
            }
        } else {
            // If no admin user exists, but other users exist, let's create a default admin
            const defaultPassword = process.env.ADMIN_PASSWORD || 'admin';
            const hash = await hashPassword(defaultPassword);
            db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
            console.log('Created missing default admin user with username: admin');
        }
    }
})();

// Auto-migrate embeddings if the configured embedding model's vector dimension
// no longer matches the stored corpus (e.g. after switching to the LiteLLM /
// Qwen 4096-dim embedder). Runs once at boot, BEFORE any search locks the
// vector index to the stale dimension, and re-embeds the corpus if needed.
// Fire-and-forget: it never throws, and searches trigger the same guarded run
// via ensureVectorInit if a request somehow arrives before boot finishes.
// Once the corpus dimension is settled, build the TurboQuant structures the
// vector searches use (see lib/server/vector-index.ts). Deliberately AFTER the
// migration: quantizing vectors that a re-embed is about to replace would be
// wasted work, and searches remain exact-but-correct until this finishes.
ensureEmbeddingsMigrated().then(() => warmVectorIndexes());

// Initialize auto-sync on server start
initAutoSync();

// The LeanIX datasource syncs once a day and is a no-op when unconfigured.
// Deliberately not on the git timer: that one ticks every minute to serve
// hour-scale intervals, and this one guards a day.
initLeanixSync();

// Market research reads the web about what that sync brought in. Separate timer
// because it answers a different question on a different clock — and because it
// is the one scheduled job here billed per item, so its first run is held back
// until well after boot rather than competing with ingestion.
initMarketResearch();

// ── Expired-session collection ───────────────────────────────────────────────
// validateSession only removes the single expired row it happens to be handed,
// so sessions belonging to users who simply stopped visiting were never
// collected. Sweep at boot, then daily. Unref'd so the timer alone doesn't hold
// the process open.
try {
    const purged = purgeExpiredSessions();
    if (purged > 0) console.log(`[Sessions] Purged ${purged} expired session(s) at boot.`);
} catch (e) {
    console.error('[Sessions] Boot purge failed:', e);
}
const sessionPurgeTimer = setInterval(() => {
    try {
        const purged = purgeExpiredSessions();
        if (purged > 0) console.log(`[Sessions] Purged ${purged} expired session(s).`);
    } catch (e) {
        console.error('[Sessions] Periodic purge failed:', e);
    }
}, 24 * 60 * 60 * 1000);
sessionPurgeTimer.unref?.();

import { validateSession } from '$lib/server/auth';
import { authenticateMcpRequest } from '$lib/server/mcp/auth';

/**
 * Segment-aware prefix match for route guards.
 *
 * Plain `pathname.startsWith(prefix)` matches a *character* prefix, so a guard
 * on `/api/users` also claims a hypothetical `/api/users-public`, and — worse in
 * the other direction — a future `/api/knowledgebase` would be silently swept
 * under the `/api/knowledge` guard. Requiring the prefix to end at a path
 * boundary makes the guard mean what it reads as.
 */
function matchesRoute(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function jsonError(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * The complete set of paths reachable without a session. Everything not listed
 * here requires an authenticated user — the guard below is deny-by-default, so
 * a new route is protected the moment it exists rather than when someone
 * remembers to add it to a list of protected prefixes.
 *
 * `/login` covers both the page and its form action (SvelteKit posts actions to
 * the same pathname with `?/login`). `/api/auth` covers the OIDC start and
 * callback plus logout, none of which can require a session by definition.
 *
 * `/api/health` is the one deliberate exception beyond sign-in: the container
 * healthcheck in docker-compose.yml fetches it with no credentials, and with
 * `restart: always` a 401 there would put the deployment in a restart loop. It
 * discloses nothing but a boolean liveness verdict (see routes/api/health).
 *
 * `/.well-known/oauth-protected-resource` is public because it has to be: it is
 * what an MCP client reads, *before* it has any credential, to discover which
 * authorization server to send the user to (RFC 9728). It discloses only the
 * issuer this deployment already redirects browsers to, and the path-aware
 * variant for the MCP endpoint hangs beneath the same prefix.
 */
const PUBLIC_ROUTES = ['/login', '/api/auth', '/api/health', '/.well-known/oauth-protected-resource'];

function isPublicRoute(pathname: string): boolean {
    return PUBLIC_ROUTES.some(route => matchesRoute(pathname, route));
}

/**
 * The one route authenticated by an OAuth access token rather than the session
 * cookie — and, deliberately, ONLY by one.
 *
 * The session cookie is not accepted here even when present. MCP's authorization
 * model is OAuth 2.1: a client discovers the authorization server from this
 * server's metadata, sends the user through it, and presents the resulting token
 * (see lib/server/mcp/auth.ts). Letting a cookie in as well would mean two ways
 * to reach the same tools, one of which no MCP client can produce and no
 * authorization server can revoke — so the guarantee "everything /api/mcp does
 * happened under a token the IdP issued and can withdraw" would stop holding.
 */
const OAUTH_ROUTE = '/api/mcp';

export async function handle({ event, resolve }) {
    const sessionId = event.cookies.get('session');
    if (sessionId) {
        const result = validateSession(sessionId);
        if (result) {
            event.locals.user = result.user;
            event.locals.session = result.session;
        } else {
            event.locals.user = null;
            event.locals.session = null;
            event.cookies.delete('session', { path: '/' });
        }
    } else {
        event.locals.user = null;
        event.locals.session = null;
    }

    const pathname = event.url.pathname;
    const isApi = matchesRoute(pathname, '/api');

    // ── OAuth 2.1 bearer authentication for MCP ──────────────────────────────
    // Runs instead of the cookie check, not after it (see OAUTH_ROUTE), and
    // returns the RFC 6750 challenge itself: the `WWW-Authenticate` header is how
    // a client discovers where to authorize, so a bare 401 would leave it unable
    // to do anything but report failure.
    if (matchesRoute(pathname, OAUTH_ROUTE)) {
        const outcome = await authenticateMcpRequest(event.request, event.url.origin);
        if (!outcome.ok) {
            // `error` is the RFC 6750 code when there is one. Absent, it depends on
            // which way the failure went: a 500 body reading "unauthorized" would
            // send a client off to re-authorize against a provider that is the thing
            // actually broken.
            const code = outcome.error ?? (outcome.status === 500 ? 'server_error' : 'unauthorized');
            return new Response(
                JSON.stringify({
                    error: code,
                    error_description: outcome.description
                }),
                {
                    status: outcome.status,
                    headers: {
                        'Content-Type': 'application/json',
                        'WWW-Authenticate': outcome.challenge
                    }
                }
            );
        }
        event.locals.user = outcome.user;
        // No session row exists behind an access token, and inventing one would let
        // a token holder be signed out — or have their credential expire — through
        // a table they have no row in. The token's own expiry is the authority.
        event.locals.session = null;
    }

    // ── Deny-by-default authentication ───────────────────────────────────────
    // Every route except PUBLIC_ROUTES requires a session. This replaced two
    // allowlists (protected API prefixes, protected page prefixes) which only
    // covered the surfaces someone had remembered to enumerate: `/about` and the
    // chat root's own API-adjacent routes were reachable anonymously, and any new
    // route shipped public until it was added to a list. Inverting the default
    // means an unguarded route is now impossible to create by omission.
    //
    // APIs get a 401 so fetch callers can distinguish "signed out" from a
    // redirect to HTML they can't parse; page loads get sent to sign-in with the
    // original path in `redirectTo` so the user lands where they were headed.
    if (!isPublicRoute(pathname)) {
        if (!event.locals.user) {
            if (isApi) return jsonError('Unauthorized', 401);
            const target = `${pathname}${event.url.search}`;
            return new Response(null, {
                status: 302,
                headers: { Location: `/login?redirectTo=${encodeURIComponent(target)}` }
            });
        }
    }

    // ── Role checks (all of these imply an authenticated user, guaranteed above) ──

    // Admin-only API surfaces. The knowledge entries are checked before anything
    // keyed on the `/api/knowledge` prefix, because they are nested under it.
    const adminRoutes = [
        '/api/git',
        '/api/documents',
        '/api/users',
        '/api/knowledge/reprocess',
        '/api/knowledge/backfill',
        // Triggering a LeanIX sync is an operator action (it spends LLM budget on
        // whatever changed). Reading the portfolio is not: the /leanix page loads
        // its data server-side and is available to any signed-in user.
        '/api/leanix'
    ];
    if (adminRoutes.some(route => matchesRoute(pathname, route))) {
        if (event.locals.user!.role !== 'admin') {
            return jsonError('Forbidden', 403);
        }
    }

    // Admin pages. `admin/+layout.server.ts` also redirects non-admins, but that
    // guard lives on a layout load and so covers only what SvelteKit routes
    // through it; keeping the check here means an admin API added under
    // `/admin/...` (or a page that forgets the layout) cannot leak.
    if (matchesRoute(pathname, '/admin') && event.locals.user!.role !== 'admin') {
        if (isApi) return jsonError('Forbidden', 403);
        return new Response(null, { status: 302, headers: { Location: '/' } });
    }

    // Only admin and contributor can modify the wiki (POST/PUT/DELETE)
    if (matchesRoute(pathname, '/api/wiki') && event.request.method !== 'GET') {
        if (event.locals.user!.role !== 'admin' && event.locals.user!.role !== 'contributor') {
            return jsonError('Forbidden', 403);
        }
    }

    const response = await resolve(event);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    return response;
}
