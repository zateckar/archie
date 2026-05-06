import crypto from 'crypto';

/**
 * Derives an AES-256-GCM encryption key from an ENCRYPTION_KEY env var.
 * If not set, generates one on first run (warns in dev, exits in prod).
 */
function getEncryptionKey(): Buffer {
    let key = process.env.ENCRYPTION_KEY;
    if (!key) {
        if (process.env.NODE_ENV === 'production') {
            console.error('[FATAL] ENCRYPTION_KEY must be set in production for PAT encryption.');
            process.exit(1);
        }
        // Dev fallback: derive from a known value so existing PATs remain decryptable
        key = 'dev-only-not-secure-change-in-production-!!';
        console.warn('[WARN] ENCRYPTION_KEY not set — using insecure dev fallback for PAT encryption.');
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