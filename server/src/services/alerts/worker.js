import { config } from '../../config.js';
import { query } from '../../db.js';
import { evaluateThreshold } from './evaluate.js';
import { deliver } from './notify.js';
import { getCurrentAqi } from '../airnow.js';
import { getActiveAlerts } from '../nws.js';
import { getFloodZone } from '../femaNfhl.js';
import { getNearbyWildfires } from '../nifc.js';
import { getRecentQuakes } from '../usgsQuake.js';
import { getNearbyGauges } from '../usgsWater.js';

// Map an event type to the single upstream source the threshold needs. Each call
// hits httpClient/Redis, so repeated subscriptions on the same source/location are
// already cheap (cached) without extra grouping logic.
const SOURCE_FETCHERS = {
  aqi: (lat, lon) => getCurrentAqi(lat, lon),
  weather_alert: (lat, lon) => getActiveAlerts(lat, lon),
  flood: (lat, lon) => getFloodZone(lat, lon),
  wildfire: (lat, lon) => getNearbyWildfires(lat, lon),
  earthquake: (lat, lon) => getRecentQuakes(lat, lon),
  water_gauge: (lat, lon) => getNearbyGauges(lat, lon),
};

export function fetchForEventType(eventType, lat, lon) {
  const fn = SOURCE_FETCHERS[eventType];
  if (!fn) throw new Error(`no source fetcher for event_type: ${eventType}`);
  return fn(lat, lon);
}

// Edge-trigger: fire on a fresh cross, and again only if the reading escalates past
// what we last notified (higher number, or a changed categorical value). While the
// reading holds steady we stay quiet; once it drops below threshold last_state is
// reset elsewhere so the next cross fires again.
export function shouldFire(lastState, value) {
  if (!lastState || lastState.value == null) return true;
  if (typeof value === 'number' && typeof lastState.value === 'number') {
    return value > lastState.value;
  }
  return value !== lastState.value;
}

/**
 * Evaluate every active subscription once. All side effects go through injected
 * deps so this is unit-testable with no network or DB. A failure on one
 * subscription is logged and skipped — it never stops the loop.
 */
export async function runOnce({ loadActiveSubscriptions, fetchSource, deliver: deliverFn, markFired, reset, log = () => {} }) {
  const subs = await loadActiveSubscriptions();
  let fired = 0;
  for (const sub of subs) {
    try {
      const data = await fetchSource(sub);
      // Give radius-based thresholds (wildfire withinMiles) the subscription origin.
      const threshold = { ...(sub.threshold || {}), lat: sub.lat, lon: sub.lon };
      const { crossed, value, message } = evaluateThreshold(sub.event_type, threshold, data);
      if (crossed) {
        if (shouldFire(sub.last_state, value)) {
          await deliverFn(sub, message);
          await markFired(sub.id, value);
          fired += 1;
        }
      } else if (sub.last_state != null) {
        await reset(sub.id); // re-arm so the next cross fires
      }
    } catch (err) {
      log(`[alerts] subscription ${sub.id} failed: ${err.message}`);
    }
  }
  return { evaluated: subs.length, fired };
}

// ── Real (DB/network-backed) dependencies ────────────────────────────────────
const dbDeps = {
  async loadActiveSubscriptions() {
    const { rows } = await query(
      `SELECT s.id, s.event_type, s.threshold, s.delivery_method, s.delivery_target,
              s.last_state, l.lat, l.lon
         FROM alert_subscriptions s
         JOIN locations l ON l.id = s.location_id
        WHERE s.active`,
    );
    return rows;
  },
  fetchSource(sub) {
    return fetchForEventType(sub.event_type, sub.lat, sub.lon);
  },
  deliver,
  async markFired(id, value) {
    await query(
      `UPDATE alert_subscriptions SET last_fired_at = now(), last_state = $2 WHERE id = $1`,
      [id, JSON.stringify({ value })],
    );
  },
  async reset(id) {
    await query(`UPDATE alert_subscriptions SET last_state = NULL WHERE id = $1`, [id]);
  },
  log: (msg) => console.warn(msg),
};

let timer = null;

/** Start the background interval worker. Runs once immediately, then on a timer. */
export function startAlertWorker(deps = dbDeps, intervalMs = config.alertsIntervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return; // don't overlap if a tick runs long
    running = true;
    try {
      const { evaluated, fired } = await runOnce(deps);
      if (fired) console.log(`[alerts] tick: ${fired} fired / ${evaluated} evaluated`);
    } catch (err) {
      console.warn(`[alerts] tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref(); // don't keep the process alive for the timer alone
  return () => { if (timer) clearInterval(timer); timer = null; };
}
