/**
 * Archie as an OAuth 2.1 protected resource.
 *
 * The MCP authorization spec makes this server a *resource server* and nothing
 * else: access tokens are issued by the identity provider the app already uses
 * for sign-in, and this module holds the rules that decide which of those tokens
 * are for us — plus the two documents a client reads to find the authorization
 * server in the first place (RFC 9728) and the challenge header that points at
 * them.
 *
 * Pure string and env handling, no I/O, so every rule here is unit testable.
 * Token verification itself lives in ./oauth-token.
 */

/** The MCP endpoint's path. The resource identifier is built from it. */
export const MCP_PATH = '/api/mcp';

/**
 * The externally visible origin.
 *
 * `PUBLIC_URL` wins over the request's own origin because behind a reverse proxy
 * the request origin is frequently the internal one — and this value ends up in
 * the resource identifier that tokens are *audience-bound* to. If it disagrees
 * with what the client used, every token gets rejected for the right reason but
 * the wrong cause, which is a miserable thing to debug.
 */
export function publicOrigin(
    requestOrigin: string,
    env: Record<string, string | undefined> = process.env
): string {
    const configured = env.PUBLIC_URL?.trim();
    if (!configured) return stripTrailingSlash(requestOrigin);
    try {
        return stripTrailingSlash(new URL(configured).origin);
    } catch {
        console.warn(`[OAuth] PUBLIC_URL is not a valid URL ("${configured}"); using the request origin instead.`);
        return stripTrailingSlash(requestOrigin);
    }
}

function stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

/**
 * The RFC 8707 resource indicator for this server: the canonical URI of the MCP
 * endpoint, no query and no fragment. Clients send it as `resource=` when asking
 * for a token, and the provider stamps it into the token's audience.
 */
export function resourceIdentifier(origin: string, env?: Record<string, string | undefined>): string {
    return `${publicOrigin(origin, env)}${MCP_PATH}`;
}

/**
 * Where the protected-resource metadata for that identifier lives.
 *
 * RFC 9728 inserts the well-known segment between host and path, so the document
 * for `https://host/api/mcp` is at
 * `https://host/.well-known/oauth-protected-resource/api/mcp`.
 */
export function resourceMetadataUrl(origin: string, env?: Record<string, string | undefined>): string {
    return `${publicOrigin(origin, env)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/**
 * The audience values a token may carry to be accepted here.
 *
 * Defaults to the resource identifier, which is what an authorization server that
 * honours RFC 8707 resource indicators will mint. `MCP_OAUTH_AUDIENCE` overrides
 * it for the very common case of a provider that instead stamps a fixed audience
 * — a Keycloak audience mapper usually emits a client id — and accepts a
 * comma-separated list so a deployment can migrate from one to the other without
 * a flag day.
 *
 * There is deliberately no "accept any audience" setting. Audience validation is
 * the whole of the confused-deputy defence: without it, a token any other service
 * behind the same IdP obtained for itself would also open this one.
 */
export function acceptedAudiences(
    origin: string,
    env: Record<string, string | undefined> = process.env
): string[] {
    const configured = env.MCP_OAUTH_AUDIENCE?.trim();
    if (!configured) return [resourceIdentifier(origin, env)];
    const values = configured
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    return values.length > 0 ? values : [resourceIdentifier(origin, env)];
}

/** Scopes a token must carry, if the deployment wants to require any. */
export function requiredScopes(env: Record<string, string | undefined> = process.env): string[] {
    return parseScopes(env.MCP_OAUTH_REQUIRED_SCOPE);
}

/** Splits a scope claim, which may arrive space-delimited (RFC 6749) or as an array. */
export function parseScopes(scope: unknown): string[] {
    if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (typeof scope !== 'string') return [];
    return scope.split(/[\s,]+/).filter(Boolean);
}

export function hasRequiredScopes(granted: string[], required: string[]): boolean {
    return required.every((scope) => granted.includes(scope));
}

export interface ProtectedResourceMetadata {
    resource: string;
    authorization_servers: string[];
    bearer_methods_supported: string[];
    scopes_supported: string[];
    resource_name: string;
    resource_documentation: string;
}

/**
 * The RFC 9728 document. One authorization server: the app's own OIDC issuer,
 * because a token this server accepts must come from the provider that
 * authenticates its users — anything else would be a second, unreviewed way in.
 */
export function protectedResourceMetadata(
    origin: string,
    issuer: string,
    options: { scopesSupported?: string[]; env?: Record<string, string | undefined> } = {}
): ProtectedResourceMetadata {
    const env = options.env ?? process.env;
    const required = requiredScopes(env);
    return {
        resource: resourceIdentifier(origin, env),
        authorization_servers: [issuer],
        // Header only. A token in a query string lands in access logs and browser
        // history, and RFC 6750's form-encoded variant has no use for JSON-RPC.
        bearer_methods_supported: ['header'],
        scopes_supported: options.scopesSupported ?? (required.length > 0 ? required : ['openid', 'profile', 'email']),
        resource_name: 'Archie knowledge base (MCP)',
        resource_documentation: `${publicOrigin(origin, env)}/settings`
    };
}

/**
 * Strips anything that could break out of a quoted-string in a header value.
 *
 * The descriptions passed here can originate in a provider's error response or an
 * exception message, so this is the boundary where untrusted text becomes a
 * response header. A stray CR/LF would be header injection; a stray quote or
 * backslash would corrupt the parameter for the client parsing it.
 */
function sanitizeParam(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').replace(/["\\]/g, '').slice(0, 200).trim();
}

/**
 * The `WWW-Authenticate` value for a 401.
 *
 * `resource_metadata` is the part that makes discovery work: it is how an MCP
 * client learns which authorization server to send the user to. Without it the
 * client can only report that the server rejected it.
 */
export function bearerChallenge(options: {
    resourceMetadataUrl: string;
    error?: 'invalid_token' | 'insufficient_scope' | 'invalid_request';
    description?: string;
    scope?: string[];
}): string {
    const parts = [`Bearer realm="Archie MCP"`, `resource_metadata="${sanitizeParam(options.resourceMetadataUrl)}"`];
    if (options.error) parts.push(`error="${options.error}"`);
    if (options.description) {
        const description = sanitizeParam(options.description);
        if (description) parts.push(`error_description="${description}"`);
    }
    if (options.scope && options.scope.length > 0) {
        parts.push(`scope="${sanitizeParam(options.scope.join(' '))}"`);
    }
    return parts.join(', ');
}

/**
 * Extracts the credential from an `Authorization` header.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive and MCP clients do vary ("Bearer", "bearer").
 */
export function parseBearer(header: string | null | undefined): string | null {
    if (!header) return null;
    const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
    return match ? match[1] : null;
}

/** True when `token` has the three-segment shape of a signed JWT. */
export function looksLikeJwt(token: string): boolean {
    const parts = token.split('.');
    return parts.length === 3 && parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part));
}
