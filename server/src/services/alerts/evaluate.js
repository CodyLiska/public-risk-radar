// Pure threshold evaluation for alert subscriptions.
//
// evaluateThreshold(eventType, threshold, sourceData) -> { crossed, value, message }
//
// `sourceData` is exactly what the matching services/* function returns (see
// fetchForEventType in worker.js), so these functions stay free of network/DB and
// are fully unit-testable. `value` is the observed reading the worker stores in
// last_state for edge-triggered de-duplication.

// NWS severity vocabulary, low → high. Unknown ranks lowest (informational).
const SEVERITY_RANK = { unknown: 0, minor: 1, moderate: 2, severe: 3, extreme: 4 };
function severityRank(s) {
  return SEVERITY_RANK[String(s || '').toLowerCase()] ?? 0;
}

// Great-circle distance in miles (for radius thresholds where the source doesn't
// already return a distance).
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const notCrossed = { crossed: false, value: null, message: null };

const evaluators = {
  // sourceData: { configured, observations: [{ parameter, aqi, ... }] }
  aqi(threshold, data) {
    const obs = data?.observations ?? [];
    if (!obs.length) return notCrossed;
    const worst = obs.reduce((a, b) => (b.aqi > a.aqi ? b : a));
    const limit = Number(threshold.gt);
    const crossed = worst.aqi != null && worst.aqi > limit;
    return {
      crossed,
      value: worst.aqi,
      message: crossed
        ? `Air quality AQI ${worst.aqi} (${worst.category || 'n/a'}) exceeds ${limit} near ${worst.reportingArea || 'your area'}.`
        : null,
    };
  },

  // sourceData: [{ event, severity, ... }]
  weather_alert(threshold, data) {
    const alerts = data ?? [];
    if (!alerts.length) return notCrossed;
    const min = severityRank(threshold.severityAtLeast);
    const worst = alerts.reduce((a, b) => (severityRank(b.severity) > severityRank(a.severity) ? b : a));
    const crossed = severityRank(worst.severity) >= min;
    return {
      crossed,
      value: worst.severity,
      message: crossed
        ? `Weather alert: ${worst.event} (severity ${worst.severity}).`
        : null,
    };
  },

  // sourceData: { floodZone, highRisk, inMappedArea }
  flood(_threshold, data) {
    const crossed = !!data?.highRisk;
    return {
      crossed,
      value: data?.floodZone ?? null,
      message: crossed
        ? `Location is in a high-risk flood zone (${data.floodZone}).`
        : null,
    };
  },

  // sourceData: [{ name, lat, lon, ... }] — the source already filters by radius,
  // but withinMiles can tighten it further (needs origin lat/lon on the threshold).
  wildfire(threshold, data) {
    let fires = data ?? [];
    if (threshold.withinMiles != null && threshold.lat != null && threshold.lon != null) {
      fires = fires.filter(
        (f) =>
          f.lat != null &&
          f.lon != null &&
          distanceMiles(threshold.lat, threshold.lon, f.lat, f.lon) <= threshold.withinMiles,
      );
    }
    const crossed = fires.length > 0;
    return {
      crossed,
      value: fires.length,
      message: crossed
        ? `${fires.length} active wildfire(s) nearby, including ${fires[0].name}.`
        : null,
    };
  },

  // sourceData: [{ magnitude, place, ... }]
  earthquake(threshold, data) {
    const quakes = data ?? [];
    if (!quakes.length) return notCrossed;
    const min = Number(threshold.minMagnitude);
    const strongest = quakes.reduce((a, b) => ((b.magnitude ?? -Infinity) > (a.magnitude ?? -Infinity) ? b : a));
    const crossed = strongest.magnitude != null && strongest.magnitude >= min;
    return {
      crossed,
      value: strongest.magnitude,
      message: crossed
        ? `Earthquake M${strongest.magnitude} — ${strongest.place}.`
        : null,
    };
  },

  // sourceData: [{ siteId, name, parameter, value, ... }]
  water_gauge(threshold, data) {
    const gauges = data ?? [];
    const gauge = gauges.find(
      (g) => g.siteId === threshold.siteId && /gage height/i.test(g.parameter || ''),
    );
    if (!gauge || gauge.value == null) return notCrossed;
    const limit = Number(threshold.gageHeightGt);
    const crossed = gauge.value > limit;
    return {
      crossed,
      value: gauge.value,
      message: crossed
        ? `Gage height ${gauge.value} ft at ${gauge.name} exceeds ${limit} ft.`
        : null,
    };
  },
};

export const EVENT_TYPES = Object.keys(evaluators);

export function evaluateThreshold(eventType, threshold, sourceData) {
  const fn = evaluators[eventType];
  if (!fn) throw new Error(`unknown event_type: ${eventType}`);
  return fn(threshold || {}, sourceData);
}
