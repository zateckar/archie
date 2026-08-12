import { redirect } from '@sveltejs/kit';
import { fetchIdpMetadata, oidcConfig } from '$lib/server/oidc-discovery';
import { acceptedAudiences, resourceIdentifier, resourceMetadataUrl } from '$lib/server/oauth-resource';

/**
 * Everything a person needs to point an MCP client at this deployment — and,
 * when it will not work yet, which piece is missing.
 *
 * There is nothing to create here: authorization is OAuth against the app's own
 * identity provider, so the client obtains its own token by sending the user
 * through the usual sign-in. The page's job is to state the endpoint and to be
 * honest about the two things that have to be true on the provider's side.
 */
export const load = async ({ locals, url }) => {
    // hooks.server.ts already guards this route; the redirect is here so the load
    // function is honest about its own precondition rather than asserting one.
    if (!locals.user) {
        throw redirect(302, `/login?redirectTo=${encodeURIComponent(url.pathname)}`);
    }

    const config = oidcConfig();

    // Read straight from the provider's discovery document, because the two most
    // common reasons an MCP client cannot connect are both visible in it: no
    // registration_endpoint means clients that self-register (Claude's do) will be
    // turned away, and an unreachable document means token verification cannot work
    // at all. Far better to say so here than to let someone debug it from a 401.
    let idp: {
        reachable: boolean;
        reason: string | null;
        dynamicRegistration: boolean;
        authorizationEndpoint: string | null;
    } | null = null;

    if (config) {
        const result = await fetchIdpMetadata(config);
        idp = result.ok
            ? {
                  reachable: true,
                  reason: null,
                  dynamicRegistration: !!result.endpoints.registrationEndpoint,
                  authorizationEndpoint: result.endpoints.authorizationEndpoint
              }
            : { reachable: false, reason: result.reason, dynamicRegistration: false, authorizationEndpoint: null };
    }

    return {
        // The address derived from the request (or PUBLIC_URL), so the snippets are
        // correct behind whatever host or reverse proxy the user actually reached.
        mcpUrl: resourceIdentifier(url.origin),
        metadataUrl: resourceMetadataUrl(url.origin),
        issuer: config?.issuer ?? null,
        audiences: acceptedAudiences(url.origin),
        isAdmin: locals.user.role === 'admin',
        idp
    };
};
