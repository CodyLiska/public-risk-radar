<script setup>
import { onMounted, ref, watch } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const props = defineProps({
  report: { type: Object, default: null },
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

watch(
  () => props.report,
  (report) => {
    if (!map || !report?.location) return;
    clearMarkers();

    const { lat, lon } = report.location;
    const s = report.sources;

    // Frame the searched address plus its immediate (EPA) surroundings. Far-flung
    // markers — water gauges (~8-20mi) and quakes (~60mi+) — are intentionally left
    // out of the bounds so a single distant outlier can't force the whole view to
    // zoom out and shrink the meaningful cluster. They stay reachable by zooming out.
    const bounds = new maplibregl.LngLatBounds([lon, lat], [lon, lat]);
    if (s.epaFacilities?.ok) {
      for (const f of s.epaFacilities.data) {
        addMarker(f.lon, f.lat, '#ffb454', `EPA: ${f.name}`);
        if (f.lon != null && f.lat != null) bounds.extend([f.lon, f.lat]);
      }
    }
    if (s.wildfires?.ok) {
      for (const w of s.wildfires.data) {
        addMarker(w.lon, w.lat, '#ff5d5d', `Fire: ${w.name}`);
        if (w.lon != null && w.lat != null) bounds.extend([w.lon, w.lat]);
      }
    }
    if (s.waterGauges?.ok) {
      for (const g of s.waterGauges.data) addMarker(g.lon, g.lat, '#4fd18b', `Gauge: ${g.name}`);
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
