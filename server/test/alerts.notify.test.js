import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendDiscord, deliver } from '../src/services/alerts/notify.js';

function fakeFetch(captured, { ok = true, status = 204 } = {}) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return { ok, status };
  };
}

test('sendDiscord posts the message as { content } JSON', async () => {
  const cap = {};
  await sendDiscord('https://discord/webhook', 'AQI 120 exceeds 100', { fetchImpl: fakeFetch(cap) });
  assert.equal(cap.url, 'https://discord/webhook');
  assert.equal(cap.opts.method, 'POST');
  assert.equal(cap.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(cap.opts.body), { content: 'AQI 120 exceeds 100' });
});

test('sendDiscord throws on a non-2xx response', async () => {
  const cap = {};
  await assert.rejects(
    () => sendDiscord('https://discord/webhook', 'hi', { fetchImpl: fakeFetch(cap, { ok: false, status: 429 }) }),
    /429/,
  );
});

test('sendDiscord throws when the webhook URL is missing', async () => {
  await assert.rejects(() => sendDiscord('', 'hi'), /missing/);
});

test('deliver dispatches discord on delivery_method', async () => {
  const cap = {};
  await deliver(
    { delivery_method: 'discord', delivery_target: 'https://discord/webhook' },
    'msg',
    { fetchImpl: fakeFetch(cap) },
  );
  assert.equal(cap.url, 'https://discord/webhook');
});

test('deliver throws on an unknown delivery_method', async () => {
  await assert.rejects(
    () => deliver({ delivery_method: 'carrier-pigeon', delivery_target: 'x' }, 'msg'),
    /unsupported delivery_method/,
  );
});
