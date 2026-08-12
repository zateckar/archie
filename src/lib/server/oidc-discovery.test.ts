import { describe, it, expect, beforeEach } from 'vitest';
import {
    clearDiscoveryCache,
    discoveryUrl,
    endpointsFromDocument,
    fetchIdpMetadata,
    idpEndpoints,
    keycloakEndpoints,
    normalizeIssuer,
    oidcConfig,
    requireIdpEndpoints
} from './oidc-discovery';

/**
 * Reading the provider's endpoints. The security-bearing case is the issuer check:
 * a discovery document that names a different issuer must be refused rather than
 * used, because its `jwks_uri` decides which keys can mint tokens this server
 * trusts.
 */

const ISSUER = 'https://idp.example.com/realms/main';
const CONFIG = { issuer: ISSUER, clientId: 'archie', clientSecret: 'shh' };

/** A minimal fetch stand-in that serves one JSON body. */
function fetchServing(body: unknown, status = 200): typeof fetch {
    return (async () =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

function fullDocument(overrides: Record<string, unknown> = {}) {
    return {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        introspection_endpoint: `${ISSUER}/protocol/openid-connect/token/introspect`,
        registration_endpoint: `${ISSUER}/clients-registrations/openid-connect`,
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        ...overrides
    };
}

beforeEach(() => {
    clearDiscoveryCache();
});

describe('normalizeIssuer', () => {
    it('drops trailing slashes so path concatenation cannot double up', () => {
        expect(normalizeIssuer('https://idp.example.com/')).toBe('https://idp.example.com');
        expect(normalizeIssuer('https://idp.example.com///')).toBe('https://idp.example.com');
        expect(normalizeIssuer('https://idp.example.com')).toBe('https://idp.example.com');
    });
});

describe('oidcConfig', () => {
    it('is null unless both an issuer and a client id are set', () => {
        expect(oidcConfig({})).toBeNull();
        expect(oidcConfig({ OIDC_ISSUER: ISSUER })).toBeNull();
        expect(oidcConfig({ OIDC_CLIENT_ID: 'archie' })).toBeNull();
        expect(oidcConfig({ OIDC_ISSUER: '  ', OIDC_CLIENT_ID: 'archie' })).toBeNull();
    });

    it('reads the configuration the browser sign-in already uses', () => {
        expect(
            oidcConfig({ OIDC_ISSUER: `${ISSUER}/`, OIDC_CLIENT_ID: 'archie', OIDC_CLIENT_SECRET: 'shh' })
        ).toEqual({ issuer: ISSUER, clientId: 'archie', clientSecret: 'shh' });
    });

    it('treats a missing client secret as a public client rather than a failure', () => {
        expect(oidcConfig({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'archie' })?.clientSecret).toBeNull();
    });
});

describe('discoveryUrl', () => {
    it('appends the OpenID discovery path', () => {
        expect(discoveryUrl(`${ISSUER}/`)).toBe(`${ISSUER}/.well-known/openid-configuration`);
    });
});

describe('endpointsFromDocument', () => {
    it('reads a full document', () => {
        const result = endpointsFromDocument(fullDocument(), ISSUER);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.endpoints.jwksUri).toBe(`${ISSUER}/protocol/openid-connect/certs`);
        expect(result.endpoints.registrationEndpoint).toBe(`${ISSUER}/clients-registrations/openid-connect`);
        expect(result.endpoints.assumed).toBe(false);
    });

    it('refuses a document whose issuer is not the configured one', () => {
        // RFC 8414 §3.3. Without this check a hijacked discovery URL could point
        // token verification at an attacker's keys.
        const result = endpointsFromDocument(fullDocument({ issuer: 'https://evil.example.com' }), ISSUER);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain('does not match configured OIDC_ISSUER');
        // Not a network problem, so callers must not fall back to guessed endpoints.
        expect(result.unreachable).toBe(false);
    });

    it('tolerates a trailing slash difference in the advertised issuer', () => {
        expect(endpointsFromDocument(fullDocument({ issuer: `${ISSUER}/` }), ISSUER).ok).toBe(true);
    });

    it('refuses a document with no jwks_uri, since tokens could not be verified', () => {
        const result = endpointsFromDocument(fullDocument({ jwks_uri: undefined }), ISSUER);
        expect(result.ok).toBe(false);
    });

    it('refuses a document that is not an object, or has no issuer', () => {
        expect(endpointsFromDocument(null, ISSUER).ok).toBe(false);
        expect(endpointsFromDocument('nope', ISSUER).ok).toBe(false);
        expect(endpointsFromDocument({ jwks_uri: 'x' }, ISSUER).ok).toBe(false);
    });

    it('fills sparse optional endpoints so a thin document cannot break sign-in', () => {
        const result = endpointsFromDocument({ issuer: ISSUER, jwks_uri: `${ISSUER}/certs` }, ISSUER);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.endpoints.authorizationEndpoint).toBe(`${ISSUER}/protocol/openid-connect/auth`);
        expect(result.endpoints.userinfoEndpoint).toBe(`${ISSUER}/protocol/openid-connect/userinfo`);
        // Absent capabilities are reported as absent, not guessed at.
        expect(result.endpoints.introspectionEndpoint).toBeNull();
        expect(result.endpoints.registrationEndpoint).toBeNull();
    });

    it('accepts the older token_introspection_endpoint spelling', () => {
        const result = endpointsFromDocument(
            { issuer: ISSUER, jwks_uri: `${ISSUER}/certs`, token_introspection_endpoint: `${ISSUER}/introspect` },
            ISSUER
        );
        expect(result.ok && result.endpoints.introspectionEndpoint).toBe(`${ISSUER}/introspect`);
    });
});

describe('fetchIdpMetadata', () => {
    it('reports an HTTP failure as unreachable', async () => {
        const result = await fetchIdpMetadata(CONFIG, fetchServing({}, 503));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.unreachable).toBe(true);
        expect(result.reason).toContain('503');
    });

    it('reports a thrown request as unreachable', async () => {
        const failing = (async () => {
            throw new Error('ECONNREFUSED');
        }) as typeof fetch;
        const result = await fetchIdpMetadata(CONFIG, failing);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.unreachable).toBe(true);
    });

    it('caches a success, so the document is not refetched per request', async () => {
        let calls = 0;
        const counting = (async () => {
            calls++;
            return new Response(JSON.stringify(fullDocument()), { status: 200 });
        }) as typeof fetch;

        await fetchIdpMetadata(CONFIG, counting);
        await fetchIdpMetadata(CONFIG, counting);
        expect(calls).toBe(1);
    });

    it('caches a failure too, so an IdP outage is not one timeout per request', async () => {
        let calls = 0;
        const failing = (async () => {
            calls++;
            throw new Error('ECONNREFUSED');
        }) as typeof fetch;

        await fetchIdpMetadata(CONFIG, failing);
        await fetchIdpMetadata(CONFIG, failing);
        expect(calls).toBe(1);
    });
});

describe('idpEndpoints', () => {
    it('falls back to Keycloak\'s layout when discovery is merely unreachable', async () => {
        const failing = (async () => {
            throw new Error('ECONNREFUSED');
        }) as typeof fetch;
        const endpoints = await idpEndpoints(CONFIG, failing);
        expect(endpoints).toEqual(keycloakEndpoints(ISSUER));
        // Flagged, so callers that must not guess can refuse.
        expect(endpoints.assumed).toBe(true);
    });

    it('throws rather than guessing when the document is served but wrong', async () => {
        const wrongIssuer = fetchServing(fullDocument({ issuer: 'https://evil.example.com' }));
        await expect(idpEndpoints(CONFIG, wrongIssuer)).rejects.toThrow(/does not match configured OIDC_ISSUER/);
    });
});

describe('requireIdpEndpoints', () => {
    it('refuses a guess even when discovery is only unreachable', async () => {
        // Token verification uses this: the wrong keys are indistinguishable from
        // "anyone may mint tokens", so failing closed is the only safe answer.
        const failing = (async () => {
            throw new Error('ECONNREFUSED');
        }) as typeof fetch;
        await expect(requireIdpEndpoints(CONFIG, failing)).rejects.toThrow(/discovery/i);
    });

    it('returns discovered endpoints when they are available', async () => {
        const endpoints = await requireIdpEndpoints(CONFIG, fetchServing(fullDocument()));
        expect(endpoints.issuer).toBe(ISSUER);
        expect(endpoints.assumed).toBe(false);
    });
});
