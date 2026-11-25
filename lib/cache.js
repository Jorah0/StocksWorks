// Small TTL cache for upstream API answers. Concurrent misses for one key share a single in-flight fetch
// (no duplicate downloads), each entry expires on its own TTL, and when full the expired entries go first.
// failTtl > 0: a failed fetch is remembered that long, so a rate-limited service isn't hit again on every refresh.
export function createCache({ max = 300, now = Date.now, failTtl = 0 } = {}) {
  const store = new Map(); // key -> { at, ttl, value } | { at, ttl, error }
  const inflight = new Map(); // key -> Promise
  const sweep = () => { const t = now(); for (const [k, v] of store) if (t - v.at >= v.ttl) store.delete(k); };
  const prune = () => {
    if (store.size <= max) return;
    sweep();
    while (store.size > max) store.delete(store.keys().next().value); // Map keeps insertion order: oldest first
  };
  const put = (key, entry) => { store.delete(key); store.set(key, entry); prune(); }; // re-insert: order reflects freshness
  async function cached(key, ttlMs, fn) {
    const hit = store.get(key);
    if (hit) {
      if (now() - hit.at < Math.min(ttlMs, hit.ttl)) { if ('error' in hit) throw hit.error; return hit.value; }
      store.delete(key); // stale: free it now rather than at the next prune
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        put(key, { at: now(), ttl: ttlMs, value });
        return value;
      } catch (error) {
        if (failTtl > 0) put(key, { at: now(), ttl: failTtl, error });
        throw error;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  return { cached, store, sweep, delete: (k) => store.delete(k) };
}
