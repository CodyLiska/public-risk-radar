import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateThreshold, EVENT_TYPES } from '../src/services/alerts/evaluate.js';

// ── aqi ──────────────────────────────────────────────────────────────────────
test('aqi: crossed when worst observation exceeds gt', () => {
  const data = { configured: true, observations: [{ aqi: 42, category: 'Good' }, { aqi: 120, category: 'Unhealthy', reportingArea: 'Phoenix' }] };
  const r = evaluateThreshold('aqi', { gt: 100 }, data);
  assert.equal(r.crossed, true);
  assert.equal(r.value, 120);
  assert.match(r.message, /120/);
});
test('aqi: not crossed at the boundary (strictly greater than)', () => {
  const r = evaluateThreshold('aqi', { gt: 100 }, { observations: [{ aqi: 100 }] });
  assert.equal(r.crossed, false);
});
test('aqi: no observations → not crossed', () => {
  assert.equal(evaluateThreshold('aqi', { gt: 100 }, { observations: [] }).crossed, false);
});

// ── weather_alert ────────────────────────────────────────────────────────────
test('weather_alert: fires when severity meets the floor', () => {
  const data = [{ event: 'Heat', severity: 'Moderate' }, { event: 'Flood Warning', severity: 'Severe' }];
  const r = evaluateThreshold('weather_alert', { severityAtLeast: 'Severe' }, data);
  assert.equal(r.crossed, true);
  assert.equal(r.value, 'Severe');
});
test('weather_alert: below the floor → not crossed', () => {
  const r = evaluateThreshold('weather_alert', { severityAtLeast: 'Severe' }, [{ event: 'Heat', severity: 'Moderate' }]);
  assert.equal(r.crossed, false);
});
test('weather_alert: Unknown severity does not satisfy a Minor floor', () => {
  const r = evaluateThreshold('weather_alert', { severityAtLeast: 'Minor' }, [{ event: 'Air Quality', severity: 'Unknown' }]);
  assert.equal(r.crossed, false);
});

// ── flood ────────────────────────────────────────────────────────────────────
test('flood: crossed only in a high-risk SFHA', () => {
  assert.equal(evaluateThreshold('flood', {}, { highRisk: true, floodZone: 'AE' }).crossed, true);
  assert.equal(evaluateThreshold('flood', {}, { highRisk: false, floodZone: 'X' }).crossed, false);
});

// ── wildfire ─────────────────────────────────────────────────────────────────
test('wildfire: any nearby fire crosses when no radius given', () => {
  const r = evaluateThreshold('wildfire', {}, [{ name: 'Bush Fire', lat: 33.6, lon: -111.5 }]);
  assert.equal(r.crossed, true);
  assert.equal(r.value, 1);
});
test('wildfire: withinMiles filters out fires beyond the radius', () => {
  const origin = { withinMiles: 10, lat: 33.45, lon: -112.07 };
  const far = [{ name: 'Far Fire', lat: 34.5, lon: -112.07 }]; // ~70mi north
  assert.equal(evaluateThreshold('wildfire', origin, far).crossed, false);
  const near = [{ name: 'Near Fire', lat: 33.5, lon: -112.07 }]; // ~3.5mi
  assert.equal(evaluateThreshold('wildfire', origin, near).crossed, true);
});
test('wildfire: empty list → not crossed', () => {
  assert.equal(evaluateThreshold('wildfire', {}, []).crossed, false);
});

// ── earthquake ───────────────────────────────────────────────────────────────
test('earthquake: strongest quake at/above minMagnitude crosses', () => {
  const data = [{ magnitude: 2.1, place: 'a' }, { magnitude: 4.3, place: 'near town' }];
  const r = evaluateThreshold('earthquake', { minMagnitude: 4.0 }, data);
  assert.equal(r.crossed, true);
  assert.equal(r.value, 4.3);
});
test('earthquake: boundary is inclusive (>=)', () => {
  assert.equal(evaluateThreshold('earthquake', { minMagnitude: 4.0 }, [{ magnitude: 4.0, place: 'x' }]).crossed, true);
});
test('earthquake: all below threshold → not crossed', () => {
  assert.equal(evaluateThreshold('earthquake', { minMagnitude: 4.0 }, [{ magnitude: 3.9, place: 'x' }]).crossed, false);
});

// ── water_gauge ──────────────────────────────────────────────────────────────
test('water_gauge: matching site over the height limit crosses', () => {
  const data = [
    { siteId: '09512162', name: 'Indian Bend', parameter: 'Gage height (ft)', value: 12.5 },
    { siteId: '09512162', name: 'Indian Bend', parameter: 'Discharge (cfs)', value: 800 },
  ];
  const r = evaluateThreshold('water_gauge', { siteId: '09512162', gageHeightGt: 10 }, data);
  assert.equal(r.crossed, true);
  assert.equal(r.value, 12.5);
});
test('water_gauge: unknown site → not crossed', () => {
  const r = evaluateThreshold('water_gauge', { siteId: 'nope', gageHeightGt: 10 }, [
    { siteId: '09512162', parameter: 'Gage height (ft)', value: 99 },
  ]);
  assert.equal(r.crossed, false);
});

// ── dispatch ─────────────────────────────────────────────────────────────────
test('unknown event_type throws', () => {
  assert.throws(() => evaluateThreshold('volcano', {}, []), /unknown event_type/);
});
test('EVENT_TYPES lists all six supported types', () => {
  assert.deepEqual(
    [...EVENT_TYPES].sort(),
    ['aqi', 'earthquake', 'flood', 'water_gauge', 'weather_alert', 'wildfire'],
  );
});
