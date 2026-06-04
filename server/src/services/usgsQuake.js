import { fetchJson } from '../lib/httpClient.js';

// USGS Earthquake Catalog (FDSN event service). No key.
// https://earthquake.usgs.gov/fdsnws/event/1/
const BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/**
 * Recent earthquakes within `radiusKm` of a point over the last `days`.
 */
export async function getRecentQuakes(lat, lon, radiusKm = 150, days = 365) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const params = new URLSearchParams({
    format: 'geojson',
    latitude: String(lat),
    longitude: String(lon),
    maxradiuskm: String(radiusKm),
    starttime: start,
    orderby: 'time',
  });
  const data = await fetchJson(`${BASE}?${params}`, { cacheTtlMs: 30 * 60 * 1000 });

  return (data?.features ?? []).map((f) => ({
    id: f.id,
    magnitude: f.properties.mag,
    place: f.properties.place,
    time: f.properties.time ? new Date(f.properties.time).toISOString() : null,
    lon: f.geometry?.coordinates?.[0] ?? null,
    lat: f.geometry?.coordinates?.[1] ?? null,
    depthKm: f.geometry?.coordinates?.[2] ?? null,
    url: f.properties.url,
  }));
}
