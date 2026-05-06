/**
 * Minimal in-memory rate limiter using a sliding window.
 * No external dependencies — uses only Map and Date.
 */
interface Bucket {
    count: number;
    resetAt: number;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000;      // 1 minute window
const MAX_ATTEMPTS = 10;        // max attempts per window

export function checkRateLimit(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
        // Fresh window
        buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return { allowed: true, remaining: MAX_ATTEMPTS - 1, resetAt: now + WINDOW_MS };
    }

    bucket.count++;
    if (bucket.count > MAX_ATTEMPTS) {
        return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    return { allowed: true, remaining: MAX_ATTEMPTS - bucket.count, resetAt: bucket.resetAt };
}

/**
 * Periodic cleanup of expired buckets to prevent memory leaks.
 * Runs every 5 minutes.
 */
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now >= bucket.resetAt) {
            buckets.delete(key);
        }
    }
}, 300_000);