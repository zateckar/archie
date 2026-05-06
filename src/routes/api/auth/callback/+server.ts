import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createSession } from '$lib/server/auth';

export async function GET({ request, cookies }) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const storedState = cookies.get('oidc_state');

    if (!code || !state || state !== storedState) {
        return new Response('Invalid state or code', { status: 400 });
    }

    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    const clientSecret = process.env.OIDC_CLIENT_SECRET;
    const redirectUri = `${process.env.PUBLIC_URL || 'http://localhost:5173'}/api/auth/callback`;

    if (!issuer || !clientId || !clientSecret) {
        return new Response('OIDC not configured', { status: 500 });
    }

    try {
        const tokenRes = await fetch(`${issuer}/protocol/openid-connect/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri
            })
        });

        if (!tokenRes.ok) throw new Error('Failed to fetch token');
        const tokens = await tokenRes.json();

        const userRes = await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        if (!userRes.ok) throw new Error('Failed to fetch user info');
        const userInfo = await userRes.json();

        let user = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').get('oidc', userInfo.sub) as any;

        if (!user) {
            const username = userInfo.preferred_username || userInfo.email || userInfo.sub;
            const result = db.prepare('INSERT INTO users (username, role, provider, provider_id) VALUES (?, ?, ?, ?)').run(
                username,
                'user', // default role
                'oidc',
                userInfo.sub
            );
            user = { id: result.lastInsertRowid };
        }

        const session = createSession(user.id);
        cookies.set('session', session.id, {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            expires: session.expiresAt,
            secure: process.env.NODE_ENV === 'production'
        });

        throw redirect(302, '/');
    } catch (err) {
        console.error('OIDC Error:', err);
        return new Response('Authentication failed', { status: 500 });
    }
}
