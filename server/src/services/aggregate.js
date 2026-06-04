import { geocodeAddress } from './geocode.js';
import { getActiveAlerts, getPoint } from './nws.js';
import { getCurrentAqi } from './airnow.js';
import { getDisasterHistory, splitCountyGeoid } from './fema.js';
import { getFloodZone } from './femaNfhl.js';
import { getNearbyWildfires } from './nifc.js';
import { getNearbyGauges } from './usgsWater.js';
import { getRecentQuakes } from './usgsQuake.js';
import { getNearbyFacilities } from './epaEcho.js';

// Resolve a settled promise into a uniform { ok, data, error } shape so a single
// failing upstream source never breaks the whole response.
// (exported for tests)
export function settle(result) {
  if (result.status === 'fulfilled') return { ok: true, data: result.value };
  return { ok: false, error: String(result.reason?.message || result.reason) };
}

/**
 * Full risk report for an address: geocode, then fan out to every source.
 */
export async function buildRiskReport(address) {
  const location = await geocodeAddress(address);
  if (!location) {
    return { ok: false, error: 'Address could not be geocoded.' };
  }
  const { lat, lon } = location;
  const countyParts = splitCountyGeoid(location.countyFips);

  const [
    alerts,
    point,
    aqi,
    disasters,
    flood,
    wildfires,
    gauges,
    quakes,
    facilities,
  ] = await Promise.allSettled([
    getActiveAlerts(lat, lon),
    getPoint(lat, lon),
    getCurrentAqi(lat, lon),
    countyParts
      ? getDisasterHistory(countyParts.stateFips, countyParts.countyFips)
      : Promise.resolve([]),
    getFloodZone(lat, lon),
    getNearbyWildfires(lat, lon),
    getNearbyGauges(lat, lon),
    getRecentQuakes(lat, lon),
    getNearbyFacilities(lat, lon),
  ]);

  return {
    ok: true,
    location,
    sources: {
      weatherAlerts: settle(alerts),
      weatherPoint: settle(point),
      airQuality: settle(aqi),
      disasterHistory: settle(disasters),
      floodZone: settle(flood),
      wildfires: settle(wildfires),
      waterGauges: settle(gauges),
      earthquakes: settle(quakes),
      epaFacilities: settle(facilities),
    },
    timeline: buildTimeline({ alerts, disasters, wildfires, quakes }),
    generatedAt: new Date().toISOString(),
  };
}

// Merge time-stamped events from several sources into one sorted list.
// (exported for tests)
export function buildTimeline({ alerts, disasters, wildfires, quakes }) {
  const events = [];

  if (alerts.status === 'fulfilled') {
    for (const a of alerts.value) {
      events.push({
        type: 'weather',
        source: 'nws',
        title: a.event,
        severity: a.severity,
        time: a.onset || a.expires,
      });
    }
  }
  if (disasters.status === 'fulfilled') {
    for (const d of disasters.value) {
      events.push({
        type: 'disaster',
        source: 'fema',
        title: `${d.incidentType}: ${d.title}`,
        time: d.declarationDate,
      });
    }
  }
  if (wildfires.status === 'fulfilled') {
    for (const w of wildfires.value) {
      events.push({
        type: 'fire',
        source: 'nifc',
        title: `Wildfire: ${w.name}`,
        time: w.discovered,
      });
    }
  }
  if (quakes.status === 'fulfilled') {
    for (const q of quakes.value) {
      events.push({
        type: 'quake',
        source: 'usgs_quake',
        title: `M${q.magnitude} — ${q.place}`,
        time: q.time,
      });
    }
  }

  return events
    .filter((e) => e.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}
