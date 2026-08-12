/**
 * Where the configured identity provider keeps its endpoints.
 *
 * Both halves of the app need this now. The browser sign-in flow
 * (`/api/auth/oidc` → `/api/auth/callback`) used to hardcode Keycloak's
 * `/protocol/openid-connect/*` paths, and the MCP resource server needs a
 * `jwks_uri` (and possibly an introspection endpoint) that no amount of guessing
 * can supply correctly for a non-Keycloak provider. So the endpoints are read
 * from the provider's own OpenID discovery document, once, and cached.
 *
 * No database access here on purpose: this module is fetch + parsing, which is
 * the part worth unit testing. Identity mapping lives in ./oidc-user.
 */

export interface OidcConfig {
    /** Issuer identifier, without a trailing slash. */
    issuer: string;
    clientId: string;
    /** Absent for a public client; required for introspection and the code exchange. */
    clientSecret: string | null;
}

export interface IdpEndpoints {
    /** As asserted by the provider, and verified to match the configured issuer. */
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string;
    jwksUri: string;
    /** RFC 7662. Present only if the provider advertises it. */
    introspectionEndpoint: string | null;
    /** RFC 7591 dynamic client registration, which MCP clients need to self-register. */
    registrationEndpoint: string | null;
    scopesSupported: string[];
    /** True when these were guessed rather than discovered — see idpEndpoints(). */
    assumed: boolean;
}

/** Strips a trailing slash so `${issuer}/path` never doubles up. */
export function normalizeIssuer(issuer: string): string {
    return issuer.replace(/\/+$/, '');
}

export function oidcConfig(env: Record<string, string | undefined> = process.env): OidcConfig | null {
    const issuer = env.OIDC_ISSUER?.trim();
    const clientId = env.OIDC_CLIENT_ID?.trim();
    if (!issuer || !clientId) return null;
    return {
        issuer: normalizeIssuer(issuer),
        clientId,
        clientSecret: env.OIDC_CLIENT_SECRET?.trim() || null
    };
}

export function isOidcConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return oidcConfig(env) !== null;
}

/** The discovery document URL for an issuer (RFC 8414 / OpenID Connect Discovery). */
export function discoveryUrl(issuer: string): string {
    return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

/**
 * The endpoint layout Keycloak uses, which is what this app was written against.
 *
 * Used only when the discovery document cannot be fetched at all, so that an
 * existing deployment whose IdP briefly refuses discovery keeps signing users in
 * exactly as it did before this module existed. Marked `assumed` so callers that
 * cannot safely guess — token verification, above all — can refuse to.
 */
export function keycloakEndpoints(issuer: string): IdpEndpoints {
    const base = `${normalizeIssuer(issuer)}/protocol/openid-connect`;
    return {
        issuer: normalizeIssuer(issuer),
        authorizationEndpoint: `${base}/auth`,
        tokenEndpoint: `${base}/token`,
        userinfoEndpoint: `${base}/userinfo`,
        jwksUri: `${base}/certs`,
        introspectionEndpoint: `${base}/token/introspect`,
        registrationEndpoint: null,
        scopesSupported: ['openid', 'profile', 'email'],
        assumed: true
    };
}

export type MetadataResult =
    | { ok: true; endpoints: IdpEndpoints }
    | { ok: false; reason: string; unreachable: boolean };

/**
 * Validates and narrows a discovery document.
 *
 * The issuer check is not a formality: RFC 8414 §3.3 requires it, and it is what
 * stops a compromised or merely misconfigured discovery URL from redirecting
 * token verification at an attacker's JWKS — which would let them mint tokens
 * this server accepts. A document that fails this check is rejected outright
 * rather than falling back to guessed endpoints, because "served the wrong
 * issuer" is a misconfiguration to fix, not a network blip to paper over.
 */
export function endpointsFromDocument(document: unknown, configuredIssuer: string): MetadataResult {
    if (!document || typeof document !== 'object') {
        return { ok: false, reason: 'discovery document is not a JSON object', unreachable: false };
    }
    const doc = document as Record<string, unknown>;
    const expected = normalizeIssuer(configuredIssuer);

    const advertised = typeof doc.issuer === 'string' ? normalizeIssuer(doc.issuer) : null;
    if (!advertised) {
        return { ok: false, reason: 'discovery document has no issuer', unreachable: false };
    }
    if (advertised !== expected) {
        return {
            ok: false,
            reason: `discovery document issuer "${advertised}" does not match configured OIDC_ISSUER "${expected}"`,
            unreachable: false
        };
    }

    const str = (key: string): string | null => (typeof doc[key] === 'string' ? (doc[key] as string) : null);

    const jwksUri = str('jwks_uri');
    if (!jwksUri) {
        return { ok: false, reason: 'discovery document has no jwks_uri', unreachable: false };
    }

    const base = `${expected}/protocol/openid-connect`;
    return {
        ok: true,
        endpoints: {
            issuer: expected,
            // Only jwks_uri is strictly required here; the rest keep the
            // Keycloak-shaped default so a sparse document cannot break sign-in.
            authorizationEndpoint: str('authorization_endpoint') ?? `${base}/auth`,
            tokenEndpoint: str('token_endpoint') ?? `${base}/token`,
            userinfoEndpoint: str('userinfo_endpoint') ?? `${base}/userinfo`,
            jwksUri,
            introspectionEndpoint: str('introspection_endpoint') ?? str('token_introspection_endpoint'),
            registrationEndpoint: str('registration_endpoint'),
            scopesSupported: Array.isArray(doc.scopes_supported)
                ? (doc.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string')
                : ['openid', 'profile', 'email'],
            assumed: false
        }
    };
}

interface CacheEntry {
    result: MetadataResult;
    expiresAt: number;
}

const SUCCESS_TTL_MS = 60 * 60 * 1000;
/**
 * Failures are cached too, briefly. Without it every MCP request against an IdP
 * that is down pays a fresh HTTP timeout, turning one outage into a queue of
 * hung requests.
 */
const FAILURE_TTL_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 5000;

const cache = new Map<string, CacheEntry>();

/** Drops the cached discovery document. For tests, and for a config reload. */
export function clearDiscoveryCache(): void {
    cache.clear();
}

/**
 * Fetches (and caches) the provider's discovery document.
 *
 * `fetchImpl` is injectable so tests can exercise the parsing and the caching
 * without a network or a live IdP.
 */
export async function fetchIdpMetadata(
    config: OidcConfig,
    fetchImpl: typeof fetch = fetch
): Promise<MetadataResult> {
    const cached = cache.get(config.issuer);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    let result: MetadataResult;
    try {
        const response = await fetchImpl(discoveryUrl(config.issuer), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
        });
        if (!response.ok) {
            result = { ok: false, reason: `discovery returned HTTP ${response.status}`, unreachable: true };
        } else {
            result = endpointsFromDocument(await response.json(), config.issuer);
        }
    } catch (e) {
        result = { ok: false, reason: `discovery request failed: ${(e as Error).message}`, unreachable: true };
    }

    cache.set(config.issuer, {
        result,
        expiresAt: Date.now() + (result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS)
    });
    if (!result.ok) console.warn(`[OIDC] ${result.reason}`);
    return result;
}

/**
 * The provider's endpoints, falling back to Keycloak's layout when discovery is
 * merely unreachable.
 *
 * Callers that must not guess (see ./oauth-token) should check `assumed` — or use
 * `requireIdpEndpoints`, which refuses instead.
 */
export async function idpEndpoints(
    config: OidcConfig,
    fetchImpl: typeof fetch = fetch
): Promise<IdpEndpoints> {
    const result = await fetchIdpMetadata(config, fetchImpl);
    if (result.ok) return result.endpoints;
    if (result.unreachable) return keycloakEndpoints(config.issuer);
    throw new Error(`OIDC discovery failed: ${result.reason}`);
}

/** Endpoints, or an error — never a guess. Use this for anything security-bearing. */
export async function requireIdpEndpoints(
    config: OidcConfig,
    fetchImpl: typeof fetch = fetch
): Promise<IdpEndpoints> {
    const result = await fetchIdpMetadata(config, fetchImpl);
    if (!result.ok) throw new Error(`OIDC discovery failed: ${result.reason}`);
    return result.endpoints;
}
