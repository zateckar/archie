import { redirect } from '@sveltejs/kit';
import { createSession, safeRedirectTarget } from '$lib/server/auth';
import { idpEndpoints, oidcConfig } from '$lib/server/oidc-discovery';
import { provisionOidcUser } from '$lib/server/oidc-user';

export async function GET({ request, cookies }) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const storedState = cookies.get('oidc_state');

    // Consumed alongside the state cookie whether or not the exchange succeeds,
    // so a stale destination can't attach itself to a later sign-in.
    const redirectTo = safeRedirectTarget(cookies.get('oidc_redirect'));
    cookies.delete('oidc_redirect', { path: '/' });

    // Single-use: consume the state cookie before doing anything with it. It was
    // previously left in place for its full 10-minute maxAge, so the same
    // (code, state) pair remained replayable for that whole window — and a state
    // value that outlives its one exchange is not serving its purpose.
    cookies.delete('oidc_state', { path: '/' });

    if (!code || !state || !storedState || state !== storedState) {
        return new Response('Invalid state or code', { status: 400 });
    }

    const config = oidcConfig();
    const redirectUri = `${url.origin}/api/auth/callback`;

    if (!config || !config.clientSecret) {
        return new Response('OIDC not configured', { status: 500 });
    }

    try {
        const endpoints = await idpEndpoints(config);

        const tokenRes = await fetch(endpoints.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code,
                redirect_uri: redirectUri
            })
        });

        if (!tokenRes.ok) throw new Error('Failed to fetch token');
        const tokens = await tokenRes.json();

        const userRes = await fetch(endpoints.userinfoEndpoint, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        if (!userRes.ok) throw new Error('Failed to fetch user info');
        const userInfo = await userRes.json();

        // OIDC "display_name" (the `name` claim) and "email" claims are stored so
        // the admin users table can show them alongside preferred_username. `null`
        // rather than `undefined` for absent claims: userinfo is authoritative, so
        // a claim missing from it clears the stored value (see OidcIdentityClaims).
        const user = provisionOidcUser({
            sub: userInfo.sub,
            preferred_username: userInfo.preferred_username ?? null,
            name: userInfo.name || null,
            email: userInfo.email || null
        });
        if (!user) throw new Error('Failed to provision user');

        const session = createSession(user.id);
        cookies.set('session', session.id, {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            expires: session.expiresAt,
            secure: process.env.NODE_ENV === 'production'
        });
    } catch (err) {
        console.error('OIDC Error:', err);
        return new Response('Authentication failed', { status: 500 });
    }

    throw redirect(302, redirectTo);
}
