import { oidcConfig, fetchIdpMetadata } from './oidc-discovery';
import { protectedResourceMetadata, requiredScopes } from './oauth-resource';

/**
 * The RFC 9728 protected-resource metadata response.
 *
 * Served at both `/.well-known/oauth-protected-resource` and the path-aware
 * `/.well-known/oauth-protected-resource/api/mcp`, because clients try the
 * path-aware URL first and fall back to the bare one; a server that offers only
 * one of them fails against half of them.
 *
 * Publicly readable, and deliberately thin: the issuer (which this deployment
 * already redirects browsers to), the resource identifier a token must be
 * audience-bound to, and where a human can read the setup instructions.
 */
export async function protectedResourceMetadataResponse(requestOrigin: string): Promise<Response> {
    const config = oidcConfig();
    if (!config) {
        // Honest 503 rather than a document naming an authorization server that
        // does not exist: a client would otherwise walk off to authorize against
        // "undefined" and report something baffling to its user.
        return json(
            {
                error: 'oidc_not_configured',
                error_description:
                    'This deployment has no identity provider configured, so MCP access cannot be authorized. Set OIDC_ISSUER and OIDC_CLIENT_ID.'
            },
            503
        );
    }

    // Advertise the scopes the provider actually supports where we can see them,
    // narrowed to what this resource cares about. Discovery failing is not fatal
    // here — the issuer alone is enough for a client to continue, and it will read
    // the provider's own metadata next anyway.
    const discovered = await fetchIdpMetadata(config);
    const required = requiredScopes();
    const scopesSupported =
        required.length > 0
            ? required
            : discovered.ok
              ? discovered.endpoints.scopesSupported.filter((scope) =>
                    ['openid', 'profile', 'email', 'offline_access'].includes(scope)
                )
              : undefined;

    return json(protectedResourceMetadata(requestOrigin, config.issuer, { scopesSupported }), 200);
}

function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json',
            // Cacheable: the document changes only when the deployment is
            // reconfigured, and clients fetch it on every authorization attempt.
            'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
            // The document is meant to be read cross-origin by clients that are not
            // browsers but may be running in one.
            'Access-Control-Allow-Origin': '*'
        }
    });
}
