import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { oidcConfig, requireIdpEndpoints, type IdpEndpoints, type OidcConfig } from './oidc-discovery';
import { acceptedAudiences, hasRequiredScopes, looksLikeJwt, parseScopes, requiredScopes } from './oauth-resource';

/**
 * Validating an access token the identity provider issued.
 *
 * Two mechanisms, because "access token" is not one thing. A provider that issues
 * signed JWTs (Keycloak's default) can be validated offline against its published
 * keys, which is fast and needs no credentials. A provider that issues opaque
 * tokens can only be asked — RFC 7662 introspection, using the client credentials
 * the app already has for sign-in. The first is tried when the token looks like a
 * JWT; the second is the fallback, and can be forced.
 *
 * Whichever path runs, the same four things are checked, and a failure of any of
 * them is `invalid_token`:
 *   - the signature (or the provider's own verdict, for introspection);
 *   - the issuer, against the configured OIDC_ISSUER;
 *   - the audience, against this server's resource identifier (see
 *     ./oauth-resource — this is the confused-deputy defence, and it is why a
 *     token minted for another service behind the same IdP does not work here);
 *   - expiry.
 */

export interface VerifiedToken {
    /** The provider's subject identifier. */
    sub: string;
    scopes: string[];
    /** The OAuth client the token was issued to, when the provider says. */
    clientId: string | null;
    /** Seconds since the epoch, when the provider says. */
    expiresAt: number | null;
    /** Everything the provider told us, for identity mapping. */
    claims: Record<string, unknown>;
    /** Which mechanism accepted it — surfaced in logs, not to clients. */
    via: 'jwt' | 'introspection';
}

export type TokenError = 'invalid_token' | 'insufficient_scope' | 'server_error';

export type VerifyResult =
    | { ok: true; token: VerifiedToken }
    | { ok: false; error: TokenError; description: string };

/** Tolerance for clock skew between this server and the provider. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * One JWKS per provider, cached for the process lifetime.
 *
 * `createRemoteJWKSet` does its own key caching and rate-limited refresh, so the
 * thing to avoid is constructing a *new* one per request — that would fetch the
 * key set on every call and lose the rotation handling with it.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(jwksUri: string): JWTVerifyGetKey {
    let jwks = jwksCache.get(jwksUri);
    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(jwksUri));
        jwksCache.set(jwksUri, jwks);
    }
    return jwks;
}

/** Drops cached keys and introspection results. For tests and config reloads. */
export function clearTokenCaches(): void {
    jwksCache.clear();
    introspectionCache.clear();
}

export interface VerifyOptions {
    /** The origin the request arrived on, for deriving the expected audience. */
    origin: string;
    /** Test seams. Production passes neither. */
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    /** Overrides the remote key set, so tests can sign with a local key. */
    keyResolver?: JWTVerifyGetKey;
}

export async function verifyAccessToken(rawToken: string, options: VerifyOptions): Promise<VerifyResult> {
    const env = options.env ?? process.env;
    const config = oidcConfig(env);
    if (!config) {
        // Not the client's fault, and not something a retry fixes: without an
        // identity provider there is no authority that could issue a valid token.
        return {
            ok: false,
            error: 'server_error',
            description: 'MCP access requires OIDC to be configured on this server (OIDC_ISSUER, OIDC_CLIENT_ID).'
        };
    }

    let endpoints: IdpEndpoints;
    try {
        // Deliberately the strict variant: a guessed jwks_uri could point at the
        // wrong keys, and "the wrong keys" is indistinguishable from "anyone may
        // mint tokens".
        endpoints = await requireIdpEndpoints(config, options.fetchImpl);
    } catch (e) {
        return { ok: false, error: 'server_error', description: (e as Error).message };
    }

    const audiences = acceptedAudiences(options.origin, env);
    const forceIntrospection = env.MCP_OAUTH_INTROSPECT?.trim().toLowerCase() === 'true';

    const result =
        !forceIntrospection && looksLikeJwt(rawToken)
            ? await verifyJwt(rawToken, endpoints, audiences, options)
            : await verifyByIntrospection(rawToken, config, endpoints, audiences, options);

    if (!result.ok) return result;

    const required = requiredScopes(env);
    if (!hasRequiredScopes(result.token.scopes, required)) {
        return {
            ok: false,
            error: 'insufficient_scope',
            description: `Token is missing required scope(s): ${required.filter((s) => !result.token.scopes.includes(s)).join(' ')}`
        };
    }

    return result;
}

async function verifyJwt(
    rawToken: string,
    endpoints: IdpEndpoints,
    audiences: string[],
    options: VerifyOptions
): Promise<VerifyResult> {
    try {
        const { payload } = await jwtVerify(rawToken, options.keyResolver ?? jwksFor(endpoints.jwksUri), {
            issuer: endpoints.issuer,
            audience: audiences,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            // `sub` is the identity this server maps to a user, so a token without
            // one cannot be honoured however well it is signed.
            requiredClaims: ['sub', 'aud', 'iss', 'exp']
        });

        const sub = typeof payload.sub === 'string' ? payload.sub : null;
        if (!sub) return { ok: false, error: 'invalid_token', description: 'Token has no subject claim.' };

        return {
            ok: true,
            token: {
                sub,
                scopes: parseScopes(payload.scope ?? (payload as Record<string, unknown>).scp),
                clientId: readClientId(payload),
                expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
                claims: payload as Record<string, unknown>,
                via: 'jwt'
            }
        };
    } catch (e) {
        // jose's messages are specific and safe to relay ("unexpected \"aud\"
        // claim value", "\"exp\" claim timestamp check failed"), and they are the
        // difference between a client retrying usefully and a user staring at
        // "unauthorized". They are sanitized before reaching a header.
        return { ok: false, error: 'invalid_token', description: (e as Error).message };
    }
}

interface CachedIntrospection {
    result: VerifyResult;
    expiresAt: number;
}

/**
 * Introspection responses, cached briefly and keyed by a hash of the token.
 *
 * Without this, every MCP request costs a round trip to the IdP — and an agent
 * looping over the cheap read tools would generate introspection traffic in step
 * with its own. Hashed rather than stored raw so a heap dump does not hand over
 * live credentials. Kept short so a revoked token stops working promptly, which
 * is the main reason to prefer introspection in the first place.
 */
const introspectionCache = new Map<string, CachedIntrospection>();
const INTROSPECTION_TTL_MS = 60_000;
const INTROSPECTION_FAILURE_TTL_MS = 5_000;
const INTROSPECTION_CACHE_MAX = 500;

async function verifyByIntrospection(
    rawToken: string,
    config: OidcConfig,
    endpoints: IdpEndpoints,
    audiences: string[],
    options: VerifyOptions
): Promise<VerifyResult> {
    if (!endpoints.introspectionEndpoint) {
        return {
            ok: false,
            error: 'invalid_token',
            description: 'Token is not a JWT and the identity provider advertises no introspection endpoint.'
        };
    }
    if (!config.clientSecret) {
        return {
            ok: false,
            error: 'server_error',
            description: 'Introspecting an opaque token requires OIDC_CLIENT_SECRET to be set.'
        };
    }

    const cacheKey = crypto.createHash('sha256').update(rawToken).digest('hex');
    const cached = introspectionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = await introspect(rawToken, config, endpoints, audiences, options);

    // Bounded: a token per entry, and a busy server sees many. Clearing wholesale
    // rather than evicting one is fine at this size and keeps the logic honest.
    if (introspectionCache.size >= INTROSPECTION_CACHE_MAX) introspectionCache.clear();
    introspectionCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + (result.ok ? INTROSPECTION_TTL_MS : INTROSPECTION_FAILURE_TTL_MS)
    });
    return result;
}

async function introspect(
    rawToken: string,
    config: OidcConfig,
    endpoints: IdpEndpoints,
    audiences: string[],
    options: VerifyOptions
): Promise<VerifyResult> {
    const fetchImpl = options.fetchImpl ?? fetch;
    let payload: Record<string, unknown>;
    try {
        const response = await fetchImpl(endpoints.introspectionEndpoint!, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
                // client_secret_basic: the form-body variant is also permitted, but
                // credentials in a body get logged by more middleware than headers do.
                Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
            },
            body: new URLSearchParams({ token: rawToken, token_type_hint: 'access_token' }),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            return {
                ok: false,
                error: 'server_error',
                description: `Token introspection returned HTTP ${response.status}.`
            };
        }
        payload = (await response.json()) as Record<string, unknown>;
    } catch (e) {
        return { ok: false, error: 'server_error', description: `Token introspection failed: ${(e as Error).message}` };
    }

    if (payload.active !== true) {
        return { ok: false, error: 'invalid_token', description: 'The identity provider reports this token is not active.' };
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return { ok: false, error: 'invalid_token', description: 'Introspection response has no subject.' };

    // `active: true` means "this token exists and has not expired or been
    // revoked" — it says nothing about who the token was for. Issuer and audience
    // still have to be checked here, or introspection would be a weaker check than
    // the JWT path rather than a stronger one.
    if (typeof payload.iss === 'string' && payload.iss.replace(/\/+$/, '') !== endpoints.issuer) {
        return { ok: false, error: 'invalid_token', description: 'Token was issued by a different issuer.' };
    }

    const tokenAudiences = parseAudience(payload.aud);
    if (!tokenAudiences.some((aud) => audiences.includes(aud))) {
        return {
            ok: false,
            error: 'invalid_token',
            description: `Token audience ${tokenAudiences.length > 0 ? `(${tokenAudiences.join(', ')}) ` : ''}does not include this MCP server.`
        };
    }

    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() - CLOCK_TOLERANCE_SECONDS * 1000) {
        return { ok: false, error: 'invalid_token', description: 'Token has expired.' };
    }

    return {
        ok: true,
        token: {
            sub,
            scopes: parseScopes(payload.scope),
            clientId: readClientId(payload),
            expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
            claims: payload,
            via: 'introspection'
        }
    };
}

/** `aud` is a string or an array of strings (RFC 7519 §4.1.3). */
export function parseAudience(aud: unknown): string[] {
    if (typeof aud === 'string') return [aud];
    if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === 'string');
    return [];
}

/** The client the token was issued to: `azp` in OIDC, `client_id` in introspection. */
function readClientId(payload: Record<string, unknown>): string | null {
    if (typeof payload.azp === 'string') return payload.azp;
    if (typeof payload.client_id === 'string') return payload.client_id;
    return null;
}
