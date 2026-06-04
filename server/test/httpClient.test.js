import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/lib/httpClient.js';
import { stubFetchWith, jsonResponse } from './helpers.js';

// A unique URL per test keeps the (in-memory) cache from bleeding between cases.
let n = 0;
const url = () => `https://example.test/resource/${n++}`;

test('returns parsed JSON on success', async () => {
  const stub = stubFetchWith(() => jsonResponse({ hello: 'world' }));
  try {
    assert.deepEqual(await fetchJson(url()), { hello: 'world' });
  } finally {
    stub.restore();
  }
});

test('retries on 5xx then succeeds', async () => {
  const stub = stubFetchWith((_u, _i, call) =>
    call < 3 ? jsonResponse(null, { ok: false, status: 503 }) : jsonResponse({ ok: 1 }),
  );
  try {
    const out = await fetchJson(url(), { retries: 2 });
    assert.deepEqual(out, { ok: 1 });
    assert.equal(stub.calls(), 3); // 2 failures + 1 success
  } finally {
    stub.restore();
  }
});

test('does not retry on 4xx', async () => {
  const stub = stubFetchWith(() => jsonResponse(null, { ok: false, status: 404 }));
  try {
    await assert.rejects(() => fetchJson(url(), { retries: 2 }), /HTTP 404/);
    assert.equal(stub.calls(), 1); // 4xx is terminal
  } finally {
    stub.restore();
  }
});

test('gives up after exhausting retries on persistent 5xx', async () => {
  const stub = stubFetchWith(() => jsonResponse(null, { ok: false, status: 500 }));
  try {
    await assert.rejects(() => fetchJson(url(), { retries: 1 }));
    assert.equal(stub.calls(), 2); // initial + 1 retry
  } finally {
    stub.restore();
  }
});

test('caches successful responses by URL when a TTL is set', async () => {
  const u = url();
  const stub = stubFetchWith(() => jsonResponse({ cached: true }));
  try {
    await fetchJson(u, { cacheTtlMs: 60_000 });
    await fetchJson(u, { cacheTtlMs: 60_000 });
    assert.equal(stub.calls(), 1); // second call served from cache
  } finally {
    stub.restore();
  }
});

test('does not cache when no TTL is given', async () => {
  const u = url();
  const stub = stubFetchWith(() => jsonResponse({ x: 1 }));
  try {
    await fetchJson(u);
    await fetchJson(u);
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
  }
});

test('aborts a slow request after the timeout', async () => {
  const stub = stubFetchWith(
    (_u, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  try {
    await assert.rejects(() => fetchJson(url(), { timeoutMs: 30, retries: 0 }));
  } finally {
    stub.restore();
  }
});
