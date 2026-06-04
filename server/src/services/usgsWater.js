import { fetchJson } from '../lib/httpClient.js';

// USGS Water Services — instantaneous values (IV). No key.
// https://waterservices.usgs.gov/
const BASE = 'https://waterservices.usgs.gov/nwis/iv/';

// Parameter codes: 00060 = discharge (cfs), 00065 = gage height (ft).
const PARAM_NAMES = { '00060': 'Discharge (cfs)', '00065': 'Gage height (ft)' };

/** Build a small bounding box (degrees) around a point for the bBox query. */
function bbox(lat, lon, radiusMiles) {
  const dLat = radiusMiles / 69; // ~69 miles per degree latitude
  const dLon = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180));
  const west = (lon - dLon).toFixed(6);
  const south = (lat - dLat).toFixed(6);
  const east = (lon + dLon).toFixed(6);
  const north = (lat + dLat).toFixed(6);
  return `${west},${south},${east},${north}`;
}

/**
 * Nearby stream gauges with their latest reading.
 */
export async function getNearbyGauges(lat, lon, radiusMiles = 20) {
  const params = new URLSearchParams({
    format: 'json',
    bBox: bbox(lat, lon, radiusMiles),
    parameterCd: '00060,00065',
    siteStatus: 'active',
  });
  const data = await fetchJson(`${BASE}?${params}`, { cacheTtlMs: 15 * 60 * 1000 });

  const series = data?.value?.timeSeries ?? [];
  return series.map((ts) => {
    const site = ts.sourceInfo;
    const latest = ts.values?.[0]?.value?.[0];
    const code = ts.variable?.variableCode?.[0]?.value;
    return {
      siteId: site.siteCode?.[0]?.value,
      name: site.siteName,
      lat: site.geoLocation?.geogLocation?.latitude,
      lon: site.geoLocation?.geogLocation?.longitude,
      parameter: PARAM_NAMES[code] || ts.variable?.variableName,
      value: latest ? Number(latest.value) : null,
      observedAt: latest?.dateTime ?? null,
    };
  });
}
