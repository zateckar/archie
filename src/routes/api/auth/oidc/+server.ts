import { redirect } from '@sveltejs/kit';
import crypto from 'crypto';
import { safeRedirectTarget } from '$lib/server/auth';

export async function GET({ cookies, url }) {
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    
    if (!issuer || !clientId) {
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

    const authUrl = new URL(`${issuer}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);

    throw redirect(302, authUrl.toString());
}
