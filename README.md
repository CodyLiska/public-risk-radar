# Public Risk Radar

> Enter a U.S. address and see the public risks near it — active weather alerts,
> air quality, flood zone, nearby wildfires, stream gauges, recent earthquakes,
> EPA-regulated facilities, and county disaster history — on one map.

This is the MVP scaffold from the build plan. First demo geography: **Phoenix / Maricopa County, AZ**, but every source works nationally.

> ⚠️ Informational only. Data comes straight from public agency APIs and this tool is **not** an official source of emergency instructions or safety ratings.

## Architecture

```
public-risk-radar/
├── docker-compose.yml      # Postgres + PostGIS, Redis
├── db/init/01_schema.sql   # geospatial schema (auto-loaded on first DB start)
├── server/                 # Node + Express API (aggregates all sources)
│   └── src/services/       # one client per public data source
└── client/                 # Vue 3 + Vite + MapLibre frontend
```

The backend geocodes the address (Census), then fans out to every source in
parallel (`Promise.allSettled`) so one failing upstream never breaks the page.

### Data sources wired

| Source | What | Key needed |
|--------|------|-----------|
| Census Geocoder | address → lat/lon + county FIPS | no |
| NWS | active weather alerts | no (User-Agent) |
| AirNow | current AQI | **yes** (free) |
| FEMA OpenFEMA | county disaster history | no |
| FEMA NFHL | flood zone at point | no |
| NIFC/WFIGS | active wildfire incidents | no |
| USGS Water | nearby stream gauges | no |
| USGS Earthquake | recent quakes | no |
| EPA ECHO | nearby regulated facilities | no |

## Quick start

```bash
# 1. config
cp .env.example .env
#    then add a free AirNow key: https://docs.airnowapi.org/account/request/

# 2. database
docker compose up -d db redis      # schema loads automatically on first run

# 3. backend
cd server && npm install && npm run dev      # http://localhost:3001

# 4. frontend (new terminal)
cd client && npm install && npm run dev      # http://localhost:5173
```

Open http://localhost:5173 and search an address (try `Phoenix, AZ`).

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

## Notes / known rough edges

- **AirNow** returns empty until `AIRNOW_API_KEY` is set — every other source works without a key.
- The **NIFC** and **EPA ECHO** endpoints are public ArcGIS/REST services whose
  field names occasionally change; the clients fail soft if a field is missing.
- Results are served **live** per request and also persisted into the normalized
  tables (timeline read-back via `/api/events`, history via `/api/history`).
  Upstream responses are cached in Redis (in-memory fallback if Redis is down).
- This is a JavaScript project; it currently lives under a `02_Python` path for
  convenience and will be relocated under `01_Javascript`.
