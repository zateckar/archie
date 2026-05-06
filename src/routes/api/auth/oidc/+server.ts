import { redirect } from '@sveltejs/kit';
import crypto from 'crypto';

export async function GET({ cookies }) {
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    
    if (!issuer || !clientId) {
        return new Response('OIDC not configured', { status: 500 });
    }

    const state = crypto.randomBytes(16).toString('hex');
    cookies.set('oidc_state', state, { path: '/', httpOnly: true, maxAge: 60 * 10 });

    const authUrl = new URL(`${issuer}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', `${process.env.PUBLIC_URL || 'http://localhost:5173'}/api/auth/callback`);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);

    throw redirect(302, authUrl.toString());
}
