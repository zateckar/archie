import { db } from './db';
import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24; // 24 hours for production

/**
 * Hash a password using scrypt (salt + CPU/memory-hard KDF).
 * Returns a self-describing string: "scrypt:salt:derivedKey"
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 * Supports both the modern "scrypt:" format and legacy SHA-256 hashes
 * for backward compatibility.
 */
export async function verifyPassword(password: string, stored: string): Promise<{ valid: boolean; needsUpgrade: boolean }> {
    if (stored.startsWith('scrypt:')) {
        const [, salt, key] = stored.split(':');
        const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
        return { valid: crypto.timingSafeEqual(derivedKey, Buffer.from(key, 'hex')), needsUpgrade: false };
    }
    // Legacy SHA-256 fallback: accept but flag for upgrade
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    return { valid: hash === stored, needsUpgrade: true };
}

export function createSession(userId: number) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt.toISOString());
    return { id: sessionId, expiresAt };
}

export function validateSession(sessionId: string) {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as { id: string; user_id: number; expires_at: string } | undefined;
    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        return null;
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as { id: number; username: string; role: string; password_hash: string } | undefined;
    if (!user) return null;
    return { session, user };
}

export function invalidateSession(sessionId: string) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getUser(username: string) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: number; username: string; role: string; password_hash: string; provider: string } | undefined;
}

export function createUser(username: string, passwordHash: string | null, role: string = 'user', provider: string = 'local', providerId: string | null = null) {
    const result = db.prepare('INSERT INTO users (username, password_hash, role, provider, provider_id) VALUES (?, ?, ?, ?, ?)').run(username, passwordHash, role, provider, providerId);
    return result.lastInsertRowid;
}
