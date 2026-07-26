import 'dotenv/config';

import { initAutoSync } from '$lib/server/git';

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
 */
const PUBLIC_ROUTES = ['/login', '/api/auth', '/api/health'];

function isPublicRoute(pathname: string): boolean {
    return PUBLIC_ROUTES.some(route => matchesRoute(pathname, route));
}

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
        '/api/knowledge/backfill'
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
