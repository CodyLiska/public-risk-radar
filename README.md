# Public Risk Radar

> Enter a U.S. address and see the public risks near it — active weather alerts,
> air quality, flood zone, nearby wildfires, stream gauges, recent earthquakes,
> EPA-regulated facilities, and county disaster history — on one map.

Built around **Phoenix / Maricopa County, AZ** as the first demo geography, but every source works nationally. Nine public data sources, a risk timeline, opt-in Discord alerts, PostGIS persistence, and Redis-backed upstream caching.

> ⚠️ Informational only. Data comes straight from public agency APIs and this tool is **not** an official source of emergency instructions or safety ratings.

## Architecture

```
public-risk-radar/
├── docker-compose.yml      # Postgres + PostGIS, Redis
├── db/init/                # geospatial schema + alerts migration (auto-loaded on fresh DB)
├── server/                 # Node + Express API (aggregates all sources)
│   ├── src/services/       # one client per public data source
│   ├── src/services/alerts/# threshold evaluation, Discord delivery, background worker
│   └── test/               # node:test suite (no extra deps)
└── client/                 # Vue 3 + Vite + MapLibre frontend (+ Vitest)
```

The backend geocodes the address (Census), then fans out to every source in
parallel (`Promise.allSettled`) so one failing upstream never breaks the page.

### Data sources

Every risk layer comes from a public U.S. government API, queried live and fanned
out in parallel. Only AirNow needs a key (free). Each has one client in
`server/src/services/*.js`; `aggregate.js` runs them with `Promise.allSettled`, so
any single upstream failure degrades to a "source unavailable" card rather than
breaking the page.

| Source | Provides | Endpoint | Key |
|--------|----------|----------|-----|
| **U.S. Census Geocoder** | address → lat/lon + state/county FIPS | `geocoding.geo.census.gov/geocoder/geographies` | no |
| **NWS** — National Weather Service | active weather alerts + point/forecast-office metadata | `api.weather.gov` (`/alerts/active`, `/points`) | no — descriptive `User-Agent` required |
| **AirNow** (EPA/NOAA) | current air quality — AQI for O₃, PM2.5, PM10 | `airnowapi.org/aq/observation/latLong/current` | **yes (free)** |
| **FEMA OpenFEMA** | county disaster-declaration history | `fema.gov/api/open/v2/DisasterDeclarationsSummaries` | no |
| **FEMA NFHL** — National Flood Hazard Layer | flood zone at the point (ArcGIS layer 28) | `hazards.fema.gov/arcgis/…/NFHL/MapServer/28` | no |
| **NIFC / WFIGS** | active wildfire incidents | `services3.arcgis.com/…/WFIGS_Incident_Locations_Current/FeatureServer/0` | no |
| **USGS Water Services** | nearby stream-gauge readings (discharge + gage height) | `waterservices.usgs.gov/nwis/iv` | no |
| **USGS Earthquake** (FDSN event) | recent earthquakes near the point | `earthquake.usgs.gov/fdsnws/event/1/query` | no |
| **EPA FRS** — Facility Registry Service | nearby EPA-regulated facilities + their program interests | `geodata.epa.gov/arcgis/…/FRS_INTERESTS/MapServer/8` | no |

**Map tiles:** OpenStreetMap raster basemap (`tile.openstreetmap.org`) rendered by
MapLibre — no key.

## Quick start

```bash
# 1. config
cp .env.example .env
#    then add a free AirNow key: https://docs.airnowapi.org/account/request/

# 2. install dependencies (once)
npm install                        # root (dev orchestration)
cd server && npm install && cd ..
cd client && npm install && cd ..

# 3. start everything (Docker Desktop must be running)
npm run dev
```

`npm run dev` starts the Postgres/PostGIS + Redis containers (waiting for them to
pass their healthchecks), then runs the backend (http://localhost:3001) and
frontend (http://localhost:5173) together in one terminal with prefixed logs.
The DB schema loads automatically on the container's first run. A single
`Ctrl-C` stops both dev servers.

Open http://localhost:5173 and search an address (try `Phoenix, AZ`).

### Running the servers separately

`npm run dev` is just a convenience wrapper. To run the pieces in their own
terminals (e.g. to read one server's logs in isolation):

```bash
# database (once, Docker Desktop must be running)
docker compose up -d db redis

# backend
npm run dev:server      # http://localhost:3001  (or: cd server && npm run dev)

# frontend (new terminal)
npm run dev:client      # http://localhost:5173  (or: cd client && npm run dev)
```

> Runs natively on both Intel/Windows (amd64) and Apple Silicon (arm64) — the
> Postgres/PostGIS image (`imresamu/postgis`) is multi-arch, so no per-machine
> changes are needed.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | service + DB status |
| `GET /api/geocode?address=...` | geocode only |
| `GET /api/search?address=...` | full risk report (all sources) |
| `GET /api/events?lat=&lon=&radius=` | persisted risk events near a point (PostGIS) |
| `GET /api/history` | recently searched locations |
| `POST /api/subscriptions` | create an alert subscription (`{ address \| lat/lon, event_type, threshold, delivery_method:"discord", delivery_target }`) |
| `GET /api/subscriptions` | list subscriptions |
| `PATCH /api/subscriptions/:id` | pause/resume (`{ active }`) |
| `DELETE /api/subscriptions/:id` | remove a subscription |

### Alerts

A background worker (`ALERTS_ENABLED=true`) evaluates active subscriptions every
`ALERTS_INTERVAL_MS` and delivers to each subscription's **Discord webhook** when a
threshold is crossed (edge-triggered, so a sustained condition fires once). Event
types: `aqi`, `weather_alert`, `flood`, `wildfire`, `earthquake`, `water_gauge`.

> The alerts columns live in `db/init/02_alerts.sql`, which auto-runs only on a
> **fresh** DB volume. On an already-initialized dev DB, apply it once:
> `docker exec -i prr-db psql -U prr -d public_risk_radar < db/init/02_alerts.sql`

## Testing

```bash
npm test            # runs the server + client suites
npm run test:server # node:test — services, aggregation, caching, persistence, alerts
npm run test:client # Vitest — pure presentation helpers + the API layer
```

The server suite runs hermetically (forces the in-memory cache and a dummy AirNow
key). DB-integration tests auto-skip when no Postgres is reachable, so the suite
passes in a bare checkout.

## Notes / known rough edges

- **AirNow** returns empty until `AIRNOW_API_KEY` is set — every other source works without a key.
- The **NIFC** and **EPA ECHO** endpoints are public ArcGIS/REST services whose
  field names occasionally change; the clients fail soft if a field is missing.
- Results are served **live** per request and also persisted into the normalized
  tables (timeline read-back via `/api/events`, history via `/api/history`).
  Upstream responses are cached in Redis (in-memory fallback if Redis is down).
