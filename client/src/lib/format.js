// Pure presentation helpers, kept out of App.vue so they can be unit-tested
// without mounting the component (which would pull in MapLibre).

export function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—';
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

// AQI → severity class used for the badge colour.
export function aqiClass(aqi) {
  if (aqi == null) return 'muted';
  if (aqi <= 50) return 'ok';
  if (aqi <= 100) return 'warn';
  return 'danger';
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
