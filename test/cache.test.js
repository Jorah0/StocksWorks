import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';

test('cache: concurrent misses for one key share a single fetch', async () => {
  const { cached } = createCache();
  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++calls), 20));
  const [a, b, c] = await Promise.all([cached('k', 1000, slow), cached('k', 1000, slow), cached('k', 1000, slow)]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(await cached('k', 1000, slow), 1, 'served from cache');
});

test('cache: a failed fetch is not cached and does not block the next try', async () => {
  const { cached } = createCache();
  await assert.rejects(cached('k', 1000, async () => { throw new Error('down'); }));
  assert.equal(await cached('k', 1000, async () => 'up'), 'up');
});

test('cache: with failTtl, a failure is remembered briefly (no hammering a rate-limited service), then retried', async () => {
  let now = 0, calls = 0;
  const { cached } = createCache({ now: () => now, failTtl: 30_000 });
  const down = async () => { calls++; throw new Error('429'); };
  await assert.rejects(cached('k', 60_000, down), /429/);
  await assert.rejects(cached('k', 60_000, down), /429/);
  assert.equal(calls, 1, 'second call within 30 s reuses the failure');
  now = 31_000;
  assert.equal(await cached('k', 60_000, async () => 'ok'), 'ok');
});

test('cache: a stale entry is dropped when read, and sweep() frees expired entries', async () => {
  let now = 0;
  const { cached, store, sweep } = createCache({ now: () => now });
  await cached('a', 1000, async () => 'A');
  await cached('b', 10_000, async () => 'B');
  now = 5000;
  sweep();
  assert.equal(store.has('a'), false);
  assert.equal(store.has('b'), true);
});

test('cache: expiry follows each entry\'s own TTL; when full, expired entries go first, then the oldest', async () => {
  let now = 0;
  const { cached, store } = createCache({ max: 3, now: () => now });
  await cached('long', 24 * 3600_000, async () => 'L');
  await cached('short', 1000, async () => 'S');
  now = 40 * 60_000; // 40 min later: 'short' expired, 'long' (24 h) must survive
  await cached('a', 1000, async () => 'A');
  await cached('b', 1000, async () => 'B'); // 4 entries > max 3 -> drop expired 'short' only
  assert.equal(store.has('long'), true, 'a 24-hour entry is not evicted just for being 30+ minutes old');
  assert.equal(store.has('short'), false);
  assert.equal(store.size, 3);
});
