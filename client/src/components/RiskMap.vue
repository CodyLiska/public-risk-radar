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

// Free OpenStreetMap raster basemap — no API key required.
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

// Phoenix as the default view center.
const DEFAULT_CENTER = [-112.074, 33.4484];

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

function addMarker(lon, lat, color, label, { size = 14, onTop = false } = {}) {
  if (lon == null || lat == null) return;
  const el = document.createElement('div');
  const border = onTop ? 3 : 2;
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border}px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:pointer`;
  if (onTop) el.style.zIndex = '2';
  const marker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .setPopup(new maplibregl.Popup({ offset: 12 }).setText(label))
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
      addMarker(f.lon, f.lat, '#ffb454', `EPA: ${f.name}`);
      if (f.lon != null && f.lat != null) bounds.extend([f.lon, f.lat]);
    }
    if (s.wildfires?.ok) {
      for (const w of s.wildfires.data) {
        addMarker(w.lon, w.lat, '#ff5d5d', `Fire: ${w.name}`);
        if (w.lon != null && w.lat != null) bounds.extend([w.lon, w.lat]);
      }
    }
    if (s.waterGauges?.ok) {
      for (const g of s.waterGauges.data) addMarker(g.lon, g.lat, '#4fd18b', `Gauge: ${g.name}`, { size: 16 });
    }
    if (s.earthquakes?.ok) {
      for (const q of s.earthquakes.data) addMarker(q.lon, q.lat, '#b07cff', `M${q.magnitude} ${q.place}`);
    }

    // Searched location last + larger so it sits on top of the dense EPA cluster.
    addMarker(lon, lat, '#4f9dff', report.location.matchedAddress || 'Searched location', {
      size: 20,
      onTop: true,
    });

    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
  },
);
</script>

<template>
  <div ref="mapEl" id="map"></div>
</template>
