// Thin client for the Public Risk Radar API. Calls are proxied to :3001 in dev.

async function getJson(path) {
  const res = await fetch(path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export function searchAddress(address) {
  return getJson(`/api/search?address=${encodeURIComponent(address)}`);
}

export function getHistory() {
  return getJson("/api/history");
}

// Persisted risk events near a point, filtered with PostGIS (cumulative across
// every past search — not just the current report's live timeline).
export function getEvents(lat, lon, radiusMiles = 50) {
  return getJson(`/api/events?lat=${lat}&lon=${lon}&radius=${radiusMiles}`);
}

export function getWildfires(lat, lon, radiusMiles = 25) {
  return getJson(`/api/wildfires?lat=${lat}&lon=${lon}&radius=${radiusMiles}`);
}
