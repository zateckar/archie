import type { SessionUser } from '../auth';
import { identityClaimsFrom, shouldFetchUserinfo } from '../oidc-claims';
import { oidcConfig, requireIdpEndpoints } from '../oidc-discovery';
import { existingOidcUserId, provisionOidcUser } from '../oidc-user';
import { bearerChallenge, parseBearer, resourceMetadataUrl, requiredScopes } from '../oauth-resource';
import { verifyAccessToken, type VerifiedToken } from '../oauth-token';

/**
 * The MCP endpoint's authentication step: bearer token in, local user out.
 *
 * This is the whole of it. There is no app-issued credential and no MCP-specific
 * account — a client presents an access token from the same identity provider the
 * web UI signs in against, and the subject in that token is mapped to the same
 * user row a browser session would have produced. An MCP client and a browser tab
 * are therefore the same person to everything downstream.
 */

export type McpAuthOutcome =
    | { ok: true; user: SessionUser; token: VerifiedToken }
    | {
          ok: false;
          status: 401 | 403 | 500;
          /** RFC 6750 error code, or null when no credential was offered at all. */
          error: 'invalid_token' | 'insufficient_scope' | null;
          description: string;
          /** Ready-to-send `WWW-Authenticate` value. */
          challenge: string;
      };

export async function authenticateMcpRequest(request: Request, requestOrigin: string): Promise<McpAuthOutcome> {
    const metadataUrl = resourceMetadataUrl(requestOrigin);
    const rawToken = parseBearer(request.headers.get('authorization'));

    // No credential is not a *failed* credential: RFC 6750 says omit `error` here,
    // and that distinction is exactly what tells an MCP client to start the
    // authorization flow rather than report that its token was rejected.
    if (!rawToken) {
        return {
            ok: false,
            status: 401,
            error: null,
            description: 'Authentication required.',
            challenge: bearerChallenge({ resourceMetadataUrl: metadataUrl })
        };
    }

    const verified = await verifyAccessToken(rawToken, { origin: requestOrigin });
    if (!verified.ok) {
        if (verified.error === 'server_error') {
            // A misconfigured or unreachable identity provider is our problem, and
            // a 401 would send the client off to re-authorize against something
            // that cannot help it. Logged in full, reported in brief.
            console.error(`[MCP] Cannot verify access tokens: ${verified.description}`);
            return {
                ok: false,
                status: 500,
                error: null,
                description: verified.description,
                challenge: bearerChallenge({ resourceMetadataUrl: metadataUrl })
            };
        }

        const insufficient = verified.error === 'insufficient_scope';
        return {
            ok: false,
            status: insufficient ? 403 : 401,
            error: verified.error,
            description: verified.description,
            challenge: bearerChallenge({
                resourceMetadataUrl: metadataUrl,
                error: verified.error,
                description: verified.description,
                scope: insufficient ? requiredScopes() : undefined
            })
        };
    }

    const user = await resolveUser(verified.token, rawToken);
    if (!user) {
        return {
            ok: false,
            status: 401,
            error: 'invalid_token',
            description: 'The token is valid but its subject could not be mapped to a user.',
            challenge: bearerChallenge({
                resourceMetadataUrl: metadataUrl,
                error: 'invalid_token',
                description: 'Subject could not be mapped to a user.'
            })
        };
    }

    return { ok: true, user, token: verified.token };
}

/**
 * The local user for a verified token, provisioned on first sight.
 *
 * Auto-provisioning matches what `/api/auth/callback` already does for a first
 * browser sign-in: the identity provider is the authority on who exists, so
 * requiring someone to visit the web UI once before their editor works would be an
 * arbitrary hurdle. New accounts get the default 'user' role either way — an MCP
 * client cannot mint an admin.
 */
async function resolveUser(token: VerifiedToken, rawToken: string): Promise<SessionUser | null> {
    const claims = identityClaimsFrom(token.claims);
    if (!claims) return null;

    const existingId = existingOidcUserId(claims.sub);
    if (shouldFetchUserinfo(claims, existingId !== null)) {
        // The token names this person only by subject id. Ask the provider for a
        // username before creating a row, so the account is recognisable in the
        // admin users table rather than being a bare UUID.
        const fromUserinfo = await fetchUserinfoClaims(rawToken);
        if (fromUserinfo) {
            claims.preferred_username ??= fromUserinfo.preferred_username;
            claims.email ??= fromUserinfo.email;
            claims.name ??= fromUserinfo.name;
        }
    }

    const user = provisionOidcUser(claims);
    if (user && existingId === null) {
        console.log(`[MCP] Provisioned user "${user.username}" from an access token (subject ${claims.sub}).`);
    }
    return user;
}

/** Best-effort userinfo lookup. A failure is not fatal — it only costs a nicer username. */
async function fetchUserinfoClaims(rawToken: string) {
    const config = oidcConfig();
    if (!config) return null;
    try {
        const endpoints = await requireIdpEndpoints(config);
        const response = await fetch(endpoints.userinfoEndpoint, {
            headers: { Authorization: `Bearer ${rawToken}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return null;
        return identityClaimsFrom((await response.json()) as Record<string, unknown>);
    } catch (e) {
        console.warn(`[MCP] userinfo lookup failed: ${(e as Error).message}`);
        return null;
    }
}
