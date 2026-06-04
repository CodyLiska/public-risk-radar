# Plan — UI fixes from the screenshot review

Source: live-app screenshot of a search for *1700 W Washington St, Phoenix, AZ 85007*.
Three findings, ordered by priority. Each has a verify step, the change, the file,
and why.

---

## 1. Map markers / fly-to not visible  ⚠️ VERIFY FIRST

**Symptom:** After a search the map stayed metro-wide and showed no markers — no
blue location pin, no orange EPA dots, no green gauge / purple quake dots.

**Expected (per `client/src/components/RiskMap.vue`):**
- `:64` `map.flyTo({ center: [lon, lat], zoom: 11 })`
- `:65` blue marker at the searched location
- `:68-79` orange EPA facilities, red wildfires, green water gauges, purple quakes

### Step 1 — confirm it's actually broken
- Open the app, search, open the browser **console**. Look for MapLibre errors.
- Zoom in over downtown Phoenix — if dots appear, it's only a scale issue (markers
  too small on a large viewport) and the only change needed is **fit-to-bounds**
  (see Step 2b). If still nothing, it's a real bug → Step 2a.
- Tell-tale: the **blue location marker** uses `report.location.lat/lon`, which are
  always present. If even that is missing, the `watch`/marker code isn't running →
  real bug.

### Step 2a — fix (if broken): run marker/fly-to logic only after the style loads
The `watch` (`RiskMap.vue:57`) can fire before MapLibre finishes loading the style,
making `flyTo`/markers no-op. Guard it:

- Extract the marker/fly-to body of the `watch` into a `renderReport(report)` fn.
- In the watcher: if `map.isStyleLoaded()` call `renderReport` immediately, else
  `map.once('load', () => renderReport(report))`.
- Also handle the case where a `report` prop already exists when the component
  mounts (run `renderReport` once in `onMounted` after creating the map, guarded the
  same way). Today report is always null at mount, but this makes it robust.

### Step 2b — improvement (regardless): fit bounds to all markers
Instead of a fixed `zoom: 11`, build a `LngLatBounds` from the location + all marker
coords and call `map.fitBounds(bounds, { padding: 60, maxZoom: 13 })`. This frames
the searched point *and* its nearby facilities/gauges correctly regardless of
viewport size — and would resolve the "looks zoomed out" complaint even if markers
were technically present.

### Verify
- Search → blue pin sits on the address, EPA dots cluster near it, map framed to fit.
- Click a marker → popup shows the label.

---

## 2. Weather-alert severity badge is always red

**Where:** `client/src/App.vue`, the "Active Weather Alerts" card. The badge is
hardcoded:
```html
<span class="badge danger">{{ a.severity }}</span>
```

**Why it matters:** NWS returned `severity: "Unknown"` for this air-quality alert, so
it renders red — implying severe when it's informational.

**Change:** add a `severityClass(severity)` helper (put it in
`client/src/lib/format.js` so it's unit-tested alongside `aqiClass`) and bind it:
```js
export function severityClass(severity) {
  switch ((severity || '').toLowerCase()) {
    case 'extreme':
    case 'severe':   return 'danger';
    case 'moderate': return 'warn';
    case 'minor':    return 'ok';
    default:         return 'muted'; // Unknown / null → neutral grey
  }
}
```
```html
<span class="badge" :class="severityClass(a.severity)">{{ a.severity }}</span>
```
Badge classes already exist in `client/src/style.css` (`danger/warn/ok/muted`).

**Test:** add cases to `client/test/format.test.js` for severityClass
(Severe→danger, Moderate→warn, Unknown→muted, ''→muted).

---

## 3. Risk Timeline vs Saved Events Nearby are near-duplicates

**Where:** the two cards near the bottom of `client/src/App.vue` — the live
`report.timeline` and `savedEvents` (from `/api/events`).

**Why it matters:** for a single search they list the same events, so the second
card looks redundant. Its real value (events accumulated across *other* nearby past
searches, spatially joined via PostGIS) only shows once multiple distinct locations
have been searched.

**Options (pick one):**
- **A (low effort, recommended):** keep both but sharpen the framing. Retitle Saved
  Events to make the cumulative/historical nature obvious, and only render the card
  when it contains events **not** already in the live timeline (diff by
  `source_id`/title); otherwise hide it. Avoids the duplicate look while preserving
  the feature.
- **B:** merge into one "Timeline" card with a toggle: *This search* (live) vs
  *Saved nearby* (DB). One card, clear distinction.
- **C:** drop the Saved Events card from the per-search view entirely and surface
  `/api/events` elsewhere (e.g. a future "area history" view). Simplest UI, but
  hides the persistence payoff we just built.

Recommendation: **A** now; revisit B if an area-history view gets built.

---

## Suggested commit order
1. (verify map) → map fix `RiskMap.vue` + fitBounds.
2. severityClass in `format.js` + App.vue binding + test.
3. timeline/saved-events option A.

Run `npm test` (root) after each; client tests cover `format.js` additions.
