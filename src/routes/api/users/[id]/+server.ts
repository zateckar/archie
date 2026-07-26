import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth';

/**
 * Roles the app actually understands. `role` used to be written verbatim, so a
 * typo ('Admin', 'administrator') silently produced an account with no
 * privileges anywhere — every check in the codebase compares against these exact
 * strings, so an unrecognised value fails closed but invisibly.
 */
const VALID_ROLES = new Set(['admin', 'contributor', 'user']);

/** How many admin accounts currently exist. */
function adminCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as { c: number }).c;
}

export async function PATCH({ params, request, locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = params;
    const targetId = Number.parseInt(id, 10);
    if (!Number.isInteger(targetId)) {
        return json({ error: 'Invalid user id' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
        return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { password, role, username } = body as Record<string, unknown>;

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId) as
        { id: number; role: string } | undefined;
    if (!target) {
        return json({ error: 'User not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (username !== undefined) {
        if (typeof username !== 'string' || username.trim().length === 0) {
            return json({ error: 'username must be a non-empty string' }, { status: 400 });
        }
        // Rejected here rather than left to the UNIQUE constraint, which surfaced
        // as a 500 carrying the raw SQLite error text.
        const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username.trim(), targetId);
        if (clash) {
            return json({ error: 'Username already exists' }, { status: 409 });
        }
        updates.push('username = ?');
        values.push(username.trim());
    }

    if (password !== undefined) {
        if (typeof password !== 'string' || password.length === 0) {
            return json({ error: 'password must be a non-empty string' }, { status: 400 });
        }
        const hash = await hashPassword(password);
        updates.push('password_hash = ?');
        values.push(hash);
    }

    if (role !== undefined) {
        if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
            return json(
                { error: `role must be one of: ${[...VALID_ROLES].join(', ')}` },
                { status: 400 }
            );
        }
        // Demoting the last admin locks everyone out of /admin permanently.
        // DELETE has guarded self-deletion for a while; PATCH had no equivalent,
        // so the same lockout was reachable by changing a role instead of
        // removing an account. There IS a partial recovery path — hooks.server.ts
        // re-promotes the user named `admin` at boot — but it only helps if such a
        // user still exists, and this same endpoint can rename them.
        if (target.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
            return json(
                { error: 'Cannot demote the last remaining admin — promote another user first.' },
                { status: 409 }
            );
        }
        updates.push('role = ?');
        values.push(role);
    }

    if (updates.length === 0) {
        return json({ error: 'No updates provided' }, { status: 400 });
    }

    values.push(targetId);

    try {
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return json({ success: true });
    } catch (err: any) {
        console.error(`[Users] Failed to update user ${targetId}:`, err);
        return json({ error: 'Failed to update user' }, { status: 500 });
    }
}

export async function DELETE({ params, locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const targetId = Number.parseInt(params.id, 10);
    if (!Number.isInteger(targetId)) {
        return json({ error: 'Invalid user id' }, { status: 400 });
    }

    if (targetId === locals.user.id) {
        return json({ error: 'Cannot delete yourself' }, { status: 400 });
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId) as
        { id: number; role: string } | undefined;
    if (!target) {
        return json({ error: 'User not found' }, { status: 404 });
    }

    // No last-admin check is needed on this path, unlike PATCH. The caller is an
    // admin (checked above, from a freshly-read session row) and cannot be the
    // target (checked above), so any admin being deleted here is necessarily the
    // second-or-later one — the caller always remains. Demotion is different:
    // there, the caller CAN be the target, which is why PATCH needs the guard.
    try {
        db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
        return json({ success: true });
    } catch (err: any) {
        console.error(`[Users] Failed to delete user ${targetId}:`, err);
        return json({ error: 'Failed to delete user' }, { status: 500 });
    }
}
