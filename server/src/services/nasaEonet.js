import { fetchJson } from '../lib/httpClient.js';

// NASA EONET v3 — Earth Observatory Natural Event Tracker (fires, storms,
// volcanoes, ice…). JSON, no key. https://eonet.gsfc.nasa.gov/docs/v3
const BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';

// EONET bbox order is W,N,E,S (upper-left lon,lat then lower-right lon,lat).
// NOTE: this is NOT the same order as FIRMS (W,S,E,N).
function bbox(lat, lon, radiusKm = 200) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat + dLat, lon + dLon, lat - dLat].join(',');
}

// geometry is an array (an event can move) — use the last entry. Coordinates are
// GeoJSON [lon, lat]. Polygon → first ring's first vertex (good enough for a marker).
function point(geometry) {
  const g = geometry?.[geometry.length - 1];
  if (!g) return [null, null];
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates?.[0]?.[0] ?? [null, null];
  return [null, null];
}

/** Open natural events near a point. Returns an array. */
export async function getNaturalEvents(lat, lon, { radiusKm = 200, days = 30 } = {}) {
  const params = new URLSearchParams({
    status: 'open',
    days: String(days),
    limit: '50',
    bbox: bbox(lat, lon, radiusKm),
  });
  const data = await fetchJson(`${BASE}?${params}`, { cacheTtlMs: 30 * 60 * 1000 });
  return (data?.events ?? [])
    .map((e) => {
      const [lon2, lat2] = point(e.geometry);
      const last = e.geometry?.[e.geometry.length - 1];
      return {
        id: e.id,
        title: e.title,
        category: e.categories?.[0]?.title ?? 'Event',
        time: last?.date ?? null,
        link: e.link ?? e.sources?.[0]?.url ?? null,
        lat: lat2,
        lon: lon2,
      };
    })
    .filter((e) => e.lat != null && e.lon != null);
}
