# Server tests

Run with the built-in Node test runner (no extra dependencies):

```bash
npm test          # run once
npm run test:watch
```

The `test` script sets `REDIS_URL=` (forces the cache to its in-memory fallback,
so no Redis is needed and nothing leaks between runs) and a dummy
`AIRNOW_API_KEY` (so the AirNow client takes its "configured" path).

| File | Covers |
|------|--------|
| `persist.unit.test.js` | `dedupeBy` — the key-collapse that fixes the upsert bug |
| `persist.db.test.js`   | **DB integration:** duplicate-key upserts + re-search idempotency. Auto-skips if no Postgres is reachable. |
| `aggregate.test.js`    | `settle` + `buildTimeline` (merge, sort, drop undated, ignore failures) |
| `httpClient.test.js`   | retry on 5xx, no-retry on 4xx, URL caching, timeout/abort |
| `cache.test.js`        | in-memory fallback get/set + TTL expiry |
| `services.test.js`     | field projection for every upstream client (mocked `fetch`) |

`helpers.js` provides the `fetch` stubs.

The DB tests need the compose `db` service up:

```bash
docker compose up -d db
```
