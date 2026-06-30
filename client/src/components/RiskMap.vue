<script setup>
import { onMounted, ref, watch } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const props = defineProps({
  report: { type: Object, default: null },
  // EPA facilities to plot — controlled by the card's radius dropdown, so the
  // map reflects the selection (overrides the report's fixed 5-mi set).
  epaFacilities: { type: Array, default: () => [] },
});

const mapEl = ref(null);
let map = null;
let markers = [];

const STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const DEFAULT_CENTER = [-112.074, 33.4484];

// ── marker design ───────────────────────────────────────────────────────────
// Per-layer color (separated, roughly colorblind-aware — the two fire layers
// stay warm but are split by icon/shape). Tune here; the legend reads the same map.
const C = {
  location: '#1d4ed8',
  epa: '#0d9488',
  wildfire: '#dc2626',
  firms: '#f59e0b',
  gauge: '#0891b2',
  quake: '#9333ea',
  eonet: '#475569',
};

const GLYPHS = {
  location: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  epa: '<path d="M4 21V10l5 3V10l5 3V5h3v16z"/><path d="M8 21v-3M13 21v-3"/>',
  wildfire: '<path d="M12 3c2.2 3.6 4.6 5 4.6 8.4A4.6 4.6 0 017.4 12c0-1.6.8-2.7 1.8-3.6.4 1.6 1.5 2 2.3 1.3.6-.9-.4-3.6.5-6.7z"/>',
  gauge: '<path d="M12 3c3.6 5.4 5.4 7.4 5.4 10A5.4 5.4 0 016.6 13c0-2.6 1.8-4.6 5.4-10z"/>',
  quake: '<path d="M2 12h3l2-6 3 13 3-10 2 5 1-2h3"/>',
  storm: '<path d="M7 15a4 4 0 01.4-8 5 5 0 019.2 1.2A3.4 3.4 0 0117 15"/><path d="M12 13l-2 4h3l-2 4"/>',
  volcano: '<path d="M4 20l5-8 2 2 2-3 3 5 4 4z"/><path d="M9 7l1.2-3 1 2 1.8-2"/>',
  ice: '<path d="M12 2v20M3 7l18 10M21 7L3 17"/><path d="M12 6l-2.2-2M12 6l2.2-2M12 18l-2.2 2M12 18l2.2 2"/>',
  event: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
};

// EONET category title → glyph (falls back to a generic event glyph).
const EONET_GLYPH = {
  Wildfires: 'wildfire',
  'Severe Storms': 'storm',
  Volcanoes: 'volcano',
  'Sea and Lake Ice': 'ice',
};
const eonetGlyph = (cat) => EONET_GLYPH[cat] || 'event';

function glyphSvg(name, px, stroke = '#fff', sw = 2.2) {
  return `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`;
}

function pinHTML(color, glyph, s) {
  const h = s * 1.3;
  const headY = h * (14 / 39); // head circle center within the 0..39 viewBox
  return `<div style="position:relative;width:${s}px;height:${h}px">
    <svg width="${s}" height="${h}" viewBox="0 0 30 39"><path d="M15 38C7 27 2 22 2 14a13 13 0 0126 0c0 8-5 13-13 24z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="14" r="9" fill="#fff"/></svg>
    <span style="position:absolute;left:50%;top:${headY}px;transform:translate(-50%,-50%);display:flex">${glyphSvg(glyph, s * 0.5, color, 2.2)}</span>
  </div>`;
}

function badgeHTML(color, glyph, d) {
  return `<div style="width:${d}px;height:${d}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center">${glyph ? glyphSvg(glyph, d * 0.56) : ''}</div>`;
}

// Bare dot — FIRMS is a high-volume density layer, so individual identity matters
// less; keeping it a plain dot avoids clutter and stays cheap at hundreds of points.
function dotHTML(color, d) {
  return `<div style="width:${d}px;height:${d}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5)"></div>`;
}

function locHTML(color, d) {
  return `<div style="position:relative;width:${d}px;height:${d}px;display:flex;align-items:center;justify-content:center">
    <span class="prr-loc-ring" style="border-color:${color}"></span>
    ${badgeHTML(color, 'location', d)}
  </div>`;
}

// ── legend (renders the same builders at swatch scale) ────────────────────────
const legendOpen = ref(true);
function swatchHTML({ kind, color, glyph }) {
  if (kind === 'pin') return pinHTML(color, glyph, 18);
  if (kind === 'dot') return dotHTML(color, 12);
  return badgeHTML(color, glyph, 20); // 'badge' and 'loc' (static, no pulse)
}
const legendBase = [
  { label: 'Searched location', kind: 'badge', color: C.location, glyph: 'location' },
  { label: 'EPA facility', kind: 'pin', color: C.epa, glyph: 'epa' },
  { label: 'Wildfire (NIFC)', kind: 'badge', color: C.wildfire, glyph: 'wildfire' },
  { label: 'Active fire (FIRMS)', kind: 'dot', color: C.firms, glyph: null },
  { label: 'Water gauge (USGS)', kind: 'badge', color: C.gauge, glyph: 'gauge' },
  { label: 'Earthquake (USGS)', kind: 'badge', color: C.quake, glyph: 'quake' },
].map((i) => ({ label: i.label, swatch: swatchHTML(i) }));
const legendEonet = [
  { label: 'Wildfire', glyph: 'wildfire' },
  { label: 'Severe storm', glyph: 'storm' },
  { label: 'Volcano', glyph: 'volcano' },
  { label: 'Sea / lake ice', glyph: 'ice' },
].map((i) => ({ label: i.label, swatch: swatchHTML({ kind: 'badge', color: C.eonet, glyph: i.glyph }) }));

onMounted(() => {
  map = new maplibregl.Map({
    container: mapEl.value,
    style: STYLE,
    center: DEFAULT_CENTER,
    zoom: 9,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
});

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

// Place a pre-built marker element on the map. `anchor: 'bottom'` puts a pin's
// tail tip on the coordinate; badges/dots stay centered.
function placeMarker(lon, lat, html, { anchor = 'center', label = '', onTop = false } = {}) {
  if (lon == null || lat == null) return;
  const el = document.createElement('div');
  el.style.cursor = 'pointer';
  if (onTop) el.style.zIndex = '2';
  el.innerHTML = html;
  const marker = new maplibregl.Marker({ element: el, anchor })
    .setLngLat([lon, lat])
    .setPopup(new maplibregl.Popup({ offset: 14 }).setText(label))
    .addTo(map);
  markers.push(marker);
}

// A short-lived pulsing ring at a point so the eye can find it after the map
// moves. Only one pulse at a time.
let pulseMarker = null;
function pulseAt(lat, lon) {
  if (!map || lat == null || lon == null) return;
  if (pulseMarker) pulseMarker.remove();
  const el = document.createElement('div');
  el.className = 'map-pulse';
  pulseMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  const m = pulseMarker;
  setTimeout(() => {
    m.remove();
    if (pulseMarker === m) pulseMarker = null;
  }, 1900);
}

// Reusable "focus a point" API for the sidebar cards (e.g. click a water gauge
// or disaster row to move the map there). Exposed via the component ref.
function flyTo(lat, lon, { zoom = 12 } = {}) {
  if (!map || lat == null || lon == null) return;
  map.flyTo({ center: [lon, lat], zoom, duration: 800 });
  pulseAt(lat, lon);
}
defineExpose({ flyTo });

watch(
  [() => props.report, () => props.epaFacilities],
  ([report]) => {
    if (!map || !report?.location) return;
    clearMarkers();

    const { lat, lon } = report.location;
    const s = report.sources;

    // Frame the searched address plus its immediate (EPA) surroundings. Far-flung
    // markers — water gauges (~8-20mi) and quakes (~60mi+) — are intentionally left
    // out of the bounds so a single distant outlier can't force the whole view to
    // zoom out and shrink the meaningful cluster. They stay reachable by zooming out.
    const bounds = new maplibregl.LngLatBounds([lon, lat], [lon, lat]);
    // EPA markers come from the prop (the card's radius selection), not the report.
    for (const f of props.epaFacilities) {
      placeMarker(f.lon, f.lat, pinHTML(C.epa, 'epa', 32), { anchor: 'bottom', label: `EPA: ${f.name}` });
      if (f.lon != null && f.lat != null) bounds.extend([f.lon, f.lat]);
    }
    if (s.wildfires?.ok) {
      for (const w of s.wildfires.data) {
        placeMarker(w.lon, w.lat, badgeHTML(C.wildfire, 'wildfire', 30), { label: `Fire: ${w.name}` });
        if (w.lon != null && w.lat != null) bounds.extend([w.lon, w.lat]);
      }
    }
    if (s.waterGauges?.ok) {
      for (const g of s.waterGauges.data) placeMarker(g.lon, g.lat, badgeHTML(C.gauge, 'gauge', 30), { label: `Gauge: ${g.name}` });
    }
    if (s.earthquakes?.ok) {
      for (const q of s.earthquakes.data) placeMarker(q.lon, q.lat, badgeHTML(C.quake, 'quake', 30), { label: `M${q.magnitude} ${q.place}` });
    }
    // FIRMS + EONET are intentionally left out of `bounds` (like gauges/quakes) —
    // a distant active fire shouldn't yank the view off the searched location.
    if (s.activeFires?.ok) {
      for (const f of s.activeFires.data.fires) placeMarker(f.lon, f.lat, dotHTML(C.firms, 10), { label: 'Active fire detection' });
    }
    if (s.naturalEvents?.ok) {
      for (const n of s.naturalEvents.data) placeMarker(n.lon, n.lat, badgeHTML(C.eonet, eonetGlyph(n.category), 30), { label: `${n.category}: ${n.title}` });
    }

    // Searched location last + on top so it sits above the dense EPA cluster.
    placeMarker(lon, lat, locHTML(C.location, 38), {
      label: report.location.matchedAddress || 'Searched location',
      onTop: true,
    });

    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
  },
);
</script>

<template>
  <div ref="mapEl" id="map"></div>
  <div class="map-legend">
    <button
      class="map-legend__toggle"
      :aria-expanded="legendOpen"
      @click="legendOpen = !legendOpen"
    >
      <span>Legend</span>
      <span aria-hidden="true">{{ legendOpen ? '▾' : '▸' }}</span>
    </button>
    <div v-show="legendOpen" class="map-legend__body">
      <div v-for="item in legendBase" :key="item.label" class="map-legend__row">
        <span class="map-legend__sw" v-html="item.swatch"></span>
        <span>{{ item.label }}</span>
      </div>
      <div class="map-legend__group">
        <p class="map-legend__ghead">NASA EONET — by category</p>
        <div v-for="item in legendEonet" :key="item.label" class="map-legend__row">
          <span class="map-legend__sw" v-html="item.swatch"></span>
          <span>{{ item.label }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 2;
  max-width: 210px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  color: var(--text);
  font-size: 12px;
  overflow: hidden;
}
.map-legend__toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  color: var(--muted);
  font: inherit;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.map-legend__body { padding: 2px 12px 10px; }
.map-legend__row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.map-legend__sw { width: 24px; display: flex; align-items: center; justify-content: center; }
.map-legend__group { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
.map-legend__ghead { margin: 0 0 2px; font-size: 10px; color: var(--muted); }
</style>
