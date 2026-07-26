import { db } from './db';
import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24; // 24 hours for production

/**
 * The shape handed to `event.locals.user`, and therefore the shape that
 * `+layout.server.ts` serializes into the SSR payload and `$page.data.user`.
 *
 * This type exists to make that blast radius explicit. `validateSession` used to
 * `SELECT *`, which meant `password_hash` — the scrypt salt AND derived key —
 * was shipped to every authenticated browser on every page load, turning any XSS
 * into an offline cracking target. Nothing outside this module needs a secret,
 * so nothing outside this module gets one: add a field here only if a client
 * genuinely needs to render it.
 */
export interface SessionUser {
    id: number;
    username: string;
    role: string;
    provider: string;
    display_name: string | null;
    email: string | null;
}

/**
 * Explicit column list for the above. Written out rather than `SELECT *` so
 * adding a secret-bearing column to `users` cannot silently widen what reaches
 * the client — the leak this replaced was exactly that failure mode.
 */
const SESSION_USER_COLUMNS = 'id, username, role, provider, display_name, email';

/**
 * Hash a password using scrypt (salt + CPU/memory-hard KDF).
 * Returns a self-describing string: "scrypt:salt:derivedKey"
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 * Supports both the modern "scrypt:" format and legacy SHA-256 hashes
 * for backward compatibility.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<{ valid: boolean; needsUpgrade: boolean }> {
    // An OIDC-provisioned user has no password_hash at all, and a truncated or
    // hand-edited row can be present but unusable. Both are "wrong password",
    // not "crash": the previous version dereferenced `stored` unconditionally.
    if (!stored) return { valid: false, needsUpgrade: false };

    if (stored.startsWith('scrypt:')) {
        const [, salt, key] = stored.split(':');
        if (!salt || !key) return { valid: false, needsUpgrade: false };
        const expected = Buffer.from(key, 'hex');
        const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
        // timingSafeEqual THROWS on a length mismatch rather than returning
        // false, so a malformed stored hash produced a 500 on the login route
        // instead of a rejected login. Compare lengths first.
        if (expected.length !== derivedKey.length) return { valid: false, needsUpgrade: false };
        return { valid: crypto.timingSafeEqual(derivedKey, expected), needsUpgrade: false };
    }

    // Legacy SHA-256 fallback: accept but flag for upgrade. Compared with
    // timingSafeEqual for the same reason the scrypt branch is — `===` on a hex
    // string short-circuits at the first differing character and so leaks a
    // prefix-match oracle.
    const hash = crypto.createHash('sha256').update(password).digest();
    const storedBuf = Buffer.from(stored, 'hex');
    if (storedBuf.length !== hash.length) return { valid: false, needsUpgrade: false };
    return { valid: crypto.timingSafeEqual(hash, storedBuf), needsUpgrade: true };
}

export function createSession(userId: number) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt.toISOString());
    return { id: sessionId, expiresAt };
}

export function validateSession(sessionId: string) {
    const session = db.prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?').get(sessionId) as { id: string; user_id: number; expires_at: string } | undefined;
    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        return null;
    }
    // Projected, never `SELECT *` — see SessionUser. This row is what
    // `+layout.server.ts` hands to the browser.
    const user = db.prepare(`SELECT ${SESSION_USER_COLUMNS} FROM users WHERE id = ?`).get(session.user_id) as SessionUser | undefined;
    if (!user) return null;
    return { session, user };
}

/**
 * Deletes every session past its expiry.
 *
 * `validateSession` only ever cleans up the one session it was handed, so a row
 * belonging to a user who simply stopped visiting was never collected — the
 * table grew without bound for the lifetime of the deployment. Called at boot
 * and on a daily timer from hooks.server.ts.
 */
export function purgeExpiredSessions(): number {
    // Bound as an ISO-8601 string rather than compared against SQLite's
    // `datetime('now')`. createSession stores `Date.toISOString()`
    // ("2026-07-26T09:00:00.000Z"), whereas datetime('now') yields
    // "2026-07-26 09:00:00" — and in a lexicographic TEXT comparison the 'T' at
    // index 10 always sorts above the space, so `expires_at < datetime('now')`
    // is false for every row and the purge would silently delete nothing.
    // Two ISO strings in the same UTC format do compare correctly.
    const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    return result.changes;
}

export function invalidateSession(sessionId: string) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Validates a post-login destination, falling back to the root.
 *
 * Now that hooks.server.ts guards every route, arriving at sign-in from a deep
 * link is the normal case, and the interrupted path travels back to the server
 * through a query string (`/login?redirectTo=…`), a form field, and — for OIDC —
 * a cookie. All three are attacker-writable, so only a same-origin absolute path
 * is honoured: anything with a scheme, and protocol-relative `//host` (which a
 * browser resolves as an external origin despite the leading slash), is dropped.
 */
export function safeRedirectTarget(raw: string | null | undefined): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
    // A backslash is treated as a path separator by some browsers when resolving
    // Location, so `/\evil.example` can escape the origin the same way `//` does.
    if (raw.startsWith('/\\')) return '/';
    return raw;
}

/**
 * Full user row INCLUDING `password_hash` — for credential verification only.
 *
 * Deliberately not projected, unlike `validateSession`: the login action needs the
 * hash to check the password against. The distinction matters, so treat the return
 * value as secret-bearing and never assign it to `locals.user` or return it from a
 * load function or endpoint. Use `SessionUser` for anything the client sees.
 */
export function getUser(username: string) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: number; username: string; role: string; password_hash: string; provider: string } | undefined;
}

export function createUser(username: string, passwordHash: string | null, role: string = 'user', provider: string = 'local', providerId: string | null = null) {
    const result = db.prepare('INSERT INTO users (username, password_hash, role, provider, provider_id) VALUES (?, ?, ?, ?, ?)').run(username, passwordHash, role, provider, providerId);
    return result.lastInsertRowid;
}
