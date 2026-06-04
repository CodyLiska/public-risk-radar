# Plan — Alerts feature

The last unbuilt leg of the README scope ("timeline, alerts, and caching"; the
other two are done). The `alert_subscriptions` table already exists as a stub.

## Decisions (made 2026-06-03)
- **Delivery channel:** Discord webhook (no SMTP/creds; instant to test). Email is a
  later follow-up behind a pluggable interface.
- **Evaluation trigger:** background worker on an interval — re-fetches the relevant
  source(s) per subscription and fires when a threshold is crossed. Real alerting,
  independent of whether anyone is using the app.

## Design principles to follow (match the existing codebase)
- Best-effort & resilient: a delivery or DB failure must never crash the worker
  loop (mirror the try/catch ethos in `persist.js` / `cache.js`).
- Reuse the existing source clients in `server/src/services/*` — the worker calls
  the same functions (`getCurrentAqi`, `getActiveAlerts`, `getNearbyWildfires`,
  `getRecentQuakes`, `getFloodZone`, `getNearbyGauges`) the report builder uses.
- Keep pure logic (threshold evaluation, message formatting) in separate functions
  so they're unit-testable without network/DB — that's where the test value is.

---

## 1. Schema changes

Current `alert_subscriptions` (in `db/init/01_schema.sql`):
```
id, location_id → locations(id), event_type, threshold JSONB,
delivery_method, delivery_target, created_at
```

Add columns for activation + de-duplication (so an alert that stays "crossed"
doesn't re-fire every interval):
```sql
ALTER TABLE alert_subscriptions
  ADD COLUMN active        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN last_fired_at TIMESTAMPTZ,
  ADD COLUMN last_state    JSONB;       -- last evaluated value, for edge-trigger dedupe
```

> ⚠️ `db/init/*.sql` only auto-runs on a **fresh** Postgres volume. The dev DB is
> already initialized, so either run the ALTER manually
> (`docker exec prr-db psql -U prr -d public_risk_radar -f -`), add it as
> `db/init/02_alerts.sql` for fresh setups, **and** apply it to the running DB.
> Note this clearly so next setup isn't surprised.

`event_type` vocabulary (string enum, validated in the API):
`aqi | weather_alert | flood | wildfire | earthquake | water_gauge`

`threshold` JSONB shape per type (examples):
```jsonc
{ "type": "aqi",         "gt": 100 }                 // AQI above 100
{ "type": "earthquake",  "minMagnitude": 4.0 }       // quake ≥ M4 within the source radius
{ "type": "wildfire",    "withinMiles": 25 }          // any active fire within 25 mi
{ "type": "weather_alert","severityAtLeast": "Severe" }
{ "type": "water_gauge", "siteId": "09512162", "gageHeightGt": 10 }
{ "type": "flood" }                                   // fires if the point is in an SFHA
```

---

## 2. Pure evaluation core  (`server/src/services/alerts/evaluate.js`)

`evaluateThreshold(eventType, threshold, sourceData) -> { crossed: bool, value, message }`

- One pure function per event type, dispatched by `eventType`.
- Takes the already-fetched projected source data (same shapes the services return)
  and the threshold; returns whether it's crossed, the observed value (for dedupe),
  and a human message for delivery.
- **No network, no DB** → fully unit-testable. This is the heart of the feature and
  should have the most tests.

De-dupe rule (edge-triggered): fire only when `crossed === true` AND it wasn't
already crossed at the same/over level in `last_state` (compare observed `value`).
Reset `last_state` when it falls back below threshold so it can fire again later.

---

## 3. Delivery  (`server/src/services/alerts/notify.js`)

```js
export async function deliver(subscription, message) { /* dispatch on delivery_method */ }
async function sendDiscord(webhookUrl, message) {
  // POST { content: message } to the webhook; non-2xx → throw (caught by worker)
}
```
- Pluggable shape so an `sendEmail` can be added later without touching the worker.
- Use the existing `fetchJson`/`fetch` with a short timeout; never throw out of the
  worker loop (wrap per-subscription).

---

## 4. Worker  (`server/src/services/alerts/worker.js`)

```
startAlertWorker():
  setInterval(runOnce, config.alertsIntervalMs)   // also run once on start
runOnce():
  subs = SELECT * FROM alert_subscriptions JOIN locations ... WHERE active
  for each sub (sequential or small concurrency):
    try:
      data = fetch only the source needed for sub.event_type (reuse services/*)
      { crossed, value, message } = evaluateThreshold(sub.event_type, sub.threshold, data)
      if crossed and not alreadyFired(sub.last_state, value):
        await deliver(sub, message)
        UPDATE alert_subscriptions SET last_fired_at = now(), last_state = {value} WHERE id = sub.id
      else if not crossed:
        UPDATE ... SET last_state = null   // reset so it can re-fire
    catch err: log and continue   // one bad sub never stops the loop
```

- Started from `server/src/index.js` behind a flag (`if (config.alertsEnabled) startAlertWorker()`),
  so tests/CI and the plain API don't spin a background loop unintentionally.
- Group subscriptions by (location, source) to avoid refetching the same source
  repeatedly in one tick (optimization; fine to skip in v1 since httpClient/Redis
  already caches upstream responses).

---

## 5. CRUD API  (`server/src/routes/index.js` + maybe `routes/subscriptions.js`)

| Endpoint | Body / params | Notes |
|----------|---------------|-------|
| `POST /api/subscriptions` | `{ address or lat/lon, event_type, threshold, delivery_method, delivery_target }` | geocode/find-or-create the location row, validate event_type + threshold, insert |
| `GET /api/subscriptions` | — | list (dev convenience) |
| `DELETE /api/subscriptions/:id` | — | remove |
| (optional) `PATCH /api/subscriptions/:id` | `{ active }` | pause/resume |

- Validate `event_type` against the vocabulary and `threshold.type` matches.
- Reuse `geocodeAddress` + the same location upsert idea as `persist.insertLocation`
  (consider extracting a `findOrCreateLocation` so subscriptions don't spam the
  history table — decide: subscriptions probably want a *stable* location row, not a
  new one per call).

---

## 6. Config  (`server/src/config.js` + `.env(.example)`)
```
ALERTS_ENABLED=true
ALERTS_INTERVAL_MS=300000        # 5 min
# Discord webhook is per-subscription (delivery_target), so no global key needed.
```

---

## 7. Tests
- **`evaluate` unit tests** (node:test, no deps) — each event type: crossed vs not,
  boundary values, dedupe-against-last_state. Highest value.
- **`notify` test** — `sendDiscord` posts the right payload (mocked `fetch`),
  throws on non-2xx; unknown delivery_method handled.
- **worker test** — inject a fake "fetch source" + fake deliver, assert it fires once
  on cross, doesn't re-fire while still crossed, re-arms after reset. (Refactor the
  worker so the source-fetch and deliver fns are injectable for this.)
- **route tests** — validation rejects bad event_type/threshold; POST creates a row
  (DB-integration, auto-skip like `persist.db.test.js`).

---

## 8. Frontend (optional, can be a follow-up)
- A small "🔔 Alert me here" form on a searched location: pick event_type, threshold,
  paste a Discord webhook URL → `POST /api/subscriptions`.
- A "Your alerts" list with delete. Keep `api.js` additions thin + unit-tested like
  the existing ones.

---

## Suggested build order
1. Schema ALTER (apply to running DB + add `02_alerts.sql`).
2. `evaluate.js` + its unit tests (pure, fast feedback).
3. `notify.js` (Discord) + test.
4. `worker.js` (injectable deps) + test; wire into `index.js` behind the flag.
5. CRUD routes + validation + tests.
6. (optional) frontend form.

Each step: `npm test` from root. Update `LAST-SESSION-NOTES.md` and the README API
table when endpoints land.
