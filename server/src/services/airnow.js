import { fetchJson } from '../lib/httpClient.js';
import { config } from '../config.js';

// AirNow current observations by lat/lon. Requires a free API key.
// https://docs.airnowapi.org/
const BASE = 'https://www.airnowapi.org/aq/observation/latLong/current';

/**
 * Current AQI observations near a point (typically O3 and PM2.5).
 * Returns [] if no key is configured so the rest of the search still works.
 */
export async function getCurrentAqi(lat, lon, distanceMiles = 25) {
  if (!config.airnowApiKey) {
    return { configured: false, observations: [] };
  }
  const url =
    `${BASE}/?format=application/json&latitude=${lat}&longitude=${lon}` +
    `&distance=${distanceMiles}&API_KEY=${config.airnowApiKey}`;

  const data = await fetchJson(url, { cacheTtlMs: 10 * 60 * 1000 });
  const observations = (data ?? []).map((o) => ({
    parameter: o.ParameterName,
    aqi: o.AQI,
    category: o.Category?.Name,
    reportingArea: o.ReportingArea,
    stateCode: o.StateCode,
    observedAt: `${o.DateObserved?.trim()}T${String(o.HourObserved).padStart(2, '0')}:00:00`,
    lat: o.Latitude,
    lon: o.Longitude,
  }));
  return { configured: true, observations };
}
