<script setup>
import { ref, computed, onMounted } from 'vue';
import { searchAddress, getHistory, getEvents, getWildfires } from './api.js';
import { fmtDate, fmtMonthDayYear, fmtRelative, severityClass, topObservation, dedupeRecentSearches, groupGaugesBySite, summarizeDisasterTypes, disasterColor, titleCase, aqiScale, AQI_BANDS, FLOOD_RISK } from './lib/format.js';
import RiskMap from './components/RiskMap.vue';

const address = ref('');
const report = ref(null);
const loading = ref(false);
const error = ref('');
const history = ref([]);
const savedEvents = ref([]);
const mapRef = ref(null); // RiskMap component ref — used to fly the map to a card row

function focusGauge(g) {
  if (g.lat != null && g.lon != null) mapRef.value?.flyTo(g.lat, g.lon);
}

// Wildfire card
const wildfireRadius = ref(25);
const wildfires = ref([]);
const wildfiresOk = ref(true);
const wildfiresLoading = ref(false);

// EPA card
const epaCount = ref(10);
const epaTotal = computed(() => (s.value.epaFacilities?.ok ? s.value.epaFacilities.data.total : 0));
const epaOk = computed(() => !!s.value.epaFacilities?.ok);
const epaShown = computed(() =>
  s.value.epaFacilities?.ok ? s.value.epaFacilities.data.facilities.slice(0, epaCount.value) : [],
);

function focusFacility(f) {
  if (f.lat != null && f.lon != null) mapRef.value?.flyTo(f.lat, f.lon);
}

// Timeline rows with a point (fires/quakes) fly the map there; alerts/disasters
// have no coordinates and stay non-clickable.
function focusEvent(e) {
  if (e.lat != null && e.lon != null) mapRef.value?.flyTo(e.lat, e.lon);
}

async function onSearch() {
  if (!address.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    report.value = await searchAddress(address.value);
    // Refresh the persisted views now that this search has been stored.
    loadHistory();
    loadSavedEvents();
    wildfireRadius.value = 25;
    loadWildfires();
    disasterType.value = 'all'; // reset the filter for the new county
  } catch (e) {
    error.value = e.message;
    report.value = null;
  } finally {
    loading.value = false;
  }
}

function fireMeta(w) {
  const parts = [];
  if (w.distanceMiles != null) parts.push(Math.round(w.distanceMiles) + ' mi');
  if (w.acres) parts.push(Math.round(w.acres) + ' ac');
  return parts.join(' · ') || '—';
}

// Fetch wildfires for the current location at the selected radius. The initial
// 25-mi call reuses the upstream Redis cache the report already warmed.
async function loadWildfires() {
  const loc = report.value?.location;
  if (!loc) return;
  wildfiresLoading.value = true;
  try {
    const res = await getWildfires(loc.lat, loc.lon, wildfireRadius.value);
    wildfires.value = res.wildfires;
    wildfiresOk.value = true;
  } catch {
    wildfires.value = [];
    wildfiresOk.value = false;
  } finally {
    wildfiresLoading.value = false;
  }
}

// ── persisted read-backs (best-effort: never block or break the page) ─────────
async function loadHistory() {
  try {
    history.value = (await getHistory()).locations;
  } catch {
    history.value = [];
  }
}

async function loadSavedEvents() {
  const loc = report.value?.location;
  if (!loc) return;
  try {
    savedEvents.value = (await getEvents(loc.lat, loc.lon, 50)).events;
  } catch {
    savedEvents.value = [];
  }
}

function runFromHistory(item) {
  address.value = item.address;
  // Move the map to the known location immediately (history rows carry lat/lon)
  // so the click feels instant — the full live report can take several seconds
  // for an uncached address, and we don't want the map to wait on it.
  if (item.lat != null && item.lon != null) mapRef.value?.flyTo(item.lat, item.lon);
  onSearch();
}

const recentSearches = computed(() => dedupeRecentSearches(history.value));

onMounted(loadHistory);

const s = computed(() => report.value?.sources ?? {});

// One row per physical gauge (USGS reports discharge + gage height separately).
const waterGauges = computed(() =>
  s.value.waterGauges?.ok ? groupGaugesBySite(s.value.waterGauges.data) : [],
);

// Disaster-type profile over the full history (the recent-8 list alone is
// skewed — e.g. all fires — so the summary shows the true risk mix).
const disasterSummary = computed(() =>
  s.value.disasterHistory?.ok
    ? summarizeDisasterTypes(s.value.disasterHistory.data)
    : { total: 0, byType: [] },
);

// Disaster card
const disasterType = ref('all');
const disastersShown = computed(() => {
  if (!s.value.disasterHistory?.ok) return [];
  const all = s.value.disasterHistory.data;
  const filtered = disasterType.value === 'all' ? all : all.filter((d) => d.incidentType === disasterType.value);
  return filtered.slice(0, 12);
});

// Saved events that the live timeline doesn't already show. For a single search the
// two lists overlap heavily; this card only earns its place once nearby *past*
// searches have accumulated events the current report doesn't include.
const eventKey = (type, title) => `${type}|${title}`;
const newSavedEvents = computed(() => {
  const live = new Set((report.value?.timeline ?? []).map((e) => eventKey(e.type, e.title)));
  return savedEvents.value.filter((e) => !live.has(eventKey(e.type, e.title)));
});

const topAqi = computed(() =>
  topObservation(s.value.airQuality?.ok ? s.value.airQuality.data.observations : []),
);

const aqiInfo = computed(() => (topAqi.value ? aqiScale(topAqi.value.aqi) : null));

const aqiObs = computed(() => {
  const obs = s.value.airQuality?.ok ? s.value.airQuality.data.observations : [];
  return obs.map((o) => ({
    parameter: o.parameter,
    aqi: o.aqi,
    color: aqiScale(o.aqi)?.band.color ?? 'var(--muted)',
    dominant: topAqi.value?.parameter === o.parameter,
  }));
});

const floodRisk = computed(() => {
  const level = s.value.floodZone?.ok ? s.value.floodZone.data.riskLevel : null;
  return FLOOD_RISK[level] ?? FLOOD_RISK.undetermined;
});

// Static AQI ribbon gradient.
const AQI_RIBBON = `linear-gradient(to right, ${AQI_BANDS
  .map((b, i) => `${b.color} ${((i / AQI_BANDS.length) * 100).toFixed(2)}%, ${b.color} ${(((i + 1) / AQI_BANDS.length) * 100).toFixed(2)}%`)
  .join(', ')})`;
</script>

<template>
  <div class="app">
    <header>
      <h1>🛰️ Public Risk Radar</h1>
      <p>Public risk data near any U.S. address — weather, air, flood, fire, water, quakes & EPA facilities.</p>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div class="searchbar">
          <input
            v-model="address"
            placeholder="Enter an address or ZIP (e.g. Phoenix, AZ)"
            @keyup.enter="onSearch"
          />
          <button :disabled="loading" @click="onSearch">
            {{ loading ? '…' : 'Search' }}
          </button>
        </div>

        <p v-if="error" class="error">{{ error }}</p>

        <!-- Recent searches (persisted) -->
        <div v-if="recentSearches.length" class="card recent">
          <h3>Recent Searches</h3>
          <button
            v-for="loc in recentSearches"
            :key="loc.id"
            class="recent-item"
            @click="runFromHistory(loc)"
          >
            <span class="recent-addr">{{ loc.address }}</span>
            <span class="muted">{{ fmtRelative(loc.created_at) }}</span>
          </button>
        </div>

        <template v-if="report">
          <div class="card">
            <h3>Location</h3>
            <div class="big">{{ report.location.matchedAddress || address }}</div>
            <div class="muted" style="margin-top:4px">
              {{ report.location.county }} · {{ report.location.lat.toFixed(4) }}, {{ report.location.lon.toFixed(4) }}
            </div>
          </div>

          <!-- Weather alerts -->
          <div class="card">
            <h3>Active Weather Alerts</h3>
            <p v-if="s.weatherAlerts?.ok && !s.weatherAlerts.data.length" class="muted">No active alerts.</p>
            <p v-else-if="!s.weatherAlerts?.ok" class="source-error">Source unavailable.</p>
            <div v-else v-for="a in s.weatherAlerts.data" :key="a.id" class="row">
              <span>{{ a.event }}</span>
              <span class="badge" :class="severityClass(a.severity)">{{ a.severity }}</span>
            </div>
          </div>

          <!-- Air quality -->
          <div class="card">
            <h3>Air Quality (AQI)</h3>
            <template v-if="s.airQuality?.ok">
              <p v-if="!s.airQuality.data.configured" class="source-error">Set AIRNOW_API_KEY to enable.</p>
              <template v-else-if="topAqi && aqiInfo">
                <div class="aqi-headline">
                  <span class="aqi-value" :style="{ color: aqiInfo.band.color }">{{ topAqi.aqi }}</span>
                  <div>
                    <div class="aqi-category">{{ aqiInfo.band.name }}</div>
                    <div class="muted aqi-meta">{{ topAqi.reportingArea }} · {{ fmtRelative(topAqi.observedAt) }}</div>
                  </div>
                </div>
                <p class="aqi-guidance">{{ aqiInfo.band.guidance }}</p>
                <div class="aqi-ribbon" role="img" :aria-label="'AQI ' + topAqi.aqi + ', ' + aqiInfo.band.name">
                  <div class="aqi-ribbon-track" :style="{ background: AQI_RIBBON }"></div>
                  <div class="aqi-marker" :style="{ left: aqiInfo.markerPct + '%' }"></div>
                </div>
                <div class="aqi-axis">
                  <span>0</span><span>50</span><span>100</span><span>150</span><span>200</span><span>300</span><span>500</span>
                </div>
                <div class="aqi-chips">
                  <span v-for="o in aqiObs" :key="o.parameter" class="aqi-chip" :class="{ dominant: o.dominant }">
                    <span class="aqi-dot" :style="{ background: o.color }"></span>{{ o.parameter }} {{ o.aqi }}
                  </span>
                </div>
              </template>
              <p v-else class="muted">No nearby observations.</p>
            </template>
            <p v-else class="source-error">Source unavailable.</p>
          </div>

          <!-- Flood zone -->
          <div class="card">
            <h3>Flood Zone (FEMA NFHL)</h3>
            <template v-if="s.floodZone?.ok">
              <template v-if="s.floodZone.data.inMappedArea">
                <div class="flood-head">
                  <span class="flood-label"><span class="flood-dot" :class="floodRisk.tone"></span>{{ floodRisk.label }}</span>
                  <span class="muted flood-code">Zone {{ s.floodZone.data.floodZone }}</span>
                </div>
                <p class="flood-blurb">{{ floodRisk.blurb }}</p>
              </template>
              <p v-else class="muted">Not in a mapped flood hazard area.</p>
            </template>
            <p v-else class="source-error">Source unavailable.</p>
          </div>

          <!-- Wildfires -->
          <div class="card">
            <div class="card-head">
              <h3>Nearby Wildfires</h3>
              <select v-model.number="wildfireRadius" @change="loadWildfires" class="radius-select" aria-label="Search radius">
                <option :value="25">Within 25 miles</option>
                <option :value="50">Within 50 miles</option>
                <option :value="100">Within 100 miles</option>
              </select>
            </div>
            <p v-if="wildfiresLoading" class="muted">Loading…</p>
            <p v-else-if="!wildfiresOk" class="source-error">Source unavailable.</p>
            <p v-else-if="!wildfires.length" class="muted">None within {{ wildfireRadius }} miles.</p>
            <div v-else v-for="w in wildfires" :key="w.name + (w.discovered || '')" class="row">
              <span>{{ w.name }}</span>
              <span class="muted">{{ fireMeta(w) }}</span>
            </div>
          </div>

          <!-- Active fire detections (NASA FIRMS) — key-gated like AQI -->
          <div class="card">
            <h3>Active Fire Detections (NASA FIRMS)</h3>
            <template v-if="s.activeFires?.ok">
              <p v-if="!s.activeFires.data.configured" class="muted">Set FIRMS_MAP_KEY to enable.</p>
              <p v-else-if="!s.activeFires.data.fires.length" class="muted">No active detections nearby.</p>
              <template v-else>
                <p class="muted">{{ s.activeFires.data.fires.length }} detections (last 48 h) — nearest 8 shown</p>
                <div
                  v-for="(f, i) in s.activeFires.data.fires.slice(0, 8)"
                  :key="i"
                  class="row row-click"
                  role="button"
                  tabindex="0"
                  title="Show on map"
                  @click="focusEvent(f)"
                  @keydown.enter="focusEvent(f)"
                >
                  <span>{{ Math.round(f.distanceMiles) }} mi · {{ f.daynight === 'N' ? 'night' : 'day' }}</span>
                  <span class="muted">{{ f.frp != null ? f.frp.toFixed(0) + ' MW' : '' }}</span>
                </div>
              </template>
            </template>
            <p v-else class="source-error">Source unavailable.</p>
          </div>

          <!-- Natural events (NASA EONET) — keyless array -->
          <div class="card">
            <h3>Natural Events (NASA EONET)</h3>
            <p v-if="s.naturalEvents?.ok && !s.naturalEvents.data.length" class="muted">None active nearby.</p>
            <p v-else-if="!s.naturalEvents?.ok" class="source-error">Source unavailable.</p>
            <div
              v-else
              v-for="(n, i) in s.naturalEvents.data.slice(0, 8)"
              :key="i"
              class="row row-click"
              role="button"
              tabindex="0"
              title="Show on map"
              @click="focusEvent(n)"
              @keydown.enter="focusEvent(n)"
            >
              <span>{{ n.title }}<span class="muted"> · {{ n.category }}</span></span>
              <span class="muted">{{ fmtDate(n.time) }}</span>
            </div>
          </div>

          <!-- Water gauges -->
          <div class="card">
            <h3>Water Gauges (USGS)</h3>
            <p v-if="s.waterGauges?.ok && !s.waterGauges.data.length" class="muted">No active gauges nearby.</p>
            <p v-else-if="!s.waterGauges?.ok" class="source-error">Source unavailable.</p>
            <div
              v-else
              v-for="g in waterGauges"
              :key="g.siteId"
              class="row"
              :class="{ 'row-click': g.lat != null && g.lon != null }"
              role="button"
              tabindex="0"
              :title="g.lat != null ? 'Show on map' : ''"
              @click="focusGauge(g)"
              @keydown.enter="focusGauge(g)"
            >
              <span>{{ g.name }}</span>
              <span class="muted">{{ g.readings.map((r) => (r.value ?? '—') + ' ' + r.parameter).join(' · ') }}</span>
            </div>
          </div>

          <!-- EPA facilities -->
          <div class="card">
            <div class="card-head">
              <h3>Nearby EPA Facilities</h3>
              <select v-model.number="epaCount" class="radius-select" aria-label="Number to show">
                <option :value="10">Nearest 10</option>
                <option :value="25">Nearest 25</option>
                <option :value="50">Nearest 50</option>
                <option :value="100">Nearest 100</option>
              </select>
            </div>
            <p v-if="!epaOk" class="source-error">Source unavailable.</p>
            <p v-else-if="!epaTotal" class="muted">None within 5 miles.</p>
            <template v-else>
              <p class="muted">{{ epaTotal }} within 5 miles — showing nearest {{ epaShown.length }}</p>
              <div
                v-for="f in epaShown"
                :key="f.registryId"
                class="row"
                :class="{ 'row-click': f.lat != null && f.lon != null }"
                role="button"
                tabindex="0"
                :title="f.lat != null ? 'Show on map' : ''"
                @click="focusFacility(f)"
                @keydown.enter="focusFacility(f)"
              >
                <span>{{ f.name }}</span>
              </div>
            </template>
          </div>

          <!-- Disaster history -->
          <div class="card">
            <div class="card-head">
              <h3>County Disaster History (FEMA)</h3>
              <select
                v-if="s.disasterHistory?.ok && s.disasterHistory.data.length"
                v-model="disasterType"
                class="radius-select"
                aria-label="Filter by type"
              >
                <option value="all">All types ({{ disasterSummary.total }})</option>
                <option v-for="t in disasterSummary.byType" :key="t.type" :value="t.type">{{ t.type }} ({{ t.count }})</option>
              </select>
            </div>
            <p v-if="!s.disasterHistory?.ok" class="source-error">Source unavailable.</p>
            <p v-else-if="!s.disasterHistory.data.length" class="muted">No declarations on record.</p>
            <template v-else>
              <p class="disaster-summary muted">{{ disasterSummary.total }} declarations</p>
              <div class="disaster-legend">
                <span v-for="t in disasterSummary.byType" :key="t.type" class="legend-item">
                  <span class="legend-dot" :style="{ background: disasterColor(t.type) }"></span>{{ t.type }} {{ t.count }}
                </span>
              </div>
              <div v-for="d in disastersShown" :key="d.femaId" class="row">
                <span class="disaster-name">
                  <span class="disaster-dot" :style="{ background: disasterColor(d.incidentType) }" :title="d.incidentType"></span>{{ titleCase(d.title) }}
                </span>
                <span class="muted disaster-date">{{ fmtMonthDayYear(d.declarationDate) }}</span>
              </div>
            </template>
          </div>

          <!-- Timeline -->
          <div class="card">
            <h3>Risk Timeline</h3>
            <p v-if="!report.timeline.length" class="muted">No dated events.</p>
            <div
              v-for="(e, i) in report.timeline.slice(0, 12)"
              :key="i"
              class="timeline-item"
              :class="{ 'row-click': e.lat != null && e.lon != null }"
              :role="e.lat != null ? 'button' : null"
              :tabindex="e.lat != null ? 0 : null"
              :title="e.lat != null ? 'Show on map' : ''"
              @click="focusEvent(e)"
              @keydown.enter="focusEvent(e)"
            >
              <time>{{ fmtDate(e.time) }} · {{ e.type }}</time>
              {{ e.title }}
            </div>
          </div>

          <!-- More events from nearby past searches that aren't in this report's
               live timeline. Hidden when it would just duplicate the timeline. -->
          <div v-if="newSavedEvents.length" class="card">
            <h3>More Nearby Events (history)</h3>
            <p class="muted" style="margin-top:-4px;margin-bottom:8px;font-size:12px">
              From other searches within 50 mi — not shown in this report's timeline (PostGIS).
            </p>
            <div
              v-for="(e, i) in newSavedEvents.slice(0, 12)"
              :key="i"
              class="timeline-item"
              :class="{ 'row-click': e.lat != null && e.lon != null }"
              :role="e.lat != null ? 'button' : null"
              :tabindex="e.lat != null ? 0 : null"
              :title="e.lat != null ? 'Show on map' : ''"
              @click="focusEvent(e)"
              @keydown.enter="focusEvent(e)"
            >
              <time>{{ fmtDate(e.start_time) }} · {{ e.type }}</time>
              {{ e.title }}
            </div>
          </div>

          <p class="disclaimer">
            Data comes directly from public agency APIs (NWS, EPA, FEMA, USGS, NIFC, AirNow).
            This tool is informational only and is <strong>not</strong> an official source of
            emergency instructions or safety ratings. Always follow guidance from official agencies.
          </p>
        </template>

        <p v-else-if="!loading && !error" class="muted">
          Enter an address to see nearby public risk data.
        </p>
      </aside>

      <div class="map-wrap">
        <RiskMap ref="mapRef" :report="report" :epa-facilities="epaShown" />
      </div>
    </div>
  </div>
</template>
