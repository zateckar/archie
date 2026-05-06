import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getUser, createSession, verifyPassword, hashPassword } from '$lib/server/auth';
import { checkRateLimit } from '$lib/server/rate-limit';

export const load = async ({ locals }) => {
    if (locals.user) {
        throw redirect(302, '/');
    }
    return {
        oidcEnabled: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID)
    };
};

export const actions = {
    login: async ({ request, cookies, getClientAddress }) => {
        const data = await request.formData();
        const username = data.get('username') as string;
        const password = data.get('password') as string;

        if (!username || !password) {
            return fail(400, { error: 'Missing username or password' });
        }

        // Rate limit by IP address
        const ip = getClientAddress();
        const { allowed, resetAt } = checkRateLimit(`login:${ip}`);
        if (!allowed) {
            const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
            return fail(429, { error: `Too many attempts. Try again in ${retryAfter} seconds.` });
        }

        const user = getUser(username);
        if (!user || user.provider !== 'local') {
            return fail(400, { error: 'Invalid username or password' });
        }

        const { valid, needsUpgrade } = await verifyPassword(password, user.password_hash);
        if (!valid) {
            return fail(400, { error: 'Invalid username or password' });
        }

        // Upgrade legacy SHA-256 hash to scrypt on successful login
        if (needsUpgrade) {
            const newHash = await hashPassword(password);
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
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
    }
};
