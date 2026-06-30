import { Router } from "express";
import { query } from "../db.js";
import { geocodeAddress } from "../services/geocode.js";
import { EVENT_TYPES } from "../services/alerts/evaluate.js";

export const subscriptionsRouter = Router();

const SEVERITY_VOCAB = ["minor", "moderate", "severe", "extreme"];

// Validate a threshold for its event type. Returns an error string, or null if ok.
export function validateThreshold(eventType, threshold) {
  if (threshold == null || typeof threshold !== "object") {
    return "threshold must be an object";
  }
  if (threshold.type != null && threshold.type !== eventType) {
    return `threshold.type "${threshold.type}" does not match event_type "${eventType}"`;
  }
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  switch (eventType) {
    case "aqi":
      return num(threshold.gt) ? null : 'aqi threshold needs a numeric "gt"';
    case "earthquake":
      return num(threshold.minMagnitude)
        ? null
        : 'earthquake threshold needs a numeric "minMagnitude"';
    case "wildfire":
      return threshold.withinMiles == null || num(threshold.withinMiles)
        ? null
        : 'wildfire "withinMiles" must be a number when present';
    case "weather_alert":
      return SEVERITY_VOCAB.includes(
        String(threshold.severityAtLeast || "").toLowerCase(),
      )
        ? null
        : `weather_alert "severityAtLeast" must be one of ${SEVERITY_VOCAB.join("/")}`;
    case "water_gauge":
      if (!threshold.siteId) return 'water_gauge threshold needs a "siteId"';
      return num(threshold.gageHeightGt)
        ? null
        : 'water_gauge threshold needs a numeric "gageHeightGt"';
    case "flood":
      return null;
    default:
      return `unsupported event_type: ${eventType}`;
  }
}

// A subscription wants a *stable* location row (not a new history row per call),
// so reuse an existing row at the same point if one exists.
async function findOrCreateLocation({ address, lat, lon }) {
  let loc = {
    lat,
    lon,
    stateFips: null,
    countyFips: null,
    tract: null,
    address,
  };
  if (address) {
    const geo = await geocodeAddress(address);
    if (!geo) return null;
    loc = { ...geo, address };
  }
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;

  const existing = await query(
    `SELECT id FROM locations
      WHERE round(lat::numeric, 5) = round($1::numeric, 5)
        AND round(lon::numeric, 5) = round($2::numeric, 5)
      ORDER BY created_at DESC LIMIT 1`,
    [loc.lat, loc.lon],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const { rows } = await query(
    `INSERT INTO locations (address, lat, lon, geom, state_fips, county_fips, census_tract)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6)
     RETURNING id`,
    [
      loc.address || null,
      loc.lat,
      loc.lon,
      loc.stateFips ?? null,
      loc.countyFips ?? null,
      loc.tract ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

subscriptionsRouter.post("/", async (req, res) => {
  const {
    address,
    lat,
    lon,
    event_type,
    threshold,
    delivery_method,
    delivery_target,
  } = req.body || {};

  if (!EVENT_TYPES.includes(event_type)) {
    return res
      .status(400)
      .json({ error: `event_type must be one of ${EVENT_TYPES.join(", ")}` });
  }
  const tErr = validateThreshold(event_type, threshold);
  if (tErr) return res.status(400).json({ error: tErr });

  if (delivery_method !== "discord") {
    return res.status(400).json({ error: 'delivery_method must be "discord"' });
  }
  if (!delivery_target) {
    return res
      .status(400)
      .json({ error: "delivery_target (Discord webhook URL) is required" });
  }
  if (
    !address &&
    !(Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)))
  ) {
    return res
      .status(400)
      .json({ error: "provide an address or numeric lat/lon" });
  }

  try {
    const locationId = await findOrCreateLocation({
      address: address ? String(address).trim() : null,
      lat: Number(lat),
      lon: Number(lon),
    });
    if (!locationId)
      return res.status(404).json({ error: "location could not be resolved" });

    const { rows } = await query(
      `INSERT INTO alert_subscriptions
         (location_id, event_type, threshold, delivery_method, delivery_target)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, location_id, event_type, threshold, delivery_method, active, created_at`,
      [
        locationId,
        event_type,
        JSON.stringify(threshold),
        delivery_method,
        delivery_target,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res
      .status(503)
      .json({
        error: String(err.message || err),
        hint: "is the database running?",
      });
  }
});

subscriptionsRouter.get("/", async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.location_id, s.event_type, s.threshold, s.delivery_method,
              s.active, s.last_fired_at, s.created_at, l.address, l.lat, l.lon
         FROM alert_subscriptions s
         JOIN locations l ON l.id = s.location_id
        ORDER BY s.created_at DESC LIMIT 200`,
    );
    res.json({ count: rows.length, subscriptions: rows });
  } catch (err) {
    res
      .status(503)
      .json({
        error: String(err.message || err),
        hint: "is the database running?",
      });
  }
});

subscriptionsRouter.patch("/:id", async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== "boolean") {
    return res
      .status(400)
      .json({ error: 'body must include a boolean "active"' });
  }
  try {
    const { rows } = await query(
      `UPDATE alert_subscriptions SET active = $2 WHERE id = $1 RETURNING id, active`,
      [req.params.id, active],
    );
    if (!rows[0])
      return res.status(404).json({ error: "subscription not found" });
    res.json(rows[0]);
  } catch (err) {
    res
      .status(503)
      .json({
        error: String(err.message || err),
        hint: "is the database running?",
      });
  }
});

subscriptionsRouter.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await query(
      "DELETE FROM alert_subscriptions WHERE id = $1",
      [req.params.id],
    );
    if (!rowCount)
      return res.status(404).json({ error: "subscription not found" });
    res.status(204).end();
  } catch (err) {
    res
      .status(503)
      .json({
        error: String(err.message || err),
        hint: "is the database running?",
      });
  }
});
