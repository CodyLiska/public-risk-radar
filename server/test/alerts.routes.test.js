import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool, ping } from '../src/db.js';
import { subscriptionsRouter, validateThreshold } from '../src/routes/subscriptions.js';

// ── Pure validation (no DB) ──────────────────────────────────────────────────
test('validateThreshold accepts well-formed thresholds', () => {
  assert.equal(validateThreshold('aqi', { gt: 100 }), null);
  assert.equal(validateThreshold('earthquake', { minMagnitude: 4 }), null);
  assert.equal(validateThreshold('flood', {}), null);
  assert.equal(validateThreshold('weather_alert', { severityAtLeast: 'Severe' }), null);
  assert.equal(validateThreshold('water_gauge', { siteId: '09512162', gageHeightGt: 10 }), null);
  assert.equal(validateThreshold('wildfire', {}), null);
});
test('validateThreshold rejects malformed thresholds', () => {
  assert.match(validateThreshold('aqi', {}), /numeric "gt"/);
  assert.match(validateThreshold('aqi', null), /must be an object/);
  assert.match(validateThreshold('water_gauge', { siteId: 'x' }), /gageHeightGt/);
  assert.match(validateThreshold('weather_alert', { severityAtLeast: 'Whatever' }), /severityAtLeast/);
  assert.match(validateThreshold('aqi', { type: 'flood', gt: 1 }), /does not match/);
});

// ── Router validation rejections (app, but no DB needed: 400s return early) ───
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', subscriptionsRouter);
  return app;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}/api/subscriptions` };
}

test('POST rejects an unknown event_type (400, no DB)', async () => {
  const { server, base } = await listen(makeApp());
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'volcano', threshold: {}, delivery_method: 'discord', delivery_target: 'x', lat: 1, lon: 2 }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /event_type must be one of/);
  } finally {
    server.close();
  }
});

test('POST rejects a bad threshold and a non-discord method (400, no DB)', async () => {
  const { server, base } = await listen(makeApp());
  try {
    let res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'aqi', threshold: {}, delivery_method: 'discord', delivery_target: 'x', lat: 1, lon: 2 }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /numeric "gt"/);

    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'aqi', threshold: { gt: 100 }, delivery_method: 'email', delivery_target: 'x', lat: 1, lon: 2 }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /delivery_method must be/);
  } finally {
    server.close();
  }
});

// ── DB integration: create → list → delete (auto-skips with no Postgres) ──────
let dbUp = false;
try { dbUp = await ping(); } catch { dbUp = false; }

after(async () => { await pool.end().catch(() => {}); });

test('POST creates a subscription, GET lists it, DELETE removes it', { skip: dbUp ? false : 'no database reachable' }, async () => {
  const { server, base } = await listen(makeApp());
  let id;
  try {
    const create = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: 33.45, lon: -112.07,
        event_type: 'aqi', threshold: { gt: 100 },
        delivery_method: 'discord', delivery_target: 'https://discord/test-webhook',
      }),
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    id = created.id;
    assert.equal(created.event_type, 'aqi');
    assert.equal(created.active, true);

    const list = await (await fetch(base)).json();
    assert.ok(list.subscriptions.some((s) => s.id === id));

    const del = await fetch(`${base}/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
  } finally {
    if (id) await pool.query('DELETE FROM alert_subscriptions WHERE id = $1', [id]).catch(() => {});
    server.close();
  }
});
