// Pure presentation helpers, kept out of App.vue so they can be unit-tested
// without mounting the component (which would pull in MapLibre).

// Date-only values (e.g. FEMA declarationDate "2024-06-28T00:00:00.000Z") are
// stamped at UTC midnight — they must be rendered in UTC so they don't slip back
// a day in western timezones. Real timestamps keep local rendering.
function isDateOnly(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) || /T00:00:00(\.000)?Z?$/.test(d);
}

export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', isDateOnly(d) ? { timeZone: 'UTC' } : undefined);
}

// Readable "Jun 28, 2024" — used where a longer list reads better than slashes.
export function fmtMonthDayYear(d) {
  if (!d) return '—';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  if (isDateOnly(d)) opts.timeZone = 'UTC';
  return new Date(d).toLocaleDateString('en-US', opts);
}

// ALL-CAPS source text → readable Title Case ("BOULDER VIEW FIRE" → "Boulder
// View Fire"), keeping connector words lowercase (except the first word).
const TITLE_SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'to', 'in', 'for', 'on', 'at', 'by']);
export function titleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && TITLE_SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Short "x ago" label for a timestamp.
export function fmtRelative(d, now = Date.now()) {
  if (!d) return '';
  const secs = Math.round((now - new Date(d)) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// NWS alert severity → badge colour. Unknown/null is informational, not severe,
// so it gets neutral grey rather than red.
export function severityClass(severity) {
  switch ((severity || '').toLowerCase()) {
    case 'extreme':
    case 'severe':   return 'danger';
    case 'moderate': return 'warn';
    case 'minor':    return 'ok';
    default:         return 'muted';
  }
}

// The worst (highest-AQI) observation, or null if there are none.
export function topObservation(observations) {
  if (!observations?.length) return null;
  return observations.reduce((a, b) => (b.aqi > a.aqi ? b : a));
}

// Collapse repeated searches of the same address to the most recent few.
// `locations` is assumed newest-first (as /api/history returns it).
export function dedupeRecentSearches(locations, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const loc of locations ?? []) {
    if (seen.has(loc.address)) continue;
    seen.add(loc.address);
    out.push(loc);
    if (out.length >= limit) break;
  }
  return out;
}

// USGS returns one entry per (site × parameter) — a single gauge reporting both
// discharge and gage height shows up as two rows. Collapse to one entry per
// physical site (capped at `limit` distinct sites), keeping every reading.
export function groupGaugesBySite(gauges, limit = 6) {
  const bySite = new Map();
  for (const g of gauges ?? []) {
    if (!bySite.has(g.siteId)) {
      if (bySite.size >= limit) continue; // already have `limit` distinct sites
      // Keep lat/lon so the card row can fly the map to the gauge.
      bySite.set(g.siteId, { siteId: g.siteId, name: g.name, lat: g.lat, lon: g.lon, readings: [] });
    }
    bySite.get(g.siteId).readings.push({ parameter: g.parameter, value: g.value });
  }
  return [...bySite.values()];
}

// Count disaster declarations by incidentType over the FULL history (not a
// date-sorted slice), so a recent run of one type — e.g. several fire years —
// doesn't hide the county's real risk mix (older floods, storms, etc.).
// Returns { total, byType: [{ type, count }] } sorted by count desc.
export function summarizeDisasterTypes(declarations) {
  const counts = new Map();
  for (const d of declarations ?? []) {
    counts.set(d.incidentType, (counts.get(d.incidentType) ?? 0) + 1);
  }
  const byType = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  return { total: declarations?.length ?? 0, byType };
}

// FEMA incidentType → a dot colour, tuned for the dark theme. Covers the common
// types; anything else falls back to neutral grey.
const DISASTER_COLORS = {
  Fire: '#f2994a',
  Flood: '#4f9dff',
  'Severe Storm': '#a55eea',
  Hurricane: '#2dd4bf',
  Biological: '#4fd18b',
  Tornado: '#ff5d5d',
  Earthquake: '#b9744f',
  Drought: '#e0b341',
  'Coastal Storm': '#56b4d3',
  Snowstorm: '#9fb4d8',
  'Severe Ice Storm': '#9fb4d8',
  'Winter Storm': '#9fb4d8',
};
export function disasterColor(type) {
  return DISASTER_COLORS[type] ?? '#9aa3b2';
}

// EPA AQI categories — the official 6-band scale, colors tuned to read on the
// dark theme. `seg` is the contiguous positioning range (so the ribbon marker
// lands correctly); `name` and `guidance` are what the reader sees.
export const AQI_BANDS = [
  { key: 'good', name: 'Good', color: '#4fd18b', seg: [0, 50],
    guidance: 'Air quality is good — a fine day to be active outside.' },
  { key: 'moderate', name: 'Moderate', color: '#f2c94c', seg: [50, 100],
    guidance: 'Acceptable, but unusually sensitive people should ease up on long outdoor exertion.' },
  { key: 'usg', name: 'Unhealthy for Sensitive Groups', color: '#f2994a', seg: [100, 150],
    guidance: 'Sensitive groups — heart or lung conditions, kids, older adults — should limit prolonged outdoor exertion.' },
  { key: 'unhealthy', name: 'Unhealthy', color: '#ff5d5d', seg: [150, 200],
    guidance: 'Everyone may feel effects; sensitive groups should avoid prolonged outdoor exertion.' },
  { key: 'veryunhealthy', name: 'Very Unhealthy', color: '#a55eea', seg: [200, 300],
    guidance: 'Health alert — everyone should limit time and exertion outdoors.' },
  { key: 'hazardous', name: 'Hazardous', color: '#b33771', seg: [300, 500],
    guidance: 'Emergency conditions — stay indoors and keep activity low.' },
];

// FEMA flood risk tiers → plain-language label, a tone (reuses the badge colour
// classes), and guidance. Keyed by the service's `riskLevel`. Copy speaks to what
// the reader can act on (insurance), not zone codes.
export const FLOOD_RISK = {
  high: {
    label: 'High flood risk',
    tone: 'danger',
    blurb: 'In a Special Flood Hazard Area — the 1% annual-chance (100-year) floodplain. Flood insurance is required with a federally backed mortgage.',
  },
  moderate: {
    label: 'Moderate flood risk',
    tone: 'warn',
    blurb: 'In the 0.2% annual-chance (500-year) floodplain. Flooding is uncommon here but possible — flood insurance isn’t required, but is worth considering.',
  },
  minimal: {
    label: 'Minimal flood risk',
    tone: 'ok',
    blurb: 'Outside the mapped 1% and 0.2% annual-chance floodplains. Risk is low, though never truly zero.',
  },
  undetermined: {
    label: 'Risk undetermined',
    tone: 'muted',
    blurb: 'FEMA has not assessed the flood hazard at this location (Zone D).',
  },
};

// Locate an AQI value on the 6-band scale: returns its band and where a marker
// sits (0–100%) across an equal-width ribbon, clamped at the ends.
export function aqiScale(aqi) {
  if (aqi == null || Number.isNaN(Number(aqi))) return null;
  const n = AQI_BANDS.length;
  for (let i = 0; i < n; i++) {
    const [lo, hi] = AQI_BANDS[i].seg;
    if (aqi < hi || i === n - 1) {
      const frac = Math.min(Math.max((aqi - lo) / (hi - lo), 0), 1);
      return { band: AQI_BANDS[i], markerPct: ((i + frac) / n) * 100 };
    }
  }
  return null;
}
