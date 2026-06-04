import { fetchJson } from '../lib/httpClient.js';

// EPA-regulated facilities near a point. No key.
//
// Source: EPA Facility Registry Service (FRS) — ArcGIS REST.
// Layer 8 (FACILITY_INTERESTS) is the combined cross-program facility layer.
// Unlike the legacy echodata.epa.gov ECHO endpoint, this ArcGIS service is not
// subject to the per-IP 300/hr · 1,500/day throttle.
// https://geodata.epa.gov/arcgis/rest/services/OEI/FRS_INTERESTS/MapServer/8
const LAYER =
  'https://geodata.epa.gov/arcgis/rest/services/OEI/FRS_INTERESTS/MapServer/8/query';

const OUT_FIELDS = [
  'REGISTRY_ID',
  'PRIMARY_NAME',
  'LOCATION_ADDRESS',
  'CITY_NAME',
  'STATE_CODE',
  'POSTAL_CODE',
  'PGM_SYS_ACRNM',
].join(',');

/**
 * EPA-regulated facilities within `radiusMiles` of a point.
 *
 * The FRS layer carries one row per facility *program interest*, so a single
 * facility can appear several times. We dedupe by registry ID and collect each
 * facility's program acronyms (e.g. RCRAINFO, NPDES, TRI).
 *
 * @returns {Promise<Array<{ registryId, name, address, lat, lon, programs }>>}
 */
export async function getNearbyFacilities(lat, lon, radiusMiles = 5, limit = 200) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    distance: String(radiusMiles),
    units: 'esriSRUnit_StatuteMile',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    resultRecordCount: String(limit),
    f: 'json',
  });
  const data = await fetchJson(`${LAYER}?${params}`, { cacheTtlMs: 6 * 60 * 60 * 1000 });

  const byRegistry = new Map();
  for (const feature of data?.features ?? []) {
    const a = feature.attributes || {};
    const id = a.REGISTRY_ID;
    if (!id) continue;

    let entry = byRegistry.get(id);
    if (!entry) {
      entry = {
        registryId: id,
        name: a.PRIMARY_NAME || 'Unknown facility',
        address: [a.LOCATION_ADDRESS, a.CITY_NAME, a.STATE_CODE, a.POSTAL_CODE]
          .filter((p) => p && p !== 'NO ADDRESS ON FILE' && p !== 'UNKNOWN')
          .join(', '),
        // Prefer the geometry — LATITUDE83/LONGITUDE83 attrs are often null.
        lat: feature.geometry?.y ?? null,
        lon: feature.geometry?.x ?? null,
        programs: [],
      };
      byRegistry.set(id, entry);
    }
    if (a.PGM_SYS_ACRNM && !entry.programs.includes(a.PGM_SYS_ACRNM)) {
      entry.programs.push(a.PGM_SYS_ACRNM);
    }
  }

  return [...byRegistry.values()];
}
