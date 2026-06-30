import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, buildTimeline } from '../src/services/aggregate.js';

// settle() normalizes a Promise.allSettled result into { ok, data, error } so a
// single failing upstream never breaks the response.
test('settle wraps a fulfilled result as ok', () => {
  assert.deepEqual(settle({ status: 'fulfilled', value: [1, 2] }), {
    ok: true,
    data: [1, 2],
  });
});

test('settle wraps a rejected result as not-ok with an error string', () => {
  const out = settle({ status: 'rejected', reason: new Error('boom') });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'boom');
});

test('settle stringifies a non-Error rejection reason', () => {
  const out = settle({ status: 'rejected', reason: 'plain string' });
  assert.deepEqual(out, { ok: false, error: 'plain string' });
});

// buildTimeline merges time-stamped events from several sources, drops undated
// ones, and sorts newest-first.
const fulfilled = (value) => ({ status: 'fulfilled', value });
const rejected = () => ({ status: 'rejected', reason: new Error('down') });

test('buildTimeline merges sources and sorts newest first', () => {
  const out = buildTimeline({
    alerts: fulfilled([{ event: 'Flood Warning', severity: 'Severe', onset: '2026-01-10T00:00:00Z' }]),
    disasters: fulfilled([{ incidentType: 'Fire', title: 'Rose Fire', declarationDate: '2026-03-01T00:00:00Z' }]),
    wildfires: fulfilled([{ name: 'Rim', discovered: '2026-02-01T00:00:00Z' }]),
    quakes: fulfilled([{ magnitude: 4.2, place: 'near Phoenix', time: '2026-01-20T00:00:00Z' }]),
  });
  assert.equal(out.length, 4);
  // newest (disaster, Mar) first → oldest (alert, Jan 10) last
  assert.deepEqual(out.map((e) => e.type), ['disaster', 'fire', 'quake', 'weather']);
  assert.equal(out[0].title, 'Fire: Rose Fire');
});

test('buildTimeline carries lat/lon for fires and quakes only (not alerts/disasters)', () => {
  const out = buildTimeline({
    alerts: fulfilled([{ event: 'Heat', severity: 'Minor', onset: '2026-01-10T00:00:00Z' }]),
    disasters: fulfilled([{ incidentType: 'Fire', title: 'X', declarationDate: '2026-03-01T00:00:00Z' }]),
    wildfires: fulfilled([{ name: 'Rim', discovered: '2026-02-01T00:00:00Z', lat: 34.1, lon: -111.5 }]),
    quakes: fulfilled([{ magnitude: 4, place: 'p', time: '2026-01-20T00:00:00Z', lat: 33.2, lon: -112.3 }]),
  });
  const byType = Object.fromEntries(out.map((e) => [e.type, e]));
  assert.equal(byType.fire.lat, 34.1);
  assert.equal(byType.quake.lon, -112.3);
  assert.equal(byType.weather.lat, undefined); // area-based alert, no point
  assert.equal(byType.disaster.lat, undefined); // county-level, no point
});

test('buildTimeline drops events without a time', () => {
  const out = buildTimeline({
    alerts: fulfilled([{ event: 'No Time Alert', severity: 'Minor' }]), // no onset/expires
    disasters: fulfilled([]),
    wildfires: fulfilled([]),
    quakes: fulfilled([]),
  });
  assert.equal(out.length, 0);
});

test('buildTimeline ignores rejected sources without throwing', () => {
  const out = buildTimeline({
    alerts: rejected(),
    disasters: fulfilled([{ incidentType: 'Flood', title: 'Big Flood', declarationDate: '2026-01-01T00:00:00Z' }]),
    wildfires: rejected(),
    quakes: rejected(),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'disaster');
});

test('buildTimeline falls back to alert expires when onset is missing', () => {
  const out = buildTimeline({
    alerts: fulfilled([{ event: 'Heat', severity: 'Moderate', expires: '2026-06-01T00:00:00Z' }]),
    disasters: fulfilled([]),
    wildfires: fulfilled([]),
    quakes: fulfilled([]),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].time, '2026-06-01T00:00:00Z');
});
