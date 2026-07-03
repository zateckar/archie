import { redirect } from '@sveltejs/kit';
import crypto from 'crypto';

export async function GET({ cookies, url }) {
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    
    if (!issuer || !clientId) {
        return new Response('OIDC not configured', { status: 500 });
    }

    const state = crypto.randomBytes(16).toString('hex');
    cookies.set('oidc_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 10 });

    const redirectUri = `${url.origin}/api/auth/callback`;

    const authUrl = new URL(`${issuer}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);

    throw redirect(302, authUrl.toString());
}
