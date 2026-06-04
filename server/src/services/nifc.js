import { fetchJson } from '../lib/httpClient.js';

// NIFC / WFIGS current wildfire incident locations — ArcGIS FeatureServer. No key.
// https://data-nifc.opendata.arcgis.com/
const LAYER =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Incident_Locations_Current/FeatureServer/0/query';

/**
 * Active wildfire incidents within `radiusMiles` of a point.
 */
export async function getNearbyWildfires(lat, lon, radiusMiles = 25) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    distance: String(radiusMiles),
    units: 'esriSRUnit_StatuteMile',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'IncidentName,FireCause,DailyAcres,PercentContained,FireDiscoveryDateTime,POOState',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });
  const data = await fetchJson(`${LAYER}?${params}`, { cacheTtlMs: 15 * 60 * 1000 });

  return (data?.features ?? []).map((f) => ({
    name: f.attributes.IncidentName,
    cause: f.attributes.FireCause,
    acres: f.attributes.DailyAcres,
    percentContained: f.attributes.PercentContained,
    discovered: f.attributes.FireDiscoveryDateTime
      ? new Date(f.attributes.FireDiscoveryDateTime).toISOString()
      : null,
    state: f.attributes.POOState,
    lat: f.geometry?.y ?? null,
    lon: f.geometry?.x ?? null,
  }));
}
