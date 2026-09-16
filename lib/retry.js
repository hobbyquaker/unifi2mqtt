/**
 * Retry timing of the poll loop: a short fixed interval while the controller is unreachable, and
 * a long backoff after a login the controller rate-limited (HTTP 429 — UniFi OS answers
 * `AUTHENTICATION_FAILED_LIMIT_REACHED` after too many failed logins and locks the account for a
 * while; retrying every few seconds keeps it locked).
 */

export const RETRY_INTERVAL = 10000;
/** First wait after a 429 without Retry-After; doubles per consecutive 429 up to RATE_LIMIT_MAX. */
export const RATE_LIMIT_BASE = 5 * 60 * 1000;
export const RATE_LIMIT_MAX = 30 * 60 * 1000;
/** A Retry-After shorter than this is not believed: the lockout outlasts it. */
export const RATE_LIMIT_MIN = 10000;

/** The `Retry-After` header (seconds, or an HTTP date) in milliseconds, or null when absent. */
export function retryAfterMs(headers, now = Date.now()) {
    const raw = headers && (headers['retry-after'] ?? headers['Retry-After']);
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }
    const s = String(value).trim();
    if (/^\d+$/.test(s)) {
        return Number(s) * 1000;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/**
 * Milliseconds until the next poll after a failure.
 * - `status` 429: `retryAfter` (ms, from the header) when the controller sent one, else
 *   RATE_LIMIT_BASE doubling with `attempt` (consecutive 429s, from 1) up to RATE_LIMIT_MAX;
 * - anything else: the fixed RETRY_INTERVAL, but never longer than the poll `interval`.
 */
export function retryDelay({status, retryAfter, attempt = 1, interval = RETRY_INTERVAL} = {}) {
    if (status === 429) {
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
            return Math.max(RATE_LIMIT_MIN, retryAfter);
        }
        return Math.min(RATE_LIMIT_MAX, RATE_LIMIT_BASE * 2 ** Math.max(0, attempt - 1));
    }
    return Math.min(interval, RETRY_INTERVAL);
}
