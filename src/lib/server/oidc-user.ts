import { db } from './db';
import { sessionUserById, type SessionUser } from './auth';
import type { OidcIdentityClaims } from './oidc-claims';

/**
 * Mapping an identity-provider subject onto a local user row.
 *
 * Extracted from `/api/auth/callback` so the browser sign-in and the MCP resource
 * server provision identities the same way. They must: both see the same `sub`
 * from the same provider, and two different mapping rules would eventually hand
 * one person two accounts — or, far worse, hand one person another's account.
 *
 * Which claims carry the identity, and what `undefined` versus `null` means among
 * them, is ./oidc-claims.
 */

/** The id of an already-provisioned OIDC identity, or null. */
export function existingOidcUserId(sub: string): number | null {
    const row = db
        .prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?')
        .get('oidc', sub) as { id: number } | undefined;
    return row?.id ?? null;
}

/**
 * Finds or creates the local user for an OIDC subject, and returns it in the same
 * projected shape a cookie session produces.
 *
 * Returns null only if the row cannot be read back, which would mean the insert
 * raced with a delete.
 */
export function provisionOidcUser(claims: OidcIdentityClaims): SessionUser | null {
    const existingId = existingOidcUserId(claims.sub);

    if (existingId === null) {
        // `users.username` is UNIQUE across providers, so an OIDC identity whose
        // preferred_username collides with an existing local account (the seeded
        // `admin`, most plausibly) previously threw a raw UNIQUE constraint error
        // and surfaced as a blank 500 with the cause visible only in server logs.
        //
        // The collision must NOT be resolved by adopting the existing row — that
        // would hand whoever controls the IdP username the local account, admin
        // included. Instead the OIDC identity gets a distinct, suffixed username;
        // `provider_id` remains the real identity key, and display_name still shows
        // the human-readable name in the UI.
        const desiredUsername = claims.preferred_username || claims.email || claims.sub;
        const username = usernameFor(desiredUsername, claims.sub);
        const result = db
            .prepare(
                'INSERT INTO users (username, role, provider, provider_id, display_name, email) VALUES (?, ?, ?, ?, ?, ?)'
            )
            .run(
                username,
                'user', // default role
                'oidc',
                claims.sub,
                claims.name ?? null,
                claims.email ?? null
            );
        return sessionUserById(Number(result.lastInsertRowid));
    }

    // Keep claims current and backfill users created before these columns existed —
    // but only for claims the caller actually knows (see OidcIdentityClaims).
    const updates: string[] = [];
    const values: (string | null)[] = [];
    if (claims.name !== undefined) {
        updates.push('display_name = ?');
        values.push(claims.name);
    }
    if (claims.email !== undefined) {
        updates.push('email = ?');
        values.push(claims.email);
    }
    if (updates.length > 0) {
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values, existingId);
    }

    return sessionUserById(existingId);
}

/**
 * A free username for a new OIDC identity.
 *
 * The suffix is deterministic and collision-free because `sub` is unique per IdP
 * subject, so a retried sign-in produces the same name rather than a second row.
 */
function usernameFor(desired: string, sub: string): string {
    const taken = (name: string) => !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(name);
    if (!taken(desired)) return desired;

    const suffixed = `${desired}@oidc-${String(sub).slice(0, 12)}`;
    console.warn(
        `[OIDC] Username "${desired}" is already taken by another account; ` +
            `provisioning this OIDC identity as "${suffixed}" instead.`
    );
    return suffixed;
}
