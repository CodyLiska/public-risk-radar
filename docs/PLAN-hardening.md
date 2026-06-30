# PLAN — Productization hardening (perf, abuse protection, durable alerts)

> Written 2026-06-30 for a future session. Three **independent** findings from the
> post-NASA review, ordered by "do before you deploy." Each phase ships on its own
> and keeps the resilience contract intact (a failure degrades, never breaks the page).
> Profiling that motivated this is in §0. Phases: **A** rate limiting (#3), **B**
> cold-path performance (#2), **C** durable alerts (#4).
>
> Pick phases independently. A is the smallest and a deploy prerequisite; B is the
> biggest UX win; C only matters once real subscribers exist.

---

## 0. Context the executor must load first

Read before writing code — mirror existing patterns:

- `server/src/index.js` — Express app: `cors`, `express.json`, `morgan`, `app.use('/api', router)`,
  worker start gated on `config.alertsEnabled`. **All middleware stacks here.**
- `server/src/routes/index.js` — routes. `/api/search` (the expensive fan-out) + the
  already-lazy `/api/wildfires` (the template for moving a heavy layer off `/search`).
- `server/src/services/aggregate.js` — `buildRiskReport` fan-out + `withDeadline` (added
  in the perf pass; per-source 8s guardrail) + `settle`.
- `server/src/lib/cache.js` — Redis wrapper w/ in-memory fallback (`cacheGet/cacheSet`).
  **Phase B's stale-while-revalidate goes here.** Note `REDIS_URL=''` → in-memory only.
- `server/src/lib/httpClient.js` — `fetchJson/fetchText` (timeout 10s, 2 retries, TTL cache).
- `server/src/services/usgsWater.js` (gauges, 20-mi bbox) + `server/src/services/epaEcho.js`
  (FRS ArcGIS, sequential 5000-row paging) — **the two perf hotspots.**
- `server/src/services/alerts/{worker,evaluate,notify}.js` — `runOnce` (DI-based, unit-testable),
  `startAlertWorker` (setInterval + `running` guard), `deliver` (Discord). `last_state`/
  `last_fired_at` already persist edge-trigger state across restarts.
- `server/test/` — `node:test`; `helpers.js` `stubFetchJson/stubFetchWith`; DB-integration
  tests auto-skip with no Postgres. Keep `REDIS_URL=` in the test script.

### Profiling baseline (cold NYC `350 5th Ave`, 2026-06-30)
```
geocode 568ms · floodZone 1496ms · naturalEvents 1960ms
epaFacilities 4963ms (150 items)  ← FRS paging over a dense area
waterGauges   6698ms (82 items)   ← USGS IV, the worst
TOTAL wall    7267ms              (gated by the slowest source)
```
Warm (Redis hit) for the same address: 0.02–0.4s. **The problem is cold-miss latency,
not steady-state.** Re-profile before optimizing — run `server/_profile.mjs` pattern
from the perf session (import each service, time it; delete after).

### Invariants (do not violate)
1. Resilience contract: any source/DB/Redis/delivery failure degrades to "unavailable",
   never breaks the live response. Keep `Promise.allSettled` + `settle` + `withDeadline`.
2. Tests stay green after each phase: `npm test` (server `node:test` + client Vitest).
   Server suite must stay hermetic (`REDIS_URL=` forces in-memory; dummy keys).
3. New deps must be justified (conventions: "don't add a package for 10 lines"). The
   three candidate deps below each earn their place; note the rationale in the commit.

---

## A. Abuse protection / rate limiting  (finding #3 — do first)

**Why:** `/api/search` fans out to 11 upstreams, two with hard quotas (FIRMS transactions,
AirNow daily). Per-source Redis caching shields repeat queries, but a scraper hitting many
*distinct* addresses bypasses the cache and drains quotas + runs up cost. No throttle today.

**Approach (recommended):** `express-rate-limit` with a Redis store so limits survive
restarts and work across instances; fall back to the default in-memory store when
`REDIS_URL` is empty (dev/test). Tiered: strict on the expensive endpoints, lenient on
read-backs.

### A.1 Deps
```
npm i express-rate-limit rate-limit-redis   # in server/
```
(`rate-limit-redis` needs a redis client instance — reuse the one in `lib/cache.js`;
export it if not already, or construct a shared client. If `REDIS_URL=''`, skip the
store and let express-rate-limit use its in-memory default.)

### A.2 `server/src/lib/rateLimit.js` (NEW)
Factory that builds a limiter, Redis-backed when available:
```js
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisClient } from './cache.js'; // export the client (null when REDIS_URL='')

export function makeLimiter({ windowMs, max, name }) {
  return rateLimit({
    windowMs, max,
    standardHeaders: true, legacyHeaders: false,
    ...(redisClient ? { store: new RedisStore({ sendCommand: (...a) => redisClient.sendCommand(a), prefix: `prr:rl:${name}:` }) } : {}),
    message: { error: 'Too many requests — please slow down.' },
  });
}
```

### A.3 Wire in `routes/index.js`
- Strict on the fan-out + geocode (the upstream-spending routes):
  `router.use(['/search', '/geocode', '/wildfires'], makeLimiter({ windowMs: 60_000, max: 20, name: 'search' }));`
- Lenient global cap on everything else (read-backs hit only our DB):
  apply a `{ windowMs: 60_000, max: 120, name: 'api' }` limiter at `app.use('/api', ...)` in `index.js`.
- Tune numbers in §Decisions.

### A.4 `trust proxy` (critical when deployed)
In `index.js`, behind any proxy/load balancer (Render, Fly, nginx, Caddy):
`app.set('trust proxy', 1);` — without it every client shares one IP bucket (the NestJS
throttler lesson). Gate on env so local dev (direct) isn't fooled: only set when
`config.nodeEnv === 'production'` or a `TRUST_PROXY` env is set.

### A.5 Optional — keyed-source daily budget (defense in depth)
A global counter in Redis (`INCR prr:budget:firms:<yyyy-mm-dd>`, TTL 24h) checked before
calling FIRMS/AirNow; when over budget, short-circuit to `{ configured: false }` /
`unavailable` so a burst can't blow the upstream cap even past the IP limiter. Defer
unless you actually approach the caps.

### A.6 Tests
- `server/test/rateLimit.test.js` — mount `makeLimiter({ max: 2 })` on a throwaway Express
  app via `supertest` (or `node:http` + fetch), assert 3rd request in the window → 429.
  Run with `REDIS_URL=` so it uses the in-memory store (hermetic).
- Verify the limiter doesn't leak across tests (fresh app per test).

### A.7 Verify
- `curl` the search endpoint >max times in a minute → 429 with the JSON message +
  `RateLimit-*` headers. Read-backs still work. With `REDIS_URL` set, the count survives a
  server restart (Redis-backed).

---

## B. Cold-path performance  (finding #2 — biggest UX win)

**Why:** ~7s cold for a dense city, gated by USGS gauges (6.7s) + EPA paging (5s). The
optimistic-fly (added) fixes *perceived* lag for history clicks, but a first-ever search
of an address still blocks on the slow data. Both sources tolerate staleness (gauges
change slowly; FRS facility lists barely change — 6h TTL today).

Two levers, **do both** — they compound:

### B.1 Stale-while-revalidate (SWR) in `lib/cache.js`  (highest impact, low risk)
Serve a stale cached value **immediately** and refresh it in the background, so a cold
hit only happens on the *very first* request for a location, never again.

- Store entries with `{ value, freshUntil, staleUntil }` instead of a bare TTL.
- New `cacheGetSWR(key)` returns `{ value, stale }`. `fetchJson/fetchText` gain an
  `swrMs` option: if a value is fresh → return it; if stale-but-within-`staleUntil` →
  return it AND kick off a background refresh (don't await); if absent → fetch blocking.
- Apply generous `swrMs` to the slow, slow-changing sources: gauges (fresh 15m / stale 6h),
  EPA (fresh 6h / stale 7d). Leave fast/volatile sources (NWS alerts, AQI, quakes) as-is.
- Background refresh failures are swallowed (stale value already served — resilience
  contract). Guard against a refresh stampede (a simple in-flight `Set` of keys).

### B.2 Move the two heavy layers off the blocking `/api/search`  (progressive load)
Mirror the existing `/api/wildfires` pattern: the client fetches the heavy layers
separately after the fast core report renders, so `/api/search` returns in <1s always.

- New routes (live, not persisted): `GET /api/gauges?lat&lon&radius` and
  `GET /api/facilities?lat&lon&radius&count` (EPA already returns `{total, facilities}`).
- Remove `getNearbyGauges` + `getNearbyFacilities` from the `buildRiskReport` fan-out
  (and their `sources.*` keys / persist hooks) — OR keep them in the report but have the
  client prefer the lazy endpoints. **Decision in §Decisions** (removing changes the
  persist path + tests; the lighter touch is to keep them in `/search` but lower their
  `withDeadline` and let SWR carry the speed). Recommended: **B.1 alone may be enough** —
  measure after B.1 before doing B.2's surgery.
- Client (`App.vue`): add `loadGauges()` / `loadFacilities()` called after `onSearch`
  resolves (like `loadWildfires()`), with their own loading state on the cards. `RiskMap`
  already plots EPA from a prop (`epaShown`) and gauges from `report.sources` — repoint
  gauges to a ref the same way EPA works.

### B.3 Optional — warm the demo geography
On startup (or a cron), pre-fetch Phoenix/Maricopa so the showcase address is always warm.
Cheap insurance for demos; skip for general use.

### B.4 Tests
- `server/test/cache.test.js` — extend: a stale entry returns immediately AND triggers one
  background refresh; an absent entry blocks; refresh failure keeps serving stale.
- If B.2 done: route tests for `/api/gauges` + `/api/facilities` (mirror
  `routes.wildfires.test.js`); update `aggregate`/`persist` tests for the removed sources.
- Client: `loadGauges/loadFacilities` loading-state tests (mirror wildfire tests).

### B.5 Verify
- Re-run the §0 profiler: second cold-ish hit of a new dense city should be <1s (SWR serves
  stale + refreshes). First-ever hit still pays once.
- `/api/search` p95 well under 1s once SWR is warm; the slow layers fill in progressively
  if B.2 done. Resilience: kill Redis → still works (in-memory), kill a slow upstream →
  card shows "unavailable", rest of page fine.

---

## C. Durable alerts worker  (finding #4 — only when you have real subscribers)

**Why:** today it's a single in-process `setInterval`. Good enough to demo; for real
subscribers the gaps are: (a) **multi-instance double-fire** — two API instances both tick
and double-deliver (no lock); (b) **no delivery retry** — a transient Discord 5xx is
logged and dropped until the next natural cross; (c) **restart gap** — process down = no
evaluation, missed windows; (d) interval drift. `last_state`/`last_fired_at` already give
edge-trigger durability across restarts, so the core dedupe is fine — it's the *scheduling
and delivery* that's demo-grade.

Two paths — pick by ambition:

### C.1 Minimal hardening (keep the interval, make it safe)  — recommended first
1. **Single-runner lock (Postgres advisory lock):** wrap each `tick` in
   `pg_try_advisory_lock(<const key>)` → if not acquired, skip (another instance is
   running). Release in `finally`. Prevents double-fire with zero new infra.
   Alternative per-row: `SELECT ... FROM alert_subscriptions WHERE active FOR UPDATE SKIP LOCKED`.
2. **Delivery retry with backoff:** in `notify.deliver`, retry transient failures (5xx,
   network) 2–3× with backoff; treat 4xx (bad webhook) as permanent → mark the sub
   unhealthy (new `delivery_error`/`delivery_failures` column) and optionally deactivate
   after N. Don't let retries block the whole tick — bound total time.
3. **Structured logging / observability:** count evaluated/fired/failed per tick; log
   delivery failures with sub id. Needed to trust it in prod.

### C.2 Durable scheduler (bigger, when subscribers are real)
Migrate scheduling to **pg-boss** (Postgres-backed job queue — no new infra, fits the
stack). Gives: persisted schedule (survives restart, no missed-window gap), built-in
retries/backoff, and multi-instance safety (workers pull jobs). Shape:
- A cron job enqueues "evaluate subscription N" jobs; workers run `runOnce`-per-sub logic.
- Delivery becomes its own retried job (idempotent via `last_fired_at`).
- Keep `runOnce`'s DI design — it's already unit-testable; pg-boss just replaces the
  `setInterval` driver + the delivery dispatch.

### C.3 Tests
- C.1: advisory-lock path — two concurrent `tick`s, assert only one runs the body (mock
  the lock fn). Delivery retry — `sendDiscord` with a stubbed `fetchImpl` returning 503
  then 200, assert it retries then succeeds; 400 → no retry, marked unhealthy.
- `runOnce` tests already cover per-sub isolation — keep them; they shouldn't change.
- C.2: pg-boss is integration-heavy — gate those tests on a reachable Postgres (auto-skip
  like `persist.db.test.js`).

### C.4 Verify
- Run two server instances with `ALERTS_ENABLED=true` → exactly one delivery per cross (no
  doubles). Kill the instance mid-tick → the other picks up next tick (C.1) / job resumes
  (C.2). Force a Discord 503 → retried; force a 400 → marked unhealthy, not retried forever.

---

## Decisions left open (pick at execution; defaults in brackets)
- Rate limits: search `[20/min/IP]`, global `[120/min/IP]`; per-key daily budgets [defer].
- `trust proxy` value `[1]` (single proxy) — set higher only for chained proxies.
- Perf: do **B.1 (SWR) first and re-measure** before committing to B.2's fan-out surgery
  [recommended]. SWR alone may make cold rare enough that B.2 isn't worth the blast radius.
- SWR windows: gauges `[fresh 15m / stale 6h]`, EPA `[fresh 6h / stale 7d]`.
- Alerts: **C.1 first** [recommended]; C.2 (pg-boss) only when you have paying/real
  subscribers and a deploy with >1 instance.

## Suggested order & rationale
1. **A (rate limiting)** — deploy blocker; small, isolated, protects quotas/cost.
2. **B.1 (SWR)** — biggest perceived + real win, low risk, no API surface change. Measure.
3. **B.2 (progressive)** — only if B.1 isn't enough; larger blast radius (persist + tests).
4. **C.1 (alerts safety)** — before inviting real subscribers.
5. **C.2 (pg-boss)** — when scale/SLA actually demands it.

## Risk / rollback
- A: middleware-only; remove the `app.use` lines to roll back. Watch the in-memory-store
  fallback path when `REDIS_URL=''` (don't construct a RedisStore against a null client).
- B.1: cache-layer change touches every cached source — keep the old `cacheGet/cacheSet`
  working (SWR is additive via a new path/option) so non-SWR callers are unaffected.
- B.2: changes the `/search` shape + persist + tests — do it as its own commit, behind the
  measurement gate.
- C: keep `runOnce`'s DI seam intact; both C.1 and C.2 reuse it. The advisory lock is the
  one must-have before multi-instance deploy.
```
