import { geocodeAddress } from "./geocode.js";
import { getActiveAlerts, getPoint } from "./nws.js";
import { getCurrentAqi } from "./airnow.js";
import { getDisasterHistory, splitCountyGeoid } from "./fema.js";
import { getFloodZone } from "./femaNfhl.js";
import { getNearbyWildfires } from "./nifc.js";
import { getNearbyGauges } from "./usgsWater.js";
import { getRecentQuakes } from "./usgsQuake.js";
import { getNearbyFacilities } from "./epaEcho.js";
import { getActiveFires } from "./nasaFirms.js";
import { getNaturalEvents } from "./nasaEonet.js";

// Resolve a settled promise into a uniform { ok, data, error } shape so a single
// failing upstream source never breaks the whole response.
// (exported for tests)
export function settle(result) {
  if (result.status === "fulfilled") return { ok: true, data: result.value };
  return { ok: false, error: String(result.reason?.message || result.reason) };
}

// Bound each upstream call so one slow source degrades instead of stalling the report.
// Set high enough for data-heavy sources like EPA paging and USGS gauges.
const SOURCE_DEADLINE_MS = 8000;
// (exported for tests)
export function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Full risk report for an address: geocode, then fan out to every source.
 */
export async function buildRiskReport(address) {
  const location = await geocodeAddress(address);
  if (!location) {
    return { ok: false, error: "Address could not be geocoded." };
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
    activeFires,
    naturalEvents,
  ] = await Promise.allSettled([
    withDeadline(
      getActiveAlerts(lat, lon),
      SOURCE_DEADLINE_MS,
      "weatherAlerts",
    ),
    withDeadline(getPoint(lat, lon), SOURCE_DEADLINE_MS, "weatherPoint"),
    withDeadline(getCurrentAqi(lat, lon), SOURCE_DEADLINE_MS, "airQuality"),
    withDeadline(
      countyParts
        ? getDisasterHistory(countyParts.stateFips, countyParts.countyFips)
        : Promise.resolve([]),
      SOURCE_DEADLINE_MS,
      "disasterHistory",
    ),
    withDeadline(getFloodZone(lat, lon), SOURCE_DEADLINE_MS, "floodZone"),
    withDeadline(getNearbyWildfires(lat, lon), SOURCE_DEADLINE_MS, "wildfires"),
    withDeadline(getNearbyGauges(lat, lon), SOURCE_DEADLINE_MS, "waterGauges"),
    withDeadline(getRecentQuakes(lat, lon), SOURCE_DEADLINE_MS, "earthquakes"),
    withDeadline(
      getNearbyFacilities(lat, lon),
      SOURCE_DEADLINE_MS,
      "epaFacilities",
    ),
    withDeadline(getActiveFires(lat, lon), SOURCE_DEADLINE_MS, "activeFires"),
    withDeadline(
      getNaturalEvents(lat, lon),
      SOURCE_DEADLINE_MS,
      "naturalEvents",
    ),
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
      activeFires: settle(activeFires),
      naturalEvents: settle(naturalEvents),
    },
    timeline: buildTimeline({
      alerts,
      disasters,
      wildfires,
      quakes,
      naturalEvents,
    }),
    generatedAt: new Date().toISOString(),
  };
}

// Merge time-stamped events from several sources into one sorted list.
// (exported for tests)
export function buildTimeline({
  alerts,
  disasters,
  wildfires,
  quakes,
  naturalEvents = { status: "rejected" },
}) {
  const events = [];

  if (alerts.status === "fulfilled") {
    for (const a of alerts.value) {
      events.push({
        type: "weather",
        source: "nws",
        title: a.event,
        severity: a.severity,
        time: a.onset || a.expires,
      });
    }
  }
  if (disasters.status === "fulfilled") {
    for (const d of disasters.value) {
      events.push({
        type: "disaster",
        source: "fema",
        title: `${d.incidentType}: ${d.title}`,
        time: d.declarationDate,
      });
    }
  }
  if (wildfires.status === "fulfilled") {
    for (const w of wildfires.value) {
      events.push({
        type: "fire",
        source: "nifc",
        title: `Wildfire: ${w.name}`,
        time: w.discovered,
        // Carry coords so the timeline row can fly the map there. Fires/quakes
        // have a point; alerts (zones) and disasters (county) don't.
        lat: w.lat ?? null,
        lon: w.lon ?? null,
      });
    }
  }
  if (quakes.status === "fulfilled") {
    for (const q of quakes.value) {
      events.push({
        type: "quake",
        source: "usgs_quake",
        title: `M${q.magnitude} — ${q.place}`,
        time: q.time,
        lat: q.lat ?? null,
        lon: q.lon ?? null,
      });
    }
  }
  if (naturalEvents.status === "fulfilled") {
    for (const n of naturalEvents.value) {
      events.push({
        type: "natural",
        source: "eonet",
        title: `${n.category}: ${n.title}`,
        time: n.time,
        lat: n.lat ?? null,
        lon: n.lon ?? null,
      });
    }
  }

  return events
    .filter((e) => e.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}
