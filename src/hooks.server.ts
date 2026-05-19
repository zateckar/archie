import 'dotenv/config';

import { initAutoSync } from '$lib/server/git';

import { db } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth';

// ── Production safety: require explicit ADMIN_PASSWORD ──
if (process.env.NODE_ENV === 'production') {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw || pw === 'admin') {
        console.error('[FATAL] In production you must set ADMIN_PASSWORD to a secure value.');
        process.exit(1);
    }
}

// ── Seed default admin if no users exist ──
(async () => {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
        const defaultPassword = process.env.ADMIN_PASSWORD || 'admin';
        const hash = await hashPassword(defaultPassword);
        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
        console.log('Created default admin user with username: admin');
    } else if (userCount.count === 1) {
        // If only admin exists, ensure its password stays current with ADMIN_PASSWORD
        const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get('admin') as { id: number; username: string; password_hash: string; role: string } | undefined;
        if (adminUser && (adminUser.password_hash.startsWith('sha256:') || !adminUser.password_hash.startsWith('scrypt:'))) {
            const defaultPassword = process.env.ADMIN_PASSWORD || 'admin';
            const hash = await hashPassword(defaultPassword);
            db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
            console.log('Upgraded admin password hash to scrypt.');
        }
    }
})();

// Initialize auto-sync on server start
initAutoSync();

import { validateSession } from '$lib/server/auth';

export async function handle({ event, resolve }) {
    const sessionId = event.cookies.get('session');
    if (sessionId) {
        const result = validateSession(sessionId);
        if (result) {
            event.locals.user = result.user;
            event.locals.session = result.session;
        } else {
            event.locals.user = null;
            event.locals.session = null;
            event.cookies.delete('session', { path: '/' });
        }
    } else {
        event.locals.user = null;
        event.locals.session = null;
    }

    // Protect admin routes
    const adminRoutes = ['/api/git', '/api/documents', '/api/users', '/api/knowledge/reprocess'];
    if (adminRoutes.some(route => event.url.pathname.startsWith(route))) {
        if (!event.locals.user || event.locals.user.role !== 'admin') {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
    }

    // Protect wiki routes (any authenticated user)
    if (event.url.pathname.startsWith('/api/wiki')) {
        if (!event.locals.user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
    }

    // Protect wiki pages (any authenticated user)
    if (event.url.pathname.startsWith('/wiki')) {
        if (!event.locals.user) {
            return new Response(null, {
                status: 302,
                headers: { Location: '/login' }
            });
        }
    }

    const response = await resolve(event);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    return response;
}
