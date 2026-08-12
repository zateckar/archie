import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, type CryptoKey } from 'jose';
import { clearDiscoveryCache } from './oidc-discovery';
import { clearTokenCaches, parseAudience, verifyAccessToken } from './oauth-token';

/**
 * Access-token verification, exercised with real signatures.
 *
 * The keys are generated in-process and handed in through the `keyResolver` seam,
 * so these are genuine cryptographic verifications with no network and no live
 * identity provider — which means the checks that matter can be tested for
 * *rejection*, which is the direction that actually protects anything:
 *   - a token signed by a different key;
 *   - a token for a different audience (another service behind the same IdP);
 *   - a token from a different issuer;
 *   - an expired token.
 */

const ISSUER = 'https://idp.example.com/realms/main';
const ORIGIN = 'http://localhost:5173';
const RESOURCE = 'http://localhost:5173/api/mcp';

const ENV = {
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'archie',
    OIDC_CLIENT_SECRET: 'shh'
};

let signingKey: CryptoKey;
let jwks: JWTVerifyGetKey;
/** A second keypair, never published, standing in for a forged token. */
let foreignKey: CryptoKey;

function discoveryFetch(overrides: Record<string, unknown> = {}): typeof fetch {
    return (async () =>
        new Response(
            JSON.stringify({
                issuer: ISSUER,
                jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
                introspection_endpoint: `${ISSUER}/protocol/openid-connect/token/introspect`,
                userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
                ...overrides
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;
}

interface TokenOptions {
    audience?: string | string[];
    issuer?: string;
    subject?: string | null;
    scope?: string;
    expiresIn?: string;
    issuedAt?: number;
    key?: CryptoKey;
}

async function signToken(options: TokenOptions = {}): Promise<string> {
    let jwt = new SignJWT({
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        azp: 'some-mcp-client'
    })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt(options.issuedAt)
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? RESOURCE)
        .setExpirationTime(options.expiresIn ?? '5m');

    if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? 'subject-123');
    return jwt.sign(options.key ?? signingKey);
}

beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    jwks = createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] });
    foreignKey = (await generateKeyPair('RS256')).privateKey;
});

beforeEach(() => {
    clearDiscoveryCache();
    clearTokenCaches();
});

function verify(token: string, env: Record<string, string | undefined> = ENV, fetchImpl = discoveryFetch()) {
    return verifyAccessToken(token, { origin: ORIGIN, env, fetchImpl, keyResolver: jwks });
}

describe('verifyAccessToken (JWT)', () => {
    it('accepts a token signed by the provider for this resource', async () => {
        const result = await verify(await signToken({ scope: 'openid profile' }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.token.sub).toBe('subject-123');
        expect(result.token.scopes).toEqual(['openid', 'profile']);
        expect(result.token.clientId).toBe('some-mcp-client');
        expect(result.token.via).toBe('jwt');
    });

    it('rejects a token minted for another service behind the same IdP', async () => {
        // The confused-deputy case, and the entire reason audience validation exists.
        const result = await verify(await signToken({ audience: 'https://other-service.example.com' }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_token');
        expect(result.description).toMatch(/aud/i);
    });

    it('accepts a token whose audience array includes this resource', async () => {
        const result = await verify(await signToken({ audience: ['account', RESOURCE] }));
        expect(result.ok).toBe(true);
    });

    it('rejects a token from a different issuer', async () => {
        const result = await verify(await signToken({ issuer: 'https://evil.example.com' }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.description).toMatch(/iss/i);
    });

    it('rejects a token signed by a key the provider does not publish', async () => {
        const result = await verify(await signToken({ key: foreignKey }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_token');
    });

    it('rejects an expired token', async () => {
        const result = await verify(await signToken({ expiresIn: '-1h', issuedAt: Math.floor(Date.now() / 1000) - 7200 }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.description).toMatch(/exp/i);
    });

    it('rejects a token with no subject, which could not be mapped to a user', async () => {
        const result = await verify(await signToken({ subject: null }));
        expect(result.ok).toBe(false);
    });

    it('honours a configured audience instead of the resource identifier', async () => {
        const env = { ...ENV, MCP_OAUTH_AUDIENCE: 'archie-mcp' };
        expect((await verify(await signToken({ audience: 'archie-mcp' }), env)).ok).toBe(true);
        // …and stops accepting the default once overridden, which is what makes the
        // setting a real restriction rather than an addition.
        expect((await verify(await signToken({ audience: RESOURCE }), env)).ok).toBe(false);
    });

    it('enforces a required scope', async () => {
        const env = { ...ENV, MCP_OAUTH_REQUIRED_SCOPE: 'mcp:access' };
        const granted = await verify(await signToken({ scope: 'openid mcp:access' }), env);
        expect(granted.ok).toBe(true);

        const missing = await verify(await signToken({ scope: 'openid' }), env);
        expect(missing.ok).toBe(false);
        if (missing.ok) return;
        // 403, not 401: the credential is good, the grant is too narrow.
        expect(missing.error).toBe('insufficient_scope');
        expect(missing.description).toContain('mcp:access');
    });

    it('reports a server error, not a rejection, when no IdP is configured', async () => {
        const result = await verify(await signToken(), {});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('server_error');
        expect(result.description).toMatch(/OIDC_ISSUER/);
    });

    it('reports a server error when discovery cannot be trusted', async () => {
        const wrongIssuer = discoveryFetch({ issuer: 'https://evil.example.com' });
        const result = await verify(await signToken(), ENV, wrongIssuer);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('server_error');
    });
});

describe('verifyAccessToken (opaque tokens)', () => {
    const opaque = '0f4b1c2d-9a8e-4f00-8f1a-1e2d3c4b5a69';

    /** Serves discovery, then introspection, from one stand-in. */
    function fetchWithIntrospection(introspection: unknown, status = 200): typeof fetch {
        return (async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('.well-known')) {
                return new Response(
                    JSON.stringify({
                        issuer: ISSUER,
                        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
                        introspection_endpoint: `${ISSUER}/protocol/openid-connect/token/introspect`
                    }),
                    { status: 200 }
                );
            }
            return new Response(JSON.stringify(introspection), { status });
        }) as typeof fetch;
    }

    it('accepts a token the provider reports as active for this resource', async () => {
        const result = await verifyAccessToken(opaque, {
            origin: ORIGIN,
            env: ENV,
            fetchImpl: fetchWithIntrospection({
                active: true,
                sub: 'subject-123',
                aud: RESOURCE,
                iss: ISSUER,
                scope: 'openid',
                client_id: 'some-mcp-client',
                exp: Math.floor(Date.now() / 1000) + 300
            })
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.token.via).toBe('introspection');
        expect(result.token.sub).toBe('subject-123');
    });

    it('rejects an inactive token', async () => {
        const result = await verifyAccessToken(opaque, {
            origin: ORIGIN,
            env: ENV,
            fetchImpl: fetchWithIntrospection({ active: false })
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_token');
    });

    it('still checks the audience, so introspection is not the weaker path', async () => {
        // `active: true` only means the token exists and has not expired — it says
        // nothing about who it was issued for.
        const result = await verifyAccessToken(opaque, {
            origin: ORIGIN,
            env: ENV,
            fetchImpl: fetchWithIntrospection({
                active: true,
                sub: 'subject-123',
                aud: 'https://other-service.example.com',
                iss: ISSUER
            })
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.description).toMatch(/audience/i);
    });

    it('rejects an opaque token when the provider offers no introspection', async () => {
        const noIntrospection = (async () =>
            new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/certs` }), { status: 200 })) as typeof fetch;
        const result = await verifyAccessToken(opaque, { origin: ORIGIN, env: ENV, fetchImpl: noIntrospection });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.description).toMatch(/introspection/i);
    });

    it('caches an introspection result rather than asking per request', async () => {
        let introspections = 0;
        const counting = (async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('.well-known')) {
                return new Response(
                    JSON.stringify({
                        issuer: ISSUER,
                        jwks_uri: `${ISSUER}/certs`,
                        introspection_endpoint: `${ISSUER}/introspect`
                    }),
                    { status: 200 }
                );
            }
            introspections++;
            return new Response(
                JSON.stringify({ active: true, sub: 'subject-123', aud: RESOURCE, iss: ISSUER }),
                { status: 200 }
            );
        }) as typeof fetch;

        await verifyAccessToken(opaque, { origin: ORIGIN, env: ENV, fetchImpl: counting });
        await verifyAccessToken(opaque, { origin: ORIGIN, env: ENV, fetchImpl: counting });
        expect(introspections).toBe(1);
    });

    it('can be forced for a JWT, for a provider whose signatures are not the authority', async () => {
        const token = await signToken();
        let introspected = false;
        const counting = (async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('.well-known')) {
                return new Response(
                    JSON.stringify({
                        issuer: ISSUER,
                        jwks_uri: `${ISSUER}/certs`,
                        introspection_endpoint: `${ISSUER}/introspect`
                    }),
                    { status: 200 }
                );
            }
            introspected = true;
            return new Response(
                JSON.stringify({ active: true, sub: 'subject-123', aud: RESOURCE, iss: ISSUER }),
                { status: 200 }
            );
        }) as typeof fetch;

        const result = await verifyAccessToken(token, {
            origin: ORIGIN,
            env: { ...ENV, MCP_OAUTH_INTROSPECT: 'true' },
            fetchImpl: counting,
            keyResolver: jwks
        });
        expect(introspected).toBe(true);
        expect(result.ok).toBe(true);
    });
});

describe('parseAudience', () => {
    it('accepts both shapes RFC 7519 allows', () => {
        expect(parseAudience('a')).toEqual(['a']);
        expect(parseAudience(['a', 'b'])).toEqual(['a', 'b']);
        expect(parseAudience(undefined)).toEqual([]);
        expect(parseAudience(42)).toEqual([]);
        expect(parseAudience([1, 'b'])).toEqual(['b']);
    });
});
