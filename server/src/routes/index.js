import { Router } from 'express';
import { buildRiskReport } from '../services/aggregate.js';
import { geocodeAddress } from '../services/geocode.js';
import { getNearbyWildfires } from '../services/nifc.js';
import { persistReport } from '../services/persist.js';
import { ping, query } from '../db.js';
import { subscriptionsRouter } from './subscriptions.js';

export const router = Router();

// Alert subscriptions CRUD.
router.use('/subscriptions', subscriptionsRouter);

router.get('/health', async (_req, res) => {
  let db = false;
  try {
    db = await ping();
  } catch {
    db = false;
  }
  res.json({ status: 'ok', db, time: new Date().toISOString() });
});

// Geocode only — handy for the search box to confirm an address resolves.
router.get('/geocode', async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address query param is required' });
  try {
    const result = await geocodeAddress(address);
    if (!result) return res.status(404).json({ error: 'no match' });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// The main endpoint: full risk report for an address.
router.get('/search', async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address query param is required' });
  let report;
  try {
    report = await buildRiskReport(address);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
  if (!report.ok) return res.status(404).json(report);

  // Send the live report first, then persist — persistence is best-effort and
  // must never block or break the response (a slow/down DB can't stall the user).
  res.json(report);
  persistReport(address, report)
    .then((persisted) => {
      if (persisted.error) console.warn('[persist]', persisted.error);
      for (const [k, v] of Object.entries(persisted.persisted || {})) {
        if (v?.error) console.warn(`[persist:${k}]`, v.error);
      }
    })
    .catch((err) => console.warn('[persist]', String(err.message || err)));
});

// Read-back: recent risk events from the DB near a point (proves persistence).
// Falls back gracefully if the DB is unavailable.
router.get('/events', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusMiles = Number(req.query.radius) || 50;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
    const { rows } = await query(
      `SELECT type, source, source_id, title, severity, start_time, end_time, fetched_at,
              ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon
       FROM risk_events
       ${hasPoint ? 'WHERE geom IS NULL OR ST_DWithin(geom, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)' : ''}
       ORDER BY start_time DESC NULLS LAST
       LIMIT $${hasPoint ? 4 : 1}`,
      hasPoint ? [lat, lon, radiusMiles * 1609.34, limit] : [limit],
    );
    res.json({ count: rows.length, events: rows });
  } catch (err) {
    res.status(503).json({ error: String(err.message || err), hint: 'is the database running?' });
  }
});

// Wildfires near a point at a caller-chosen radius — lets the UI widen the
// search (25/50/100 mi) without re-running the whole report. Live, not persisted.
router.get('/wildfires', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusMiles = Math.min(Math.max(Number(req.query.radius) || 25, 1), 100);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'numeric lat and lon are required' });
  }
  try {
    const wildfires = await getNearbyWildfires(lat, lon, radiusMiles);
    res.json({ count: wildfires.length, radiusMiles, wildfires });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Read-back: recently searched locations (search history).
router.get('/history', async (_req, res) => {
  try {
    const { rows } = await query(
      // address IS NOT NULL filters out subscription anchor rows (lat/lon-only,
      // no address) so they never appear as blank entries in search history.
      `SELECT id, address, lat, lon, county_fips, created_at
       FROM locations WHERE address IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
    );
    res.json({ count: rows.length, locations: rows });
  } catch (err) {
    res.status(503).json({ error: String(err.message || err), hint: 'is the database running?' });
  }
});
