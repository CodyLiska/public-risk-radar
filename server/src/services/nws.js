import { fetchJson } from '../lib/httpClient.js';
import { config } from '../config.js';

// National Weather Service API — no key, but requires a descriptive User-Agent.
// https://www.weather.gov/documentation/services-web-api
const BASE = 'https://api.weather.gov';

function headers() {
  return { 'User-Agent': config.nwsUserAgent };
}

/** Active weather alerts for a point. */
export async function getActiveAlerts(lat, lon) {
  const url = `${BASE}/alerts/active?point=${lat},${lon}`;
  const data = await fetchJson(url, { headers: headers(), cacheTtlMs: 60 * 1000 });
  return (data?.features ?? []).map((f) => ({
    id: f.id,
    event: f.properties.event,
    severity: f.properties.severity,
    certainty: f.properties.certainty,
    urgency: f.properties.urgency,
    headline: f.properties.headline,
    description: f.properties.description,
    onset: f.properties.onset,
    expires: f.properties.expires,
    areaDesc: f.properties.areaDesc,
  }));
}

/** Point metadata (forecast office, zone, gridpoint). Useful for forecast linkouts. */
export async function getPoint(lat, lon) {
  const url = `${BASE}/points/${lat},${lon}`;
  const data = await fetchJson(url, { headers: headers(), cacheTtlMs: 12 * 60 * 60 * 1000 });
  const p = data?.properties;
  if (!p) return null;
  return {
    forecastUrl: p.forecast,
    forecastZone: p.forecastZone,
    county: p.county,
    timeZone: p.timeZone,
    radarStation: p.radarStation,
  };
}
