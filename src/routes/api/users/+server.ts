import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth';

export async function GET({ locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const users = db.prepare('SELECT id, username, role, provider, created_at FROM users').all();
    return json(users);
}

export async function POST({ request, locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { username, password, role } = await request.json();

    if (!username || !password) {
        return json({ error: 'Missing username or password' }, { status: 400 });
    }

    const hash = await hashPassword(password);

    try {
        const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role || 'user');
        return json({ id: result.lastInsertRowid, username, role: role || 'user' });
    } catch (err: any) {
        if (err.message.includes('UNIQUE constraint failed')) {
            return json({ error: 'Username already exists' }, { status: 400 });
        }
        return json({ error: err.message }, { status: 500 });
    }
}
