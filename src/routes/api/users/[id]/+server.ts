import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth';

export async function PATCH({ params, request, locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = params;
    const { password, role, username } = await request.json();

    const updates: string[] = [];
    const values: any[] = [];

    if (username) {
        updates.push('username = ?');
        values.push(username);
    }

    if (password) {
        const hash = await hashPassword(password);
        updates.push('password_hash = ?');
        values.push(hash);
    }

    if (role) {
        updates.push('role = ?');
        values.push(role);
    }

    if (updates.length === 0) {
        return json({ error: 'No updates provided' }, { status: 400 });
    }

    values.push(id);

    try {
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE({ params, locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = params;

    if (parseInt(id) === locals.user.id) {
        return json({ error: 'Cannot delete yourself' }, { status: 400 });
    }

    try {
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return json({ success: true });
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
