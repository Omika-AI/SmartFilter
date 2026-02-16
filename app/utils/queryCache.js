/**
 * In-memory LRU cache with TTL for AI filter query results.
 * Key: "shop::collectionHandle::normalizedQuery"
 * Max 500 entries, 30-minute TTL.
 */

const MAX_ENTRIES = 500;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map();

/**
 * Build a normalized cache key.
 * @param {string} shop
 * @param {string} collectionHandle
 * @param {string} query
 * @returns {string}
 */
export function cacheKey(shop, collectionHandle, query) {
  return `${shop}::${collectionHandle || "all"}::${query.toLowerCase().trim()}`;
}

/**
 * Get a cached result. Returns undefined on miss or expired entry.
 * Implements LRU by deleting and re-inserting on access.
 * @param {string} key
 * @returns {{ filters: Array, explanation: string } | undefined}
 */
export function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return undefined;
  }

  // LRU: move to end
  cache.delete(key);
  cache.set(key, entry);

  return entry.value;
}

/**
 * Store a result in the cache. Evicts oldest entry if at capacity.
 * @param {string} key
 * @param {{ filters: Array, explanation: string }} value
 */
export function cacheSet(key, value) {
  // Delete first so re-set moves it to end
  cache.delete(key);

  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }

  cache.set(key, { value, timestamp: Date.now() });
}

/**
 * Flush all cache entries for a given shop domain.
 * @param {string} shopDomain
 */
export function cacheFlushShop(shopDomain) {
  const prefix = `${shopDomain}::`;
  let flushed = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      flushed++;
    }
  }
  if (flushed > 0) {
    console.log(`[Cache] Flushed ${flushed} entries for ${shopDomain}`);
  }
}
