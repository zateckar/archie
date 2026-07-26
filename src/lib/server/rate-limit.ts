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

export interface RateLimitOptions {
    /** Requests permitted per window. Defaults to MAX_ATTEMPTS. */
    max?: number;
    /** Window length in ms. Defaults to WINDOW_MS. */
    windowMs?: number;
}

export function checkRateLimit(
    key: string,
    options: RateLimitOptions = {}
): { allowed: boolean; remaining: number; resetAt: number } {
    const max = options.max ?? MAX_ATTEMPTS;
    const windowMs = options.windowMs ?? WINDOW_MS;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
        // Fresh window
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
    }

    bucket.count++;
    if (bucket.count > max) {
        return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    return { allowed: true, remaining: max - bucket.count, resetAt: bucket.resetAt };
}

/**
 * Ceiling on `/api/chat` requests per user per minute.
 *
 * That endpoint fans out to a dozen-plus provider calls per request (analysis,
 * two retrieval levels, reranking, evaluation, optional refinement passes,
 * synthesis, then the answer stream), so an unthrottled client — a stuck retry
 * loop as easily as a malicious one — converts directly into provider spend and
 * starves every other user behind the gateway's concurrency limit. Generous
 * enough that no human conversation reaches it.
 */
export const CHAT_RATE_LIMIT: RateLimitOptions = {
    max: Number(process.env.CHAT_RATE_LIMIT_PER_MIN) || 20,
    windowMs: 60_000
};

/**
 * Periodic cleanup of expired buckets to prevent memory leaks.
 * Runs every 5 minutes.
 *
 * `unref()` so this timer does not by itself keep the Node event loop alive.
 * Without it, anything that transitively imports this module never exits on its
 * own — which includes the `tsx` scripts (`npm run eval`, `npm run reembed`),
 * since they reach it through the server modules they exercise.
 */
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now >= bucket.resetAt) {
            buckets.delete(key);
        }
    }
}, 300_000);
cleanupTimer.unref?.();