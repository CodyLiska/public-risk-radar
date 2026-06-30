import { fetchJson } from '../lib/httpClient.js';

// FEMA National Flood Hazard Layer (NFHL) — ArcGIS REST MapServer.
// Layer 28 = Flood Hazard Zones (S_FLD_HAZ_AR). No key.
// https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer
const LAYER =
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

// Zones beginning with A or V are Special Flood Hazard Areas (high risk).
function isHighRisk(zone) {
  return /^(A|V)/i.test(zone || '');
}

// Three-tier risk from the zone + subtype. Zone X collapses two very different
// realities: *shaded* X (the 0.2% annual-chance / 500-year floodplain, or areas
// behind a levee) is moderate risk, while *unshaded* X is minimal — the subtype
// is what tells them apart. Zone D means FEMA hasn't assessed the location.
function classifyRisk(zone, subtype) {
  if (isHighRisk(zone)) return 'high';
  if (/0\.2 PCT ANNUAL CHANCE|REDUCED FLOOD RISK DUE TO LEVEE/i.test(subtype || '')) return 'moderate';
  if (/^D$/i.test(zone || '')) return 'undetermined';
  return 'minimal';
}

/**
 * Look up the flood zone at a point.
 * @returns {Promise<{ floodZone: string|null, zoneSubtype: string|null, highRisk: boolean, riskLevel: 'high'|'moderate'|'minimal'|'undetermined'|null, inMappedArea: boolean }>}
 */
export async function getFloodZone(lat, lon) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY',
    returnGeometry: 'false',
    f: 'json',
  });
  const data = await fetchJson(`${LAYER}?${params}`, { cacheTtlMs: 24 * 60 * 60 * 1000 });

  const attrs = data?.features?.[0]?.attributes;
  if (!attrs) {
    return { floodZone: null, zoneSubtype: null, highRisk: false, riskLevel: null, inMappedArea: false };
  }
  return {
    floodZone: attrs.FLD_ZONE ?? null,
    zoneSubtype: attrs.ZONE_SUBTY ?? null,
    highRisk: isHighRisk(attrs.FLD_ZONE),
    riskLevel: classifyRisk(attrs.FLD_ZONE, attrs.ZONE_SUBTY),
    inMappedArea: true,
  };
}
