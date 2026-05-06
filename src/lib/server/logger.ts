/**
 * Minimal structured logger that suppresses verbose output in production.
 */
const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
    log: (...args: unknown[]) => {
        if (isDev) console.log(...args);
    },
    warn: (...args: unknown[]) => {
        console.warn('[WARN]', ...args);
    },
    error: (...args: unknown[]) => {
        console.error('[ERROR]', ...args);
    },
    info: (...args: unknown[]) => {
        if (isDev) console.log('[INFO]', ...args);
    }
};