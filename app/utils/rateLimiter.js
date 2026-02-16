/**
 * Simple in-memory per-key rate limiter using a sliding window.
 * Suitable for single-instance deployments. For multi-instance,
 * replace with Redis-backed implementation.
 */

const windows = new Map();
const CLEANUP_INTERVAL = 60_000; // 1 minute

/**
 * Check if a request is within the rate limit.
 * @param {string} key - Identifier (e.g. shop domain)
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs - Window duration in milliseconds
 * @returns {{ allowed: boolean, remaining: number }}
 */
export function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let entry = windows.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { windowStart: now, count: 1 };
    windows.set(key, entry);
    return { allowed: true, remaining: maxRequests - 1 };
  }

  entry.count += 1;
  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: maxRequests - entry.count };
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.windowStart > 120_000) {
      windows.delete(key);
    }
  }
}, CLEANUP_INTERVAL);
