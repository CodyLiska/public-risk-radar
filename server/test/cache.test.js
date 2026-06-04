import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { cacheGet, cacheSet } from '../src/lib/cache.js';

// With REDIS_URL='' (set by the test script) the cache uses its in-memory
// fallback — the same code path that keeps the app working when Redis is down.

let k = 0;
const key = () => `test:key:${k++}`;

test('round-trips a stored value', async () => {
  const key1 = key();
  await cacheSet(key1, { a: 1, b: [2, 3] }, 60_000);
  assert.deepEqual(await cacheGet(key1), { a: 1, b: [2, 3] });
});

test('returns undefined for a missing key', async () => {
  assert.equal(await cacheGet(key()), undefined);
});

test('expires a value after its TTL', async () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const key1 = key();
    await cacheSet(key1, 'soon-gone', 1_000);
    assert.equal(await cacheGet(key1), 'soon-gone');
    mock.timers.tick(1_500); // advance past the TTL
    assert.equal(await cacheGet(key1), undefined);
  } finally {
    mock.timers.reset();
  }
});

test('still serves a value just before its TTL', async () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const key1 = key();
    await cacheSet(key1, 42, 1_000);
    mock.timers.tick(900);
    assert.equal(await cacheGet(key1), 42);
  } finally {
    mock.timers.reset();
  }
});
