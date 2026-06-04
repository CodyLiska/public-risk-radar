import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, shouldFire } from '../src/services/alerts/worker.js';

// shouldFire is the edge-trigger heart of the dedupe.
test('shouldFire: fires on the first cross (no prior state)', () => {
  assert.equal(shouldFire(null, 120), true);
  assert.equal(shouldFire({ value: null }, 120), true);
});
test('shouldFire: stays quiet while a numeric reading holds or eases', () => {
  assert.equal(shouldFire({ value: 120 }, 120), false);
  assert.equal(shouldFire({ value: 120 }, 110), false);
});
test('shouldFire: re-fires when a numeric reading escalates', () => {
  assert.equal(shouldFire({ value: 120 }, 150), true);
});
test('shouldFire: categorical re-fires only on change', () => {
  assert.equal(shouldFire({ value: 'Severe' }, 'Severe'), false);
  assert.equal(shouldFire({ value: 'Severe' }, 'Extreme'), true);
});

// A small harness: one aqi subscription, controllable source value + spies.
function harness(sub, sourceValue) {
  const calls = { delivered: [], fired: [], reset: [], logs: [] };
  const deps = {
    loadActiveSubscriptions: async () => [sub],
    fetchSource: async () => ({ configured: true, observations: [{ aqi: sourceValue, category: 'x', reportingArea: 'y' }] }),
    deliver: async (s, msg) => calls.delivered.push({ id: s.id, msg }),
    markFired: async (id, value) => { calls.fired.push({ id, value }); sub.last_state = { value }; },
    reset: async (id) => { calls.reset.push(id); sub.last_state = null; },
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

test('runOnce: fires once on cross, stays quiet while still crossed, re-arms after drop', async () => {
  const sub = { id: 1, event_type: 'aqi', threshold: { gt: 100 }, last_state: null, lat: 33, lon: -112 };

  // 1) crosses → fires
  let h = harness(sub, 130);
  let r = await runOnce(h.deps);
  assert.equal(r.fired, 1);
  assert.deepEqual(h.calls.fired, [{ id: 1, value: 130 }]);

  // 2) still crossed at the same level → no second fire
  h = harness(sub, 125);
  r = await runOnce(h.deps);
  assert.equal(r.fired, 0);
  assert.equal(h.calls.delivered.length, 0);

  // 3) escalates → fires again
  h = harness(sub, 180);
  r = await runOnce(h.deps);
  assert.equal(r.fired, 1);

  // 4) falls back below threshold → reset (re-arm), no fire
  h = harness(sub, 40);
  r = await runOnce(h.deps);
  assert.equal(r.fired, 0);
  assert.deepEqual(h.calls.reset, [1]);
  assert.equal(sub.last_state, null);

  // 5) crosses again after re-arm → fires
  h = harness(sub, 110);
  r = await runOnce(h.deps);
  assert.equal(r.fired, 1);
});

test('runOnce: a failing subscription is logged and never stops the loop', async () => {
  const subs = [
    { id: 1, event_type: 'aqi', threshold: { gt: 100 }, last_state: null, lat: 33, lon: -112 },
    { id: 2, event_type: 'aqi', threshold: { gt: 100 }, last_state: null, lat: 33, lon: -112 },
  ];
  const delivered = [];
  const logs = [];
  const deps = {
    loadActiveSubscriptions: async () => subs,
    fetchSource: async (sub) => {
      if (sub.id === 1) throw new Error('upstream 503');
      return { observations: [{ aqi: 200 }] };
    },
    deliver: async (s) => delivered.push(s.id),
    markFired: async () => {},
    reset: async () => {},
    log: (m) => logs.push(m),
  };
  const r = await runOnce(deps);
  assert.equal(r.evaluated, 2);
  assert.equal(r.fired, 1);
  assert.deepEqual(delivered, [2]); // sub 2 still processed after sub 1 threw
  assert.match(logs[0], /subscription 1 failed: upstream 503/);
});

test('runOnce: wildfire threshold receives the subscription origin (lat/lon)', async () => {
  const sub = {
    id: 9, event_type: 'wildfire', threshold: { withinMiles: 5 }, last_state: null,
    lat: 33.45, lon: -112.07,
  };
  // A fire ~3.5mi away — only "within 5mi" if the origin was injected into threshold.
  const deps = {
    loadActiveSubscriptions: async () => [sub],
    fetchSource: async () => [{ name: 'Near Fire', lat: 33.5, lon: -112.07 }],
    deliver: async () => {},
    markFired: async () => {},
    reset: async () => {},
  };
  const r = await runOnce(deps);
  assert.equal(r.fired, 1);
});
