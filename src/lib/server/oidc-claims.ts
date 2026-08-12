/**
 * Reading an identity out of a set of OIDC claims.
 *
 * Pure, and separate from ./oidc-user, because "which claims name this person"
 * is a rule worth testing while "insert a row for them" needs a database. The
 * browser flow gets its claims from a userinfo response; the MCP resource server
 * gets them from an access token, which frequently carries fewer.
 */

export interface OidcIdentityClaims {
    /** The provider's stable subject identifier. The real identity key. */
    sub: string;
    /**
     * Profile values to store. The distinction matters:
     *  - a string or `null` is information ("this is the name" / "there is none")
     *    and overwrites what is stored;
     *  - `undefined` means the caller does not know, and leaves the column alone.
     *
     * The browser callback reads a full userinfo response and so passes `null` for
     * absent claims; an access token often carries neither, and must not wipe a
     * profile that userinfo already filled in.
     */
    preferred_username?: string | null;
    email?: string | null;
    name?: string | null;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Maps raw claims (from a token payload or a userinfo response) onto an identity.
 *
 * Absent claims stay `undefined` rather than becoming `null`: a lean access token
 * is not evidence that someone has no email address, and treating it as such
 * would blank out the profile that the web sign-in stored.
 *
 * Returns null when there is no subject — nothing can be mapped without one.
 */
export function identityClaimsFrom(claims: Record<string, unknown>): OidcIdentityClaims | null {
    const sub = optionalString(claims.sub);
    if (!sub) return null;
    return {
        sub,
        preferred_username: optionalString(claims.preferred_username),
        // `name` is the OIDC display name; some providers only send the split
        // given/family pair, so fall back to joining those rather than showing a
        // raw subject id in the admin users table.
        name: optionalString(claims.name) ?? joinedName(claims),
        email: optionalString(claims.email)
    };
}

function joinedName(claims: Record<string, unknown>): string | undefined {
    const given = optionalString(claims.given_name);
    const family = optionalString(claims.family_name);
    const joined = [given, family].filter(Boolean).join(' ');
    return joined.length > 0 ? joined : undefined;
}

/**
 * Whether a userinfo round trip is worth making before creating an account.
 *
 * Only for a *new* user, and only when the token names them in no human-readable
 * way: the username would otherwise be a raw UUID subject, which is what an admin
 * looking at the users table has to identify. For a user who already exists there
 * is nothing to learn that is worth an HTTP request per session.
 */
export function shouldFetchUserinfo(claims: OidcIdentityClaims, userExists: boolean): boolean {
    if (userExists) return false;
    return !claims.preferred_username && !claims.email;
}
