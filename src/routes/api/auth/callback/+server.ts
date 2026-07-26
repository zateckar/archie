import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createSession, safeRedirectTarget } from '$lib/server/auth';

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

    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    const clientSecret = process.env.OIDC_CLIENT_SECRET;
    const redirectUri = `${url.origin}/api/auth/callback`;

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

        // OIDC "display_name" (the `name` claim) and "email" claims are stored so
        // the admin users table can show them alongside preferred_username.
        const displayName = userInfo.name || null;
        const email = userInfo.email || null;

        let user = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').get('oidc', userInfo.sub) as any;

        if (!user) {
            // `users.username` is UNIQUE across providers, so an OIDC identity
            // whose preferred_username collides with an existing local account
            // (the seeded `admin`, most plausibly) previously threw a raw UNIQUE
            // constraint error and surfaced as a blank 500 "Authentication
            // failed" with the cause visible only in server logs.
            //
            // The collision must NOT be resolved by adopting the existing row —
            // that would hand whoever controls the IdP username the local
            // account, admin included. Instead the OIDC identity gets a distinct,
            // suffixed username; `provider_id` remains the real identity key, and
            // display_name still shows the human-readable name in the UI.
            const desiredUsername = userInfo.preferred_username || userInfo.email || userInfo.sub;
            let username = desiredUsername;
            const taken = (name: string) =>
                !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(name);
            if (taken(username)) {
                // Deterministic and collision-free: `sub` is unique per IdP subject.
                username = `${desiredUsername}@oidc-${String(userInfo.sub).slice(0, 12)}`;
                console.warn(
                    `[OIDC] Username "${desiredUsername}" is already taken by another account; ` +
                    `provisioning this OIDC identity as "${username}" instead.`
                );
            }
            const result = db.prepare('INSERT INTO users (username, role, provider, provider_id, display_name, email) VALUES (?, ?, ?, ?, ?, ?)').run(
                username,
                'user', // default role
                'oidc',
                userInfo.sub,
                displayName,
                email
            );
            user = { id: result.lastInsertRowid };
        } else {
            // Keep claims current and backfill users created before these columns
            // existed.
            db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(
                displayName,
                email,
                user.id
            );
        }

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
