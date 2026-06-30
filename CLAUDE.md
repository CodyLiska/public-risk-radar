# CLAUDE.md — public-risk-radar

> This file is read automatically by Claude Code at the start of every session.
> Keep this file updated as the project evolves.

---

## Memory Bank

At the start of every session, read these files from the Obsidian vault:

- `C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/session-state.md` — working state snapshot from last session
- `C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/lessons-summary.md` — known bugs index (check before debugging)
- `C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/decisions-summary.md` — architectural decisions index (check before any arch decision)
- `C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/conventions.md` — coding standards
- `C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/recurring-tasks.md` — standing rules
- `C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/projects/public-risk-radar.md` — per-project deep context (if it exists)

Do NOT read session-log.md, decisions-log.md, or lessons-learned.md at startup — pull them on demand when relevant.

---

## Ending a Session

Before typing `/exit`, always tell Claude: **"wrap up this session"**

The global CLAUDE.md handles the full wrap-up checklist. Project file to update at wrap-up:
`C:\Users\hxchi\iCloudDrive\iCloud~md~obsidian\Obfluence Home Lab\11_Claude-Memory/projects/public-risk-radar.md`

---

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Enter a U.S. address → see the public risks near it (weather alerts, AQI, flood zone,
wildfires, stream gauges, earthquakes, EPA facilities, county disaster history, NASA
FIRMS active-fire detections, NASA EONET natural events) on one MapLibre map. Backend
geocodes via Census, then fans out to 11 sources in parallel (`Promise.allSettled`) so
one failing upstream never breaks the page. Results are served live, persisted into
PostGIS, and cached upstream in Redis. Opt-in alerts deliver to a Discord webhook via a
background interval worker. First demo geography: Phoenix / Maricopa.

GitHub: `github.com/CodyLiska/public-risk-radar`.

> **Keys:** AirNow (`AIRNOW_API_KEY`) and NASA FIRMS (`FIRMS_MAP_KEY`) need a free key;
> both degrade gracefully when unset. EONET needs no key.

## Development Commands

```bash
npm run dev                             # one command: docker --wait db+redis, then API+client (concurrently)
# — or run the pieces separately —
docker compose up -d db redis          # Postgres/PostGIS + Redis
cd server && npm install && npm run dev # API on :3001 (node --watch)
cd client && npm install && npm run dev # Vite on :5173 (proxies /api → :3001)
npm test                                # repo root: server (node:test) + client (vitest)
```

- `node --watch` can silently serve **stale server code** (esp. on WSL / rapid saves) —
  if a server change "doesn't take", `touch server/src/index.js` (entry point = reliable
  nudge) and verify against the live endpoint, not just tests.

- Server suite is hermetic (`REDIS_URL=` forces in-memory cache; dummy AirNow key).
  DB-integration tests auto-skip with no Postgres. **Always keep `REDIS_URL=` for tests**
  or a live Redis client hangs the `node --test` process.
- Alerts worker runs only when `ALERTS_ENABLED=true`.
- DB image is `imresamu/postgis` (multi-arch) so it runs natively on both Windows/Intel
  (amd64) and Apple Silicon (arm64). The official `postgis/postgis` is amd64-only and
  would run under emulation on Apple Silicon — do not switch back to it.
- Dev env: WSL2 (Ubuntu) + Docker Desktop on Windows (WSL integration). Launch Docker
  from WSL if needed: `cmd.exe /c start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"`.
  On macOS, just start Docker Desktop normally.

## API Endpoints

- `GET /api/health` — service + DB status
- `GET /api/geocode?address=` — geocode only
- `GET /api/search?address=` — full risk report (all sources); responds first, then persists fire-and-forget (never blocks the response)
- `GET /api/wildfires?lat=&lon=&radius=` — live wildfires at a chosen radius (1–100 mi), nearest-first with `distanceMiles` (powers the card's radius dropdown)
- `GET /api/events?lat=&lon=&radius=` — persisted risk events near a point (PostGIS)
- `GET /api/history` — recently searched locations
- `POST|GET /api/subscriptions`, `PATCH|DELETE /api/subscriptions/:id` — alert CRUD

## Project Structure

- `server/src/services/*.js` — one client per source + `aggregate.js` (fan-out), `persist.js`
- `server/src/services/alerts/{evaluate,notify,worker}.js` — threshold core, Discord, worker
- `server/src/lib/{httpClient,cache}.js` — fetch wrapper + Redis cache (in-memory fallback)
- `server/src/routes/{index,subscriptions}.js` — Express routes
- `client/src/App.vue`, `components/RiskMap.vue`, `lib/format.js`, `api.js`
- `db/init/01_schema.sql` (PostGIS), `db/init/02_alerts.sql` (alerts cols; idempotent)

## Architecture Notes

- **Resilience contract everywhere:** a DB / Redis / upstream / delivery failure degrades
  gracefully and never breaks the live response.
- **Persist normalized domain tables, not a whole-report cache** (sources have mismatched
  freshness); cache at the upstream layer in Redis instead.
- **Alerts dedupe is edge-triggered** (`shouldFire`): fire on first cross, re-fire only on
  numeric escalation / categorical change, reset `last_state` on drop.
- **Map frames location + EPA cluster only** (far gauges/quakes excluded from `fitBounds`).
- `02_alerts.sql` auto-runs only on a fresh DB volume — apply by hand on an existing DB.

## Data Models

PostGIS schema in `db/init/01_schema.sql`: `locations` (one row per search; `geom`
geography point), domain tables (`facilities`, `water_gauges`, `disaster_declarations`,
`risk_events`) upserted on natural keys, and `alert_subscriptions`
(`event_type`, `threshold` JSONB, `delivery_method/target`, `active`, `last_fired_at`,
`last_state` JSONB — last two from `02_alerts.sql`).
