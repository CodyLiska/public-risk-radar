# PLAN — Add NASA FIRMS (active fire hotspots) + NASA EONET (natural events)

> Written 2026-06-29 for a future session. Goal: add two **point-based, on-thesis**
> geo sources to the existing address→risk fan-out **without breaking anything**.
> Both plot on the map and feed a card; EONET also feeds the Risk Timeline.
> Execute Phase 1 fully (live-only, no DB changes). Phase 2 (persistence) is optional.

---

## 0. Context the executor must load first

Read these before writing code — the new sources must mirror existing patterns:

- `server/src/services/nifc.js` — **template for a keyless point source** (bbox query,
  map each feature to `{name, lat, lon, …}`, sort nearest-first via `lib/geo.js`).
- `server/src/services/airnow.js` — **template for a key-gated source** that degrades
  gracefully when the key is missing (`if (!config.X) return { configured: false, … }`).
- `server/src/services/aggregate.js` — `buildRiskReport` fan-out + `buildTimeline`.
- `server/src/lib/httpClient.js` — `fetchJson(url, {headers, timeoutMs, retries, cacheTtlMs})`.
- `server/src/lib/geo.js` — `haversineMiles(lat1,lon1,lat2,lon2)` (reuse for distance/cap).
- `server/src/config.js` — env-key pattern (`process.env.X || ''`).
- `client/src/App.vue` — card pattern + the clickable-row/`flyTo` pattern (see the
  EPA + wildfire + timeline cards) + `focusEvent`/`focusFacility` helpers.
- `client/src/components/RiskMap.vue` — `addMarker(lon, lat, color, label, {size})`,
  the `watch([report, epaFacilities])` rebuild, and `flyTo` (already exposed).
- `client/src/lib/format.js` — pure helpers + their Vitest tests.
- `server/test/services.test.js` + `server/test/helpers.js` — per-service field-projection
  tests with `stubFetchJson`.

### Non-breaking invariants (do not violate)
1. **Append only** to the `Promise.allSettled([...])` array, its destructure, and the
   `sources: {…}` object in `buildRiskReport`. **Never reorder existing entries** — the
   array is positional. New entries go at the **end**.
2. `Promise.allSettled` + `settle()` already isolate failures; a broken new source can't
   break the page. Keep that — never `await` a new source outside the `allSettled`.
3. FIRMS needs a key → it must **degrade gracefully with no key** (return
   `{ configured: false, fires: [] }`), exactly like AirNow. EONET needs no key.
4. Don't touch the DB schema or `persist.js` in Phase 1 (live-only, like the wildfire
   radius endpoint). That keeps blast radius to new files + additive edits.
5. Run `npm test` (server `node:test` + client Vitest) **and** `cd client && npx vite build`
   after each phase. All existing tests must stay green.

---

## 1. External API reference (verified 2026-06-29)

### NASA FIRMS — Area API (active fire / thermal anomalies)
- **Format: CSV only** (not JSON). URL:
  `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}`
- `SOURCE`: use **`VIIRS_SNPP_NRT`** (375 m, near-real-time; good default). Others:
  `VIIRS_NOAA20_NRT`, `MODIS_NRT`, `LANDSAT_NRT` (US/Canada).
- `DAY_RANGE`: integer **1–5** (days back). Use **2**.
- `{west,south,east,north}`: bbox around the point (build with a helper; ~75 km box).
- **MAP_KEY**: free, from the "Get MAP Key" form on the FIRMS site. Env `FIRMS_MAP_KEY`.
- **Rate limit**: 5000 transactions / 10 min → cache hard (`cacheTtlMs: 30*60*1000`).
- **CSV columns** differ by sensor, so **parse by header row, not by position**:
  - VIIRS: `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight`
  - MODIS: `…,brightness,…,bright_t31,frp,daynight` (note `brightness`/`bright_t31` instead of `bright_ti4/ti5`).
  - Always present + what we use: `latitude`, `longitude`, `acq_date`, `acq_time`,
    `confidence` (VIIRS: `l`/`n`/`h`; MODIS: 0–100), `frp` (fire radiative power MW),
    `daynight` (`D`/`N`), `satellite`.
- **Edge cases**: a bad key or error returns a non-CSV message; if the first line isn't a
  header containing `latitude,longitude`, return `[]`. Empty result = header row only.

### NASA EONET — v3 events (natural events tracker)
- **Format: JSON, no key.** URL: `https://eonet.gsfc.nasa.gov/api/v3/events`
- Params: `status=open`, `days=30`, `limit=50`, `bbox={W,N,E,S}` (see order below),
  optionally `category=`.
- **bbox order = upper-left `lon,lat` then lower-right `lon,lat`** = `minLon,maxLat,maxLon,minLat`
  (i.e. **W,N,E,S**). ⚠️ This is NOT the same order as FIRMS (`W,S,E,N`) — get it right.
- Event JSON: `{ id, title, description, link, closed, categories:[{id,title}],
  sources:[{id,url}], geometry:[{ date, type:'Point'|'Polygon', coordinates }] }`.
  - `geometry` is an **array** (an event can move). Use the **last** geometry entry.
  - `Point` → `coordinates = [lon, lat]`. `Polygon` → nested arrays; use the first ring's
    first vertex `coordinates[0][0] = [lon, lat]` (good enough for a marker), or skip if
    parsing is messy. **coordinates are [lon, lat]** (GeoJSON order).
  - `category` for display: `categories[0].title` (e.g. "Wildfires", "Volcanoes",
    "Severe Storms", "Sea and Lake Ice").

---

## 2. Phase 1 — implementation steps (live-only, no DB)

### 2.1 `server/src/config.js`
Add after `airnowApiKey`:
```js
firmsMapKey: process.env.FIRMS_MAP_KEY || '',
```

### 2.2 `.env` and `.env.example`
Add a line to each (value blank in `.env.example`):
```
# NASA FIRMS active-fire MAP_KEY (free: https://firms.modaps.eosdis.nasa.gov/api/map_key/)
FIRMS_MAP_KEY=
```

### 2.3 `server/src/lib/httpClient.js` — add `fetchText`
FIRMS is CSV, so add a text sibling to `fetchJson` (same timeout/retry/cache; `res.text()`
instead of `res.json()`; cache stores the string). Keep `fetchJson` untouched.
```js
export async function fetchText(url, opts = {}) {
  const { headers = {}, timeoutMs = 10000, retries = 2, cacheTtlMs = 0 } = opts;
  const cacheKey = cacheTtlMs > 0 ? `prr:txt:${url}::${JSON.stringify(headers)}` : null;
  if (cacheKey) { const c = await cacheGet(cacheKey); if (c !== undefined) return c; }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.retryable = res.status >= 500; throw e; }
      const text = await res.text();
      if (cacheKey) await cacheSet(cacheKey, text, cacheTtlMs);
      return text;
    } catch (err) {
      clearTimeout(timer); lastErr = err;
      if (err.retryable === false || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}
```

### 2.4 `server/src/services/nasaFirms.js` (NEW — mirror airnow's key gate + nifc's bbox)
```js
import { fetchText } from '../lib/httpClient.js';
import { haversineMiles } from '../lib/geo.js';
import { config } from '../config.js';

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const SOURCE = 'VIIRS_SNPP_NRT';
const DAY_RANGE = 2;

// FIRMS bbox is west,south,east,north (≈ radiusKm box around the point).
function bbox(lat, lon, radiusKm = 75) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(4)).join(',');
}

// Tiny CSV parser keyed by header (sensor columns vary). No dependency.
function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (!lines.length || !/latitude.*longitude/i.test(lines[0])) return []; // bad key/error/empty
  const cols = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const v = line.split(',');
    const row = {};
    cols.forEach((c, i) => (row[c] = v[i]));
    return row;
  });
}

/** Active fire detections near a point. Returns { configured, fires }. */
export async function getActiveFires(lat, lon, { radiusKm = 75, limit = 200 } = {}) {
  if (!config.firmsMapKey) return { configured: false, fires: [] };
  const url = `${BASE}/${config.firmsMapKey}/${SOURCE}/${bbox(lat, lon, radiusKm)}/${DAY_RANGE}`;
  const text = await fetchText(url, { cacheTtlMs: 30 * 60 * 1000 });
  const fires = parseCsv(text)
    .map((r) => ({
      lat: Number(r.latitude),
      lon: Number(r.longitude),
      confidence: r.confidence,                 // VIIRS l/n/h or MODIS 0-100
      frp: r.frp != null ? Number(r.frp) : null, // fire radiative power, MW
      acquired: r.acq_date ? `${r.acq_date}T${String(r.acq_time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z` : null,
      daynight: r.daynight,
      satellite: r.satellite,
      distanceMiles: haversineMiles(lat, lon, Number(r.latitude), Number(r.longitude)),
    }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
  return { configured: true, fires };
}
```
Notes: cap to nearest `limit` (fire season can return thousands → map perf). `acquired`
ISO build is best-effort; if it's fiddly, store `acq_date`/`acq_time` raw and format client-side.

### 2.5 `server/src/services/nasaEonet.js` (NEW — mirror nifc/quake keyless source)
```js
import { fetchJson } from '../lib/httpClient.js';
import { haversineMiles } from '../lib/geo.js';

const BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';

// EONET bbox is W,N,E,S (upper-left lon,lat then lower-right lon,lat).
function bbox(lat, lon, radiusKm = 200) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat + dLat, lon + dLon, lat - dLat].join(',');
}

function point(geometry) {
  const g = geometry?.[geometry.length - 1];
  if (!g) return [null, null];
  if (g.type === 'Point') return g.coordinates;            // [lon, lat]
  if (g.type === 'Polygon') return g.coordinates?.[0]?.[0] ?? [null, null];
  return [null, null];
}

/** Open natural events near a point. Returns an array. */
export async function getNaturalEvents(lat, lon, { radiusKm = 200, days = 30 } = {}) {
  const params = new URLSearchParams({ status: 'open', days: String(days), limit: '50', bbox: bbox(lat, lon, radiusKm) });
  const data = await fetchJson(`${BASE}?${params}`, { cacheTtlMs: 30 * 60 * 1000 });
  return (data?.events ?? [])
    .map((e) => {
      const [lon2, lat2] = point(e.geometry);
      const last = e.geometry?.[e.geometry.length - 1];
      return {
        id: e.id,
        title: e.title,
        category: e.categories?.[0]?.title ?? 'Event',
        time: last?.date ?? null,
        link: e.link ?? e.sources?.[0]?.url ?? null,
        lat: lat2, lon: lon2,
      };
    })
    .filter((e) => e.lat != null && e.lon != null);
}
```

### 2.6 `server/src/services/aggregate.js` — wire into the fan-out (APPEND ONLY)
1. Add imports:
   ```js
   import { getActiveFires } from './nasaFirms.js';
   import { getNaturalEvents } from './nasaEonet.js';
   ```
2. **Append** two entries to the destructure and the `Promise.allSettled([...])` array
   (after `getNearbyFacilities(lat, lon)`):
   ```js
   const [ …existing…, facilities, activeFires, naturalEvents ] = await Promise.allSettled([
     …existing…,
     getNearbyFacilities(lat, lon),
     getActiveFires(lat, lon),
     getNaturalEvents(lat, lon),
   ]);
   ```
3. **Append** to `sources`:
   ```js
   activeFires: settle(activeFires),
   naturalEvents: settle(naturalEvents),
   ```
4. **EONET only** into the timeline (sparse, dated, has coords). FIRMS is NOT added to the
   timeline (too many points — it's a map+card layer). Add a block in `buildTimeline`'s
   `({ alerts, disasters, wildfires, quakes })` signature → add `naturalEvents`:
   - Change call site: `timeline: buildTimeline({ alerts, disasters, wildfires, quakes, naturalEvents })`.
   - In `buildTimeline`, add (carrying lat/lon like fires/quakes already do):
   ```js
   if (naturalEvents.status === 'fulfilled') {
     for (const n of naturalEvents.value) {
       events.push({ type: 'natural', source: 'eonet', title: `${n.category}: ${n.title}`,
         time: n.time, lat: n.lat ?? null, lon: n.lon ?? null });
     }
   }
   ```
   Guard: `naturalEvents` may be `undefined` in older callers/tests → default it
   (`buildTimeline({ …, naturalEvents = { status: 'rejected' } })` or `?.status`).

### 2.7 Client `client/src/App.vue` — two new cards
- No new fetch state needed — both arrive in the main search under `s.activeFires` /
  `s.naturalEvents` (reactive, like weather/flood). Add cards near Wildfires.
- **Active Fires card** (FIRMS): key-gated like AQI.
  ```html
  <div class="card">
    <h3>Active Fire Detections (NASA FIRMS)</h3>
    <template v-if="s.activeFires?.ok">
      <p v-if="!s.activeFires.data.configured" class="source-error">Set FIRMS_MAP_KEY to enable.</p>
      <p v-else-if="!s.activeFires.data.fires.length" class="muted">No active detections nearby.</p>
      <template v-else>
        <p class="muted">{{ s.activeFires.data.fires.length }} detections (last 48 h) — nearest 8 shown</p>
        <div v-for="(f, i) in s.activeFires.data.fires.slice(0, 8)" :key="i" class="row row-click"
             role="button" tabindex="0" title="Show on map"
             @click="focusEvent(f)" @keydown.enter="focusEvent(f)">
          <span>{{ Math.round(f.distanceMiles) }} mi · {{ f.daynight === 'N' ? 'night' : 'day' }}</span>
          <span class="muted">{{ f.frp != null ? f.frp.toFixed(0) + ' MW' : '' }}</span>
        </div>
      </template>
    </template>
    <p v-else class="source-error">Source unavailable.</p>
  </div>
  ```
  (`focusEvent` already exists and flies the map + pulse for any `{lat, lon}`.)
- **Natural Events card** (EONET): keyless, array.
  ```html
  <div class="card">
    <h3>Natural Events (NASA EONET)</h3>
    <p v-if="s.naturalEvents?.ok && !s.naturalEvents.data.length" class="muted">None active nearby.</p>
    <p v-else-if="!s.naturalEvents?.ok" class="source-error">Source unavailable.</p>
    <div v-else v-for="(n, i) in s.naturalEvents.data.slice(0, 8)" :key="i" class="row row-click"
         role="button" tabindex="0" title="Show on map"
         @click="focusEvent(n)" @keydown.enter="focusEvent(n)">
      <span>{{ n.title }}<span class="muted"> · {{ n.category }}</span></span>
      <span class="muted">{{ fmtDate(n.time) }}</span>
    </div>
  </div>
  ```
- These also appear in the **Risk Timeline** automatically (EONET via the `natural` type).

### 2.8 Client `client/src/components/RiskMap.vue` — plot the markers
In the `watch` rebuild, after the existing source loops, add (do NOT extend `bounds` to
these — keep the map framed on location+EPA; far fires/events stay reachable by zoom):
```js
if (s.activeFires?.ok) {
  for (const f of s.activeFires.data.fires) addMarker(f.lon, f.lat, '#ff7847', 'Active fire detection', { size: 9 });
}
if (s.naturalEvents?.ok) {
  for (const n of s.naturalEvents.data) addMarker(n.lon, n.lat, '#e0b341', `${n.category}: ${n.title}`);
}
```
Colors: FIRMS = hot orange `#ff7847` (small, there can be many); EONET = amber `#e0b341`.
`s` here is `props.report.sources` (already in scope in the watch).

### 2.9 Tests
- **`server/test/helpers.js`** — extend `stubFetchJson` so the same stub serves `fetchText`:
  add `text: async () => (typeof json === 'string' ? json : JSON.stringify(json))` to the
  returned response object. (Non-breaking — existing tests only use `.json`.)
- **`server/test/services.test.js`** — add field-projection tests (distinct coords per test
  to avoid the URL-keyed cache bleed — see the helper's note):
  - FIRMS: stub a CSV string (`'latitude,longitude,confidence,frp,acq_date,acq_time,daynight,satellite\n33.5,-112.1,n,12.3,2026-06-29,2030,N,N'`) → assert `getActiveFires` returns
    `{ configured: true, fires: [{ lat: 33.5, lon: -112.1, … }] }`; and that with
    `config.firmsMapKey=''` it returns `{ configured: false, fires: [] }` (temporarily blank
    the env or test `parseCsv`/the guard — keep it simple).
  - EONET: stub `{ events: [{ id:'e1', title:'Big Fire', categories:[{title:'Wildfires'}], geometry:[{date:'2026-06-01T00:00:00Z', type:'Point', coordinates:[-112.1, 33.5]}], sources:[{url:'x'}] }] }`
    → assert `getNaturalEvents` maps `{ title:'Big Fire', category:'Wildfires', lat:33.5, lon:-112.1 }`.
- **`server/test/aggregate.test.js`** — update the `buildTimeline` calls to pass
  `naturalEvents` (or rely on the default guard), and add an assertion that a `natural`
  event carries lat/lon and lands in the timeline.
- Run: `cd server && REDIS_URL= AIRNOW_API_KEY=dummy node --test` and
  `cd client && npx vitest run && npx vite build`.

### 2.10 Docs
- **README.md** "Data sources" table — add two rows:
  | **NASA FIRMS** | active fire/thermal hotspots (satellite) | `firms.modaps.eosdis.nasa.gov/api/area/csv` | **yes (free MAP_KEY)** |
  | **NASA EONET** | active natural events (fires, storms, volcanoes…) | `eonet.gsfc.nasa.gov/api/v3/events` | no |
- **CLAUDE.md** (project root) — update "fans out to **9** sources" → **11**; add FIRMS/EONET
  to the source list; add `FIRMS_MAP_KEY` to the env mentions.

---

## 3. Verification checklist (run before declaring done)
- [ ] `npm test` at repo root — all green (server + client), no skips beyond DB-integration.
- [ ] `cd client && npx vite build` — compiles (App.vue/RiskMap.vue clean). Then `rm -rf dist`.
- [ ] Server reloaded (`touch server/src/index.js`; `node --watch` is flaky on WSL — verify
      against the live endpoint, not just tests).
- [ ] `curl '…/api/search?address=…'` → `sources.activeFires` (`{configured, fires}`) and
      `sources.naturalEvents` (array) present; a failure in either still returns the rest
      (resilience contract intact).
- [ ] Without `FIRMS_MAP_KEY`: Active Fires card shows "Set FIRMS_MAP_KEY"; everything else
      works. With the key: detections appear (try a fire-active region, e.g. a CA wildfire
      address — Phoenix may be 0).
- [ ] Map shows orange FIRMS dots + amber EONET markers; clicking a card row flies + pulses;
      `fitBounds` still frames location+EPA (not yanked out to a distant fire).
- [ ] Risk Timeline includes `natural` (EONET) events, clickable.

---

## 4. Decisions left open (pick at execution; defaults in brackets)
- FIRMS sensor [`VIIRS_SNPP_NRT`], day range [2], bbox radius [75 km], map cap [200].
- EONET bbox radius [200 km], days [30], whether to filter to certain categories [all].
- Card placement order in the sidebar [Active Fires after Wildfires; Natural Events after that].
- Whether Active Fires gets a radius/count selector like wildfires/EPA [defer — not in v1].

## 5. Phase 2 (OPTIONAL, later — do NOT do in Phase 1)
Persist EONET events into `risk_events` (they have `source='eonet'`, a stable `id`, coords,
date) so they survive in `/api/events` history like quakes/fires. Requires extending
`persist.js upsertRiskEvents` (add an `eonet` block, mirror the quake block) — additive,
but it touches the DB write path, so keep it a separate, separately-tested change. FIRMS
detections are high-volume + ephemeral → **do not persist**; keep live-only.

## 6. Risk / rollback notes
- Each new file is independent; the only edits to existing files are **append-only**
  (config, aggregate fan-out/sources/timeline, RiskMap loops, App cards, helpers `text:`,
  README/CLAUDE). To roll back, delete the two services + revert those appends.
- The biggest "gotcha" is the **bbox coordinate-order difference** (FIRMS `W,S,E,N` vs
  EONET `W,N,E,S`) — wrong order silently returns no/garbage results. Verify each against a
  known-active region during testing.
- FIRMS CSV columns vary by sensor — **parse by header**, never by fixed index.
- Keep `cacheTtlMs` high (30 min) on both — FIRMS has a hard transaction cap.
