import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Path inside the data volume where the auto-generated key is persisted
const KEY_FILE = path.join(process.cwd(), 'data', '.encryption_key');

/**
 * Resolves the AES-256-GCM encryption key with the following priority:
 *  1. ENCRYPTION_KEY env var (explicit override)
 *  2. Persisted key file in data/ volume (auto-generated on first run)
 *  3. Generate a new random key, save it to data/, and use it
 *
 * The key file lives inside the mounted data volume so it survives restarts.
 */
function getEncryptionKey(): Buffer {
    let key = process.env.ENCRYPTION_KEY;

    if (!key) {
        // Try reading a previously generated key from the data volume
        if (fs.existsSync(KEY_FILE)) {
            key = fs.readFileSync(KEY_FILE, 'utf8').trim();
        } else {
            // First run: generate a secure random key and persist it
            key = crypto.randomBytes(32).toString('hex');
            try {
                fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
                fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
                console.log(`[INFO] Generated new ENCRYPTION_KEY and saved to ${KEY_FILE}`);
            } catch (err) {
                console.error('[ERROR] Could not persist ENCRYPTION_KEY to data directory:', err);
            }
        }
    }

    // Use SHA-256 to normalize any key length to exactly 32 bytes (AES-256)
    return crypto.createHash('sha256').update(key).digest();
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function encrypt(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Encode as: iv:authTag:ciphertext (all hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encoded: string): string {
    const key = getEncryptionKey();
    const parts = encoded.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
}