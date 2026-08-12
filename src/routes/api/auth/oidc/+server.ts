import { redirect } from '@sveltejs/kit';
import crypto from 'crypto';
import { safeRedirectTarget } from '$lib/server/auth';
import { idpEndpoints, oidcConfig } from '$lib/server/oidc-discovery';

export async function GET({ cookies, url }) {
    const config = oidcConfig();
    if (!config) {
        return new Response('OIDC not configured', { status: 500 });
    }

    const state = crypto.randomBytes(16).toString('hex');
    cookies.set('oidc_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 10 });

    // Carry the interrupted destination across the IdP round trip so an OIDC
    // sign-in lands where a local one does. Validated on the way in as well as
    // on the way out — the cookie is httpOnly, but the value it is built from
    // came off the query string.
    const redirectTo = safeRedirectTarget(url.searchParams.get('redirectTo'));
    cookies.set('oidc_redirect', redirectTo, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 10
    });

    const redirectUri = `${url.origin}/api/auth/callback`;

    // Discovered rather than assembled from Keycloak's path layout, which is what
    // this route used to hardcode. Falls back to that layout if the provider's
    // discovery document is unreachable, so an IdP hiccup cannot lock everyone out.
    const endpoints = await idpEndpoints(config);

    const authUrl = new URL(endpoints.authorizationEndpoint);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);

    throw redirect(302, authUrl.toString());
}
