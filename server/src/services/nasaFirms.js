import { fetchText } from '../lib/httpClient.js';
import { haversineMiles } from '../lib/geo.js';
import { config } from '../config.js';

// NASA FIRMS Area API — active fire / thermal anomalies (satellite). Free MAP_KEY.
// https://firms.modaps.eosdis.nasa.gov/api/area/
const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const SOURCE = 'VIIRS_SNPP_NRT'; // 375 m near-real-time; good default
const DAY_RANGE = 2; // days back (1–5)

// FIRMS bbox order is west,south,east,north (≈ radiusKm box around the point).
function bbox(lat, lon, radiusKm = 75) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(4)).join(',');
}

// Tiny CSV parser keyed by the header row — sensor columns vary, so never parse
// by fixed position. A bad key / error returns a non-CSV body; if the first line
// isn't a header containing latitude+longitude, treat it as empty.
function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (!lines.length || !/latitude.*longitude/i.test(lines[0])) return [];
  const cols = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const v = line.split(',');
    const row = {};
    cols.forEach((c, i) => (row[c] = v[i]));
    return row;
  });
}

/**
 * Active fire detections near a point. Degrades gracefully with no key
 * (returns { configured: false, fires: [] }) so the rest of the search works.
 */
export async function getActiveFires(lat, lon, { radiusKm = 75, limit = 200 } = {}) {
  if (!config.firmsMapKey) return { configured: false, fires: [] };
  const url = `${BASE}/${config.firmsMapKey}/${SOURCE}/${bbox(lat, lon, radiusKm)}/${DAY_RANGE}`;
  // Hard 30-min cache: FIRMS has a 5000-transaction/10-min cap.
  const text = await fetchText(url, { cacheTtlMs: 30 * 60 * 1000 });
  const fires = parseCsv(text)
    .map((r) => ({
      lat: Number(r.latitude),
      lon: Number(r.longitude),
      confidence: r.confidence, // VIIRS l/n/h or MODIS 0–100
      frp: r.frp != null && r.frp !== '' ? Number(r.frp) : null, // fire radiative power, MW
      // acq_time is HHMM (UTC) → build a best-effort ISO timestamp.
      acquired: r.acq_date
        ? `${r.acq_date}T${String(r.acq_time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z`
        : null,
      daynight: r.daynight,
      satellite: r.satellite,
      distanceMiles: haversineMiles(lat, lon, Number(r.latitude), Number(r.longitude)),
    }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit); // fire season can return thousands → cap for map perf
  return { configured: true, fires };
}
