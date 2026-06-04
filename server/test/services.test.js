import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetchJson } from './helpers.js';

import { geocodeAddress } from '../src/services/geocode.js';
import { getDisasterHistory, splitCountyGeoid } from '../src/services/fema.js';
import { getActiveAlerts, getPoint } from '../src/services/nws.js';
import { getNearbyGauges } from '../src/services/usgsWater.js';
import { getNearbyFacilities } from '../src/services/epaEcho.js';
import { getRecentQuakes } from '../src/services/usgsQuake.js';
import { getNearbyWildfires } from '../src/services/nifc.js';
import { getFloodZone } from '../src/services/femaNfhl.js';
import { getCurrentAqi } from '../src/services/airnow.js';

// These tests guard the field-projection in each service — the README calls out
// upstream field names as a known rough edge, so a mapping regression should
// fail loudly here. Each test uses distinct coordinates so the URL-keyed cache
// doesn't bleed canned payloads between cases.

// ── pure helper ───────────────────────────────────────────────────────────────
test('splitCountyGeoid splits a 5-digit GEOID', () => {
  assert.deepEqual(splitCountyGeoid('04013'), { stateFips: '04', countyFips: '013' });
});
test('splitCountyGeoid rejects malformed input', () => {
  assert.equal(splitCountyGeoid('4013'), null);
  assert.equal(splitCountyGeoid(null), null);
});

// ── geocode ───────────────────────────────────────────────────────────────────
test('geocodeAddress projects the first match', async () => {
  const restore = stubFetchJson({
    result: {
      addressMatches: [{
        matchedAddress: '1700 W WASHINGTON ST, PHOENIX, AZ, 85007',
        coordinates: { x: -112.0982, y: 33.4481 },
        geographies: {
          Counties: [{ STATE: '04', GEOID: '04013', NAME: 'Maricopa County' }],
          'Census Tracts': [{ GEOID: '04013114301' }],
        },
      }],
    },
  });
  try {
    const out = await geocodeAddress('1700 W Washington St');
    assert.equal(out.lat, 33.4481);
    assert.equal(out.lon, -112.0982);
    assert.equal(out.stateFips, '04');
    assert.equal(out.countyFips, '04013');
    assert.equal(out.county, 'Maricopa County');
    assert.equal(out.tract, '04013114301');
  } finally {
    restore();
  }
});

test('geocodeAddress returns null when there are no matches', async () => {
  const restore = stubFetchJson({ result: { addressMatches: [] } });
  try {
    assert.equal(await geocodeAddress('nowhere at all'), null);
  } finally {
    restore();
  }
});

// ── FEMA disasters ──────────────────────────────────────────────────────────
test('getDisasterHistory maps declaration fields', async () => {
  const restore = stubFetchJson({
    DisasterDeclarationsSummaries: [{
      femaDeclarationString: 'DR-4524-AZ',
      disasterNumber: 4524,
      state: 'AZ',
      incidentType: 'Fire',
      declarationTitle: 'WILDFIRES',
      declarationDate: '2020-07-13T00:00:00.000Z',
      incidentBeginDate: '2020-06-01T00:00:00.000Z',
      incidentEndDate: '2020-08-01T00:00:00.000Z',
      ihProgramDeclared: false, iaProgramDeclared: false,
      paProgramDeclared: true, hmProgramDeclared: true,
    }],
  });
  try {
    const [d] = await getDisasterHistory('04', '013');
    assert.equal(d.femaId, 'DR-4524-AZ');
    assert.equal(d.disasterNumber, 4524);
    assert.equal(d.incidentType, 'Fire');
    assert.equal(d.title, 'WILDFIRES');
    assert.deepEqual(d.programs, { ih: false, ia: false, pa: true, hm: true });
  } finally {
    restore();
  }
});

// ── NWS ───────────────────────────────────────────────────────────────────────
test('getActiveAlerts maps alert features', async () => {
  const restore = stubFetchJson({
    features: [{
      id: 'urn:oid:alert.1',
      properties: {
        event: 'Air Quality Alert', severity: 'Unknown', certainty: 'Unknown',
        urgency: 'Unknown', headline: 'AQ Alert', description: 'desc',
        onset: '2026-06-03T16:00:00Z', expires: '2026-06-04T00:00:00Z',
        areaDesc: 'Maricopa',
      },
    }],
  });
  try {
    const [a] = await getActiveAlerts(33.1, -112.1);
    assert.equal(a.id, 'urn:oid:alert.1');
    assert.equal(a.event, 'Air Quality Alert');
    assert.equal(a.areaDesc, 'Maricopa');
  } finally {
    restore();
  }
});

test('getPoint returns null when properties are missing', async () => {
  const restore = stubFetchJson({});
  try {
    assert.equal(await getPoint(33.2, -112.2), null);
  } finally {
    restore();
  }
});

// ── USGS water ──────────────────────────────────────────────────────────────
test('getNearbyGauges projects site + latest reading and names the parameter', async () => {
  const restore = stubFetchJson({
    value: {
      timeSeries: [{
        sourceInfo: {
          siteCode: [{ value: '09512162' }],
          siteName: 'Salt River near Phoenix',
          geoLocation: { geogLocation: { latitude: 33.43, longitude: -112.0 } },
        },
        values: [{ value: [{ value: '1234', dateTime: '2026-06-03T12:00:00Z' }] }],
        variable: { variableCode: [{ value: '00060' }], variableName: 'Streamflow' },
      }],
    },
  });
  try {
    const [g] = await getNearbyGauges(33.3, -112.3);
    assert.equal(g.siteId, '09512162');
    assert.equal(g.name, 'Salt River near Phoenix');
    assert.equal(g.parameter, 'Discharge (cfs)'); // 00060 → friendly name
    assert.equal(g.value, 1234); // coerced to Number
    assert.equal(g.observedAt, '2026-06-03T12:00:00Z');
  } finally {
    restore();
  }
});

// ── EPA facilities (dedup by registry id) ─────────────────────────────────────
test('getNearbyFacilities dedupes by REGISTRY_ID and collects programs', async () => {
  const restore = stubFetchJson({
    features: [
      { attributes: { REGISTRY_ID: '110', PRIMARY_NAME: 'Acme', LOCATION_ADDRESS: '1 Main', CITY_NAME: 'Phoenix', STATE_CODE: 'AZ', POSTAL_CODE: '85007', PGM_SYS_ACRNM: 'RCRAINFO' }, geometry: { x: -112.0, y: 33.4 } },
      { attributes: { REGISTRY_ID: '110', PRIMARY_NAME: 'Acme', PGM_SYS_ACRNM: 'NPDES' }, geometry: { x: -112.0, y: 33.4 } },
      { attributes: { REGISTRY_ID: '220', PRIMARY_NAME: 'Beta', PGM_SYS_ACRNM: 'TRI' }, geometry: { x: -112.1, y: 33.5 } },
    ],
  });
  try {
    const out = await getNearbyFacilities(33.4, -112.4);
    assert.equal(out.length, 2);
    const acme = out.find((f) => f.registryId === '110');
    assert.deepEqual(acme.programs, ['RCRAINFO', 'NPDES']); // merged across rows
    assert.equal(acme.address, '1 Main, Phoenix, AZ, 85007');
    assert.equal(acme.lat, 33.4);
  } finally {
    restore();
  }
});

// ── USGS earthquakes ──────────────────────────────────────────────────────────
test('getRecentQuakes maps magnitude, place and ISO time', async () => {
  const ms = Date.parse('2026-01-20T00:00:00Z');
  const restore = stubFetchJson({
    features: [{
      id: 'ci123',
      properties: { mag: 4.2, place: '10km N of Phoenix', time: ms, url: 'https://eq/ci123' },
      geometry: { coordinates: [-112.05, 33.46, 7.5] },
    }],
  });
  try {
    const [q] = await getRecentQuakes(33.5, -112.5);
    assert.equal(q.magnitude, 4.2);
    assert.equal(q.place, '10km N of Phoenix');
    assert.equal(q.time, '2026-01-20T00:00:00.000Z'); // epoch ms → ISO
    assert.equal(q.lon, -112.05);
    assert.equal(q.depthKm, 7.5);
  } finally {
    restore();
  }
});

// ── NIFC wildfires ────────────────────────────────────────────────────────────
test('getNearbyWildfires maps incident attributes', async () => {
  const ms = Date.parse('2026-02-01T00:00:00Z');
  const restore = stubFetchJson({
    features: [{
      attributes: { IncidentName: 'Rim Fire', FireCause: 'Human', DailyAcres: 1200, PercentContained: 40, FireDiscoveryDateTime: ms, POOState: 'US-AZ' },
      geometry: { x: -112.0, y: 33.4 },
    }],
  });
  try {
    const [w] = await getNearbyWildfires(33.6, -112.6);
    assert.equal(w.name, 'Rim Fire');
    assert.equal(w.acres, 1200);
    assert.equal(w.discovered, '2026-02-01T00:00:00.000Z');
    assert.equal(w.lat, 33.4);
  } finally {
    restore();
  }
});

// ── FEMA NFHL flood zone ──────────────────────────────────────────────────────
test('getFloodZone flags A/V zones as high risk', async () => {
  const restore = stubFetchJson({ features: [{ attributes: { FLD_ZONE: 'AE', ZONE_SUBTY: 'FLOODWAY' } }] });
  try {
    const out = await getFloodZone(33.7, -112.7);
    assert.equal(out.floodZone, 'AE');
    assert.equal(out.highRisk, true);
    assert.equal(out.inMappedArea, true);
  } finally {
    restore();
  }
});

test('getFloodZone reports not-in-mapped-area when no feature is returned', async () => {
  const restore = stubFetchJson({ features: [] });
  try {
    const out = await getFloodZone(33.8, -112.8);
    assert.deepEqual(out, { floodZone: null, zoneSubtype: null, highRisk: false, inMappedArea: false });
  } finally {
    restore();
  }
});

test('getFloodZone treats X zone as low risk', async () => {
  const restore = stubFetchJson({ features: [{ attributes: { FLD_ZONE: 'X', ZONE_SUBTY: null } }] });
  try {
    assert.equal((await getFloodZone(33.9, -112.9)).highRisk, false);
  } finally {
    restore();
  }
});

// ── AirNow (configured via AIRNOW_API_KEY=test-key in the test script) ────────
test('getCurrentAqi maps observations when a key is configured', async () => {
  const restore = stubFetchJson([{
    ParameterName: 'O3', AQI: 88, Category: { Name: 'Moderate' },
    ReportingArea: 'Phoenix', StateCode: 'AZ',
    DateObserved: '2026-06-03 ', HourObserved: 9, Latitude: 33.4, Longitude: -112.0,
  }]);
  try {
    const out = await getCurrentAqi(34.0, -113.0);
    assert.equal(out.configured, true);
    assert.equal(out.observations[0].aqi, 88);
    assert.equal(out.observations[0].category, 'Moderate');
    assert.equal(out.observations[0].observedAt, '2026-06-03T09:00:00');
  } finally {
    restore();
  }
});
