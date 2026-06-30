import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, ping } from '../src/db.js';
import { persistReport } from '../src/services/persist.js';

// Integration test for the persistence layer. Requires a reachable Postgres
// (the docker-compose `db` service). It auto-skips when no database is up, so
// `npm test` still passes in a bare checkout.
//
// This is the regression guard for the upsert bug: the synthetic report below
// deliberately contains duplicate natural keys (one gauge id twice, one FEMA id
// twice) — exactly the shape that previously triggered
// "ON CONFLICT DO UPDATE command cannot affect row a second time".

let dbUp = false;
try {
  dbUp = await ping();
} catch {
  dbUp = false;
}

after(async () => {
  await pool.end().catch(() => {});
});

// Unique markers so we can assert on / clean up only our own rows.
const TAG = `TEST-${Date.now()}`;
const ADDRESS = `__test__ ${TAG}`;

function syntheticReport() {
  return {
    location: { lat: 33.4, lon: -112.0, stateFips: '04', countyFips: '04013', tract: TAG },
    sources: {
      epaFacilities: { ok: true, data: { total: 1, facilities: [
        { registryId: `${TAG}-REG`, name: 'Test Facility', address: '1 Main', lat: 33.4, lon: -112.0, programs: ['TRI'] },
        { registryId: `${TAG}-REG`, name: 'Test Facility (dup)', lat: 33.4, lon: -112.0, programs: ['NPDES'] }, // dup key
      ] } },
      waterGauges: { ok: true, data: [
        { siteId: `${TAG}-SITE`, name: 'Gauge A', lat: 33.4, lon: -112.0, parameter: 'Discharge (cfs)', value: 10, observedAt: '2026-06-03T12:00:00Z' },
        { siteId: `${TAG}-SITE`, name: 'Gauge A (param 2)', lat: 33.4, lon: -112.0, parameter: 'Gage height (ft)', value: 2, observedAt: '2026-06-03T12:00:00Z' }, // dup key
      ] },
      disasterHistory: { ok: true, data: [
        { femaId: `${TAG}-DR`, disasterNumber: 9999, state: 'AZ', incidentType: 'Fire', title: 'Test Fire', declarationDate: '2026-01-01T00:00:00Z', incidentBegin: '2026-01-01T00:00:00Z', incidentEnd: null },
        { femaId: `${TAG}-DR`, disasterNumber: 9999, state: 'AZ', incidentType: 'Fire', title: 'Test Fire (dup)', declarationDate: '2026-01-01T00:00:00Z', incidentBegin: null, incidentEnd: null }, // dup key
      ] },
      weatherAlerts: { ok: true, data: [
        { id: `${TAG}-ALERT`, event: 'Test Alert', severity: 'Severe', onset: '2026-06-03T00:00:00Z', expires: '2026-06-04T00:00:00Z' },
      ] },
      wildfires: { ok: true, data: [] },
      earthquakes: { ok: true, data: [
        { id: `${TAG}-QUAKE`, magnitude: 3.1, place: 'test', time: '2026-05-01T00:00:00Z', lon: -112.0, lat: 33.4 },
      ] },
    },
  };
}

async function cleanup() {
  await pool.query('DELETE FROM risk_events WHERE source_id LIKE $1', [`${TAG}%`]);
  await pool.query('DELETE FROM water_gauges WHERE usgs_site_id LIKE $1', [`${TAG}%`]);
  await pool.query('DELETE FROM disaster_declarations WHERE fema_id LIKE $1', [`${TAG}%`]);
  await pool.query('DELETE FROM epa_facilities WHERE registry_id LIKE $1', [`${TAG}%`]);
  await pool.query('DELETE FROM locations WHERE address = $1', [ADDRESS]);
}

const opts = { skip: dbUp ? false : 'no database reachable (start the docker-compose db service)' };

test('persistReport collapses duplicate-keyed sources without error', opts, async () => {
  await cleanup();
  try {
    const out = await persistReport(ADDRESS, syntheticReport());

    // No table write errored (the bug surfaced here as a per-table .error).
    for (const [label, result] of Object.entries(out.persisted)) {
      assert.ok(!result.error, `${label} should not error, got: ${result.error}`);
    }

    // Duplicate keys collapse to a single upserted row each.
    assert.equal(out.persisted.waterGauges.count, 1);
    assert.equal(out.persisted.disasters.count, 1);
    assert.equal(out.persisted.epaFacilities.count, 1);
    // risk_events: 1 alert + 1 disaster + 1 quake (all distinct source ids).
    assert.equal(out.persisted.riskEvents.count, 3);
    assert.ok(out.locationId, 'a location row should be inserted');
  } finally {
    await cleanup();
  }
});

test('persistReport is idempotent across a re-search (no duplication)', opts, async () => {
  await cleanup();
  try {
    await persistReport(ADDRESS, syntheticReport());
    const out = await persistReport(ADDRESS, syntheticReport()); // same data again

    for (const [label, result] of Object.entries(out.persisted)) {
      assert.ok(!result.error, `${label} should not error on re-search, got: ${result.error}`);
    }

    // Domain tables hold exactly one row per natural key after two identical runs.
    const gauges = await pool.query('SELECT count(*)::int n FROM water_gauges WHERE usgs_site_id = $1', [`${TAG}-SITE`]);
    const disasters = await pool.query('SELECT count(*)::int n FROM disaster_declarations WHERE fema_id = $1', [`${TAG}-DR`]);
    const events = await pool.query('SELECT count(*)::int n FROM risk_events WHERE source_id LIKE $1', [`${TAG}%`]);
    assert.equal(gauges.rows[0].n, 1);
    assert.equal(disasters.rows[0].n, 1);
    assert.equal(events.rows[0].n, 3);
  } finally {
    await cleanup();
  }
});
