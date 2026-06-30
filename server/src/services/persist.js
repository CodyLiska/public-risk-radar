import { query } from '../db.js';

// Collapse rows sharing a natural key, keeping the last occurrence. A single
// INSERT ... ON CONFLICT cannot touch the same target row twice, so any batch
// upsert must be deduped on its conflict key first (e.g. a USGS site reporting
// multiple parameters, or FEMA returning a disaster id more than once).
export function dedupeBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (k != null) m.set(k, x);
  }
  return [...m.values()];
}

// Persist a freshly built risk report into the normalized tables.
//
// Best-effort by design: each table write is independent and the whole thing is
// wrapped so a DB outage never affects the live API response — the app keeps
// serving results straight from the upstreams even with no database at all.
//
// Writes upsert on the natural keys declared in db/init/01_schema.sql
// (registry_id, usgs_site_id, fema_id, (source, source_id)) so re-searching the
// same area refreshes rows instead of duplicating them.

/**
 * @param {string} address  the raw address the user searched
 * @param {object} report   the object returned by buildRiskReport
 * @returns {Promise<{ locationId: number|null, persisted: object }>}
 */
export async function persistReport(address, report) {
  const out = { locationId: null, persisted: {} };
  try {
    out.locationId = await insertLocation(address, report.location);

    const results = await Promise.allSettled([
      upsertFacilities(report.sources.epaFacilities),
      upsertGauges(report.sources.waterGauges),
      upsertDisasters(report.location.countyFips, report.sources.disasterHistory),
      upsertRiskEvents(report.sources),
    ]);

    const labels = ['epaFacilities', 'waterGauges', 'disasters', 'riskEvents'];
    results.forEach((r, i) => {
      out.persisted[labels[i]] =
        r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message || r.reason) };
    });
  } catch (err) {
    out.error = String(err.message || err);
  }
  return out;
}

// ── locations: one row per search (history) ──────────────────────────────────
async function insertLocation(address, loc) {
  const { rows } = await query(
    `INSERT INTO locations (address, lat, lon, geom, state_fips, county_fips, census_tract)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6)
     RETURNING id`,
    [address, loc.lat, loc.lon, loc.stateFips, loc.countyFips, loc.tract],
  );
  return rows[0]?.id ?? null;
}

// ── epa_facilities: upsert by registry_id ────────────────────────────────────
async function upsertFacilities(source) {
  const facilities = source?.data?.facilities ?? [];
  if (!source?.ok || !facilities.length) return { count: 0 };
  const f = dedupeBy(facilities, (x) => x.registryId);
  const { rowCount } = await query(
    `INSERT INTO epa_facilities (registry_id, name, address, lat, lon, geom, programs, raw_json)
     SELECT registry_id, name, address, lat, lon,
            CASE WHEN lat IS NOT NULL AND lon IS NOT NULL
                 THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326) END,
            programs, raw_json
     FROM UNNEST($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[],
                 $6::text[], $7::jsonb[])
          AS t(registry_id, name, address, lat, lon, programs, raw_json)
     ON CONFLICT (registry_id) DO UPDATE SET
       name = EXCLUDED.name, address = EXCLUDED.address,
       lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
       programs = EXCLUDED.programs, raw_json = EXCLUDED.raw_json,
       fetched_at = now()`,
    [
      f.map((x) => x.registryId),
      f.map((x) => x.name),
      f.map((x) => x.address || null),
      f.map((x) => x.lat),
      f.map((x) => x.lon),
      f.map((x) => (x.programs || []).join(',') || null),
      f.map((x) => JSON.stringify(x)),
    ],
  );
  return { count: rowCount };
}

// ── water_gauges: upsert by usgs_site_id ─────────────────────────────────────
async function upsertGauges(source) {
  if (!source?.ok || !source.data.length) return { count: 0 };
  const g = dedupeBy(source.data, (x) => x.siteId);
  const { rowCount } = await query(
    `INSERT INTO water_gauges (usgs_site_id, name, lat, lon, geom, parameter, latest_value, observed_at, raw_json)
     SELECT usgs_site_id, name, lat, lon,
            CASE WHEN lat IS NOT NULL AND lon IS NOT NULL
                 THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326) END,
            parameter, latest_value, observed_at, raw_json
     FROM UNNEST($1::text[], $2::text[], $3::float8[], $4::float8[],
                 $5::text[], $6::float8[], $7::timestamptz[], $8::jsonb[])
          AS t(usgs_site_id, name, lat, lon, parameter, latest_value, observed_at, raw_json)
     ON CONFLICT (usgs_site_id) DO UPDATE SET
       name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
       parameter = EXCLUDED.parameter, latest_value = EXCLUDED.latest_value,
       observed_at = EXCLUDED.observed_at, raw_json = EXCLUDED.raw_json, fetched_at = now()`,
    [
      g.map((x) => x.siteId),
      g.map((x) => x.name),
      g.map((x) => x.lat),
      g.map((x) => x.lon),
      g.map((x) => x.parameter || null),
      g.map((x) => x.value),
      g.map((x) => x.observedAt),
      g.map((x) => JSON.stringify(x)),
    ],
  );
  return { count: rowCount };
}

// ── disaster_declarations: upsert by fema_id ─────────────────────────────────
async function upsertDisasters(countyFips, source) {
  if (!source?.ok || !source.data.length) return { count: 0 };
  const d = dedupeBy(source.data, (x) => x.femaId);
  const { rowCount } = await query(
    `INSERT INTO disaster_declarations
       (fema_id, disaster_number, state, county_fips, incident_type,
        declaration_title, declaration_date, incident_begin, incident_end, raw_json)
     SELECT fema_id, disaster_number, state, $1, incident_type,
            declaration_title, declaration_date, incident_begin, incident_end, raw_json
     FROM UNNEST($2::text[], $3::int[], $4::text[], $5::text[], $6::text[],
                 $7::timestamptz[], $8::timestamptz[], $9::timestamptz[], $10::jsonb[])
          AS t(fema_id, disaster_number, state, incident_type, declaration_title,
                declaration_date, incident_begin, incident_end, raw_json)
     ON CONFLICT (fema_id) DO UPDATE SET
       disaster_number = EXCLUDED.disaster_number, state = EXCLUDED.state,
       county_fips = EXCLUDED.county_fips, incident_type = EXCLUDED.incident_type,
       declaration_title = EXCLUDED.declaration_title,
       declaration_date = EXCLUDED.declaration_date,
       incident_begin = EXCLUDED.incident_begin, incident_end = EXCLUDED.incident_end,
       raw_json = EXCLUDED.raw_json`,
    [
      countyFips,
      d.map((x) => x.femaId),
      d.map((x) => x.disasterNumber),
      d.map((x) => x.state || null),
      d.map((x) => x.incidentType || null),
      d.map((x) => x.title || null),
      d.map((x) => x.declarationDate),
      d.map((x) => x.incidentBegin),
      d.map((x) => x.incidentEnd),
      d.map((x) => JSON.stringify(x)),
    ],
  );
  return { count: rowCount };
}

// ── risk_events: unified timeline, upsert by (source, source_id) ──────────────
// Normalizes the time-stamped sources into one table so the timeline can later
// be served (and filtered spatially) from the DB instead of re-fetched live.
async function upsertRiskEvents(sources) {
  const rows = [];

  if (sources.weatherAlerts?.ok) {
    for (const a of sources.weatherAlerts.data) {
      rows.push(['weather', 'nws', a.id, a.event, a.severity, a.onset, a.expires, null, null, a]);
    }
  }
  if (sources.disasterHistory?.ok) {
    for (const d of sources.disasterHistory.data) {
      rows.push(['disaster', 'fema', d.femaId, `${d.incidentType}: ${d.title}`, null,
        d.declarationDate, d.incidentEnd, null, null, d]);
    }
  }
  if (sources.wildfires?.ok) {
    for (const w of sources.wildfires.data) {
      // WFIGS rows carry no stable id in our projection; key on name + discovery.
      rows.push(['fire', 'nifc', `${w.name}|${w.discovered ?? ''}`, `Wildfire: ${w.name}`, null,
        w.discovered, null, w.lon, w.lat, w]);
    }
  }
  if (sources.earthquakes?.ok) {
    for (const q of sources.earthquakes.data) {
      rows.push(['quake', 'usgs_quake', q.id, `M${q.magnitude} — ${q.place}`, null,
        q.time, null, q.lon, q.lat, q]);
    }
  }
  if (sources.naturalEvents?.ok) {
    // EONET only serves status=open, so a closed event vanishes from the live
    // feed — persisting it is the only way it survives in the /api/events history.
    for (const n of sources.naturalEvents.data) {
      rows.push(['natural', 'eonet', n.id, `${n.category}: ${n.title}`, null,
        n.time, null, n.lon, n.lat, n]);
    }
  }

  // require a source_id, then collapse on the (source, source_id) conflict key
  const valid = dedupeBy(rows.filter((r) => r[2]), (r) => `${r[1]}|${r[2]}`);
  if (!valid.length) return { count: 0 };

  const { rowCount } = await query(
    `INSERT INTO risk_events
       (type, source, source_id, title, severity, start_time, end_time, geom, raw_json)
     SELECT type, source, source_id, title, severity, start_time, end_time,
            CASE WHEN lon IS NOT NULL AND lat IS NOT NULL
                 THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326) END,
            raw_json
     FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                 $6::timestamptz[], $7::timestamptz[], $8::float8[], $9::float8[], $10::jsonb[])
          AS t(type, source, source_id, title, severity, start_time, end_time, lon, lat, raw_json)
     ON CONFLICT (source, source_id) DO UPDATE SET
       title = EXCLUDED.title, severity = EXCLUDED.severity,
       start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
       geom = EXCLUDED.geom, raw_json = EXCLUDED.raw_json, fetched_at = now()`,
    [
      valid.map((r) => r[0]),
      valid.map((r) => r[1]),
      valid.map((r) => r[2]),
      valid.map((r) => r[3]),
      valid.map((r) => r[4]),
      valid.map((r) => r[5]),
      valid.map((r) => r[6]),
      valid.map((r) => r[7]),
      valid.map((r) => r[8]),
      valid.map((r) => JSON.stringify(r[9])),
    ],
  );
  return { count: rowCount };
}
