import { describe, it, expect } from 'vitest';
import {
    acceptedAudiences,
    bearerChallenge,
    hasRequiredScopes,
    looksLikeJwt,
    parseBearer,
    parseScopes,
    protectedResourceMetadata,
    publicOrigin,
    requiredScopes,
    resourceIdentifier,
    resourceMetadataUrl
} from './oauth-resource';

/**
 * The rules that decide which tokens are for this server, and the two documents a
 * client reads to find the authorization server.
 *
 * The cases worth pinning are the ones that fail quietly: an audience default that
 * drifts from the advertised resource identifier (every token gets rejected), a
 * metadata URL built the wrong way round (clients never find it), or a challenge
 * header that a provider's error message could break out of.
 */

const ORIGIN = 'http://localhost:5173';

describe('publicOrigin', () => {
    it('uses the request origin when PUBLIC_URL is unset', () => {
        expect(publicOrigin(ORIGIN, {})).toBe(ORIGIN);
    });

    it('prefers PUBLIC_URL, which is what the client actually reached', () => {
        expect(publicOrigin('http://internal:3000', { PUBLIC_URL: 'https://archie.example.com' })).toBe(
            'https://archie.example.com'
        );
    });

    it('reduces PUBLIC_URL to its origin and drops a trailing slash', () => {
        expect(publicOrigin(ORIGIN, { PUBLIC_URL: 'https://archie.example.com/' })).toBe('https://archie.example.com');
        expect(publicOrigin(ORIGIN, { PUBLIC_URL: 'https://archie.example.com/sub/path' })).toBe(
            'https://archie.example.com'
        );
    });

    it('falls back to the request origin when PUBLIC_URL is garbage', () => {
        expect(publicOrigin(ORIGIN, { PUBLIC_URL: 'not a url' })).toBe(ORIGIN);
    });
});

describe('resource identifiers', () => {
    it('names the MCP endpoint, with no query or fragment', () => {
        expect(resourceIdentifier(ORIGIN, {})).toBe('http://localhost:5173/api/mcp');
    });

    it('puts the well-known segment between host and path, per RFC 9728', () => {
        expect(resourceMetadataUrl(ORIGIN, {})).toBe(
            'http://localhost:5173/.well-known/oauth-protected-resource/api/mcp'
        );
    });

    it('honours PUBLIC_URL in both, so they agree with each other', () => {
        const env = { PUBLIC_URL: 'https://archie.example.com' };
        expect(resourceIdentifier(ORIGIN, env)).toBe('https://archie.example.com/api/mcp');
        expect(resourceMetadataUrl(ORIGIN, env)).toBe(
            'https://archie.example.com/.well-known/oauth-protected-resource/api/mcp'
        );
    });
});

describe('acceptedAudiences', () => {
    it('defaults to exactly the advertised resource identifier', () => {
        // If these two ever diverge, a provider that honours RFC 8707 correctly
        // produces tokens this server rejects.
        expect(acceptedAudiences(ORIGIN, {})).toEqual([resourceIdentifier(ORIGIN, {})]);
    });

    it('accepts a configured list, for providers that stamp a fixed audience', () => {
        expect(acceptedAudiences(ORIGIN, { MCP_OAUTH_AUDIENCE: 'archie-mcp' })).toEqual(['archie-mcp']);
        expect(acceptedAudiences(ORIGIN, { MCP_OAUTH_AUDIENCE: 'archie-mcp, account , ' })).toEqual([
            'archie-mcp',
            'account'
        ]);
    });

    it('never ends up empty, which would accept nothing at all', () => {
        expect(acceptedAudiences(ORIGIN, { MCP_OAUTH_AUDIENCE: '   ' })).toEqual([resourceIdentifier(ORIGIN, {})]);
        expect(acceptedAudiences(ORIGIN, { MCP_OAUTH_AUDIENCE: ',,,' })).toEqual([resourceIdentifier(ORIGIN, {})]);
    });
});

describe('scopes', () => {
    it('splits a space-delimited scope claim', () => {
        expect(parseScopes('openid profile email')).toEqual(['openid', 'profile', 'email']);
    });

    it('accepts an array claim, which some providers use instead', () => {
        expect(parseScopes(['openid', 'profile'])).toEqual(['openid', 'profile']);
    });

    it('treats anything else as no scopes', () => {
        expect(parseScopes(undefined)).toEqual([]);
        expect(parseScopes(null)).toEqual([]);
        expect(parseScopes(42)).toEqual([]);
        expect(parseScopes('')).toEqual([]);
    });

    it('requires nothing unless configured', () => {
        expect(requiredScopes({})).toEqual([]);
        expect(requiredScopes({ MCP_OAUTH_REQUIRED_SCOPE: 'mcp:access' })).toEqual(['mcp:access']);
    });

    it('checks every required scope is present', () => {
        expect(hasRequiredScopes(['openid', 'mcp:access'], ['mcp:access'])).toBe(true);
        expect(hasRequiredScopes(['openid'], ['mcp:access'])).toBe(false);
        expect(hasRequiredScopes([], [])).toBe(true);
    });
});

describe('protectedResourceMetadata', () => {
    it('names this resource and the one authorization server that may issue for it', () => {
        const doc = protectedResourceMetadata(ORIGIN, 'https://idp.example.com/realms/main', { env: {} });
        expect(doc.resource).toBe('http://localhost:5173/api/mcp');
        expect(doc.authorization_servers).toEqual(['https://idp.example.com/realms/main']);
    });

    it('advertises header-only bearer usage', () => {
        // A token in a query string lands in access logs and browser history.
        const doc = protectedResourceMetadata(ORIGIN, 'https://idp.example.com', { env: {} });
        expect(doc.bearer_methods_supported).toEqual(['header']);
    });

    it('advertises the required scope when one is configured', () => {
        const doc = protectedResourceMetadata(ORIGIN, 'https://idp.example.com', {
            env: { MCP_OAUTH_REQUIRED_SCOPE: 'mcp:access' }
        });
        expect(doc.scopes_supported).toEqual(['mcp:access']);
    });

    it('lets a caller pass the scopes discovered from the provider', () => {
        const doc = protectedResourceMetadata(ORIGIN, 'https://idp.example.com', {
            scopesSupported: ['openid', 'email'],
            env: {}
        });
        expect(doc.scopes_supported).toEqual(['openid', 'email']);
    });
});

describe('bearerChallenge', () => {
    const metadataUrl = 'https://archie.example.com/.well-known/oauth-protected-resource/api/mcp';

    it('always points at the resource metadata, which is how discovery starts', () => {
        const challenge = bearerChallenge({ resourceMetadataUrl: metadataUrl });
        expect(challenge).toContain('Bearer realm="Archie MCP"');
        expect(challenge).toContain(`resource_metadata="${metadataUrl}"`);
    });

    it('omits error for a missing credential and includes it for a rejected one', () => {
        // RFC 6750: `error` describes a failed credential. Its absence is what tells
        // a client to start authorizing rather than report a rejection.
        expect(bearerChallenge({ resourceMetadataUrl: metadataUrl })).not.toContain('error=');
        expect(
            bearerChallenge({ resourceMetadataUrl: metadataUrl, error: 'invalid_token', description: 'expired' })
        ).toContain('error="invalid_token", error_description="expired"');
    });

    it('lists the missing scopes on an insufficient_scope challenge', () => {
        const challenge = bearerChallenge({
            resourceMetadataUrl: metadataUrl,
            error: 'insufficient_scope',
            scope: ['mcp:access', 'openid']
        });
        expect(challenge).toContain('scope="mcp:access openid"');
    });

    it('cannot be broken out of by a provider error message', () => {
        // The description can originate in an IdP response or an exception, so this
        // is where untrusted text becomes a response header: a CR/LF would be header
        // injection and a quote would corrupt the parameter.
        const challenge = bearerChallenge({
            resourceMetadataUrl: metadataUrl,
            error: 'invalid_token',
            description: 'bad\r\nSet-Cookie: evil=1" foo="bar'
        });
        expect(challenge).not.toContain('\r');
        expect(challenge).not.toContain('\n');
        expect(challenge).toBe(
            `Bearer realm="Archie MCP", resource_metadata="${metadataUrl}", error="invalid_token", error_description="bad Set-Cookie: evil=1 foo=bar"`
        );
    });
});

describe('parseBearer', () => {
    it('reads the credential regardless of scheme casing', () => {
        expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
        expect(parseBearer('bearer abc')).toBe('abc');
        expect(parseBearer('BEARER abc')).toBe('abc');
    });

    it('tolerates the whitespace real clients send', () => {
        expect(parseBearer('  Bearer   abc  ')).toBe('abc');
        expect(parseBearer('Bearer\tabc')).toBe('abc');
    });

    it('returns null when there is no bearer credential', () => {
        expect(parseBearer(null)).toBeNull();
        expect(parseBearer(undefined)).toBeNull();
        expect(parseBearer('')).toBeNull();
        expect(parseBearer('Bearer')).toBeNull();
        expect(parseBearer('Bearer ')).toBeNull();
        expect(parseBearer('Basic dXNlcjpwYXNz')).toBeNull();
        expect(parseBearer('abc')).toBeNull();
    });

    it('does not accept two space-separated values as one credential', () => {
        expect(parseBearer('Bearer abc extra')).toBeNull();
    });
});

describe('looksLikeJwt', () => {
    it('recognises a three-segment signed token', () => {
        expect(looksLikeJwt('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe(true);
    });

    it('rejects opaque tokens, so they go to introspection instead', () => {
        expect(looksLikeJwt('0f4b1c2d-9a8e-4f00-8f1a-1e2d3c4b5a69')).toBe(false);
        expect(looksLikeJwt('abc.def')).toBe(false);
        expect(looksLikeJwt('abc.def.')).toBe(false);
        expect(looksLikeJwt('abc.def.ghi.jkl')).toBe(false);
        expect(looksLikeJwt('abc.def.gh i')).toBe(false);
    });
});
