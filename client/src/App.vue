<script setup>
import { ref, computed, onMounted } from 'vue';
import { searchAddress, getHistory, getEvents } from './api.js';
import { fmtDate, fmtRelative, aqiClass, severityClass, topObservation, dedupeRecentSearches } from './lib/format.js';
import RiskMap from './components/RiskMap.vue';

const address = ref('');
const report = ref(null);
const loading = ref(false);
const error = ref('');
const history = ref([]);
const savedEvents = ref([]);

async function onSearch() {
  if (!address.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    report.value = await searchAddress(address.value);
    // Refresh the persisted views now that this search has been stored.
    loadHistory();
    loadSavedEvents();
  } catch (e) {
    error.value = e.message;
    report.value = null;
  } finally {
    loading.value = false;
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
  onSearch();
}

// Collapse repeated searches of the same address to the most recent few.
const recentSearches = computed(() => dedupeRecentSearches(history.value));

onMounted(loadHistory);

const s = computed(() => report.value?.sources ?? {});

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
              <template v-else-if="topAqi">
                <div class="big"><span class="badge" :class="aqiClass(topAqi.aqi)">{{ topAqi.aqi }}</span> {{ topAqi.category }}</div>
                <div class="muted" style="margin-top:4px">{{ topAqi.parameter }} · {{ topAqi.reportingArea }}</div>
              </template>
              <p v-else class="muted">No nearby observations.</p>
            </template>
            <p v-else class="source-error">Source unavailable.</p>
          </div>

          <!-- Flood zone -->
          <div class="card">
            <h3>Flood Zone (FEMA NFHL)</h3>
            <template v-if="s.floodZone?.ok">
              <div v-if="s.floodZone.data.inMappedArea" class="big">
                <span class="badge" :class="s.floodZone.data.highRisk ? 'danger' : 'ok'">
                  Zone {{ s.floodZone.data.floodZone }}
                </span>
              </div>
              <p v-else class="muted">Not in a mapped flood hazard area.</p>
            </template>
            <p v-else class="source-error">Source unavailable.</p>
          </div>

          <!-- Wildfires -->
          <div class="card">
            <h3>Nearby Wildfires</h3>
            <p v-if="s.wildfires?.ok && !s.wildfires.data.length" class="muted">None within 25 miles.</p>
            <p v-else-if="!s.wildfires?.ok" class="source-error">Source unavailable.</p>
            <div v-else v-for="w in s.wildfires.data" :key="w.name" class="row">
              <span>{{ w.name }}</span>
              <span class="muted">{{ w.acres ? Math.round(w.acres) + ' ac' : '—' }}</span>
            </div>
          </div>

          <!-- Water gauges -->
          <div class="card">
            <h3>Water Gauges (USGS)</h3>
            <p v-if="s.waterGauges?.ok && !s.waterGauges.data.length" class="muted">No active gauges nearby.</p>
            <p v-else-if="!s.waterGauges?.ok" class="source-error">Source unavailable.</p>
            <div v-else v-for="g in s.waterGauges.data.slice(0, 6)" :key="g.siteId" class="row">
              <span>{{ g.name }}</span>
              <span class="muted">{{ g.value ?? '—' }}</span>
            </div>
          </div>

          <!-- EPA facilities -->
          <div class="card">
            <h3>Nearby EPA Facilities</h3>
            <p v-if="s.epaFacilities?.ok && !s.epaFacilities.data.length" class="muted">None within 5 miles.</p>
            <p v-else-if="!s.epaFacilities?.ok" class="source-error">Source unavailable.</p>
            <div v-else v-for="f in s.epaFacilities.data.slice(0, 8)" :key="f.registryId" class="row">
              <span>{{ f.name }}</span>
            </div>
          </div>

          <!-- Disaster history -->
          <div class="card">
            <h3>County Disaster History (FEMA)</h3>
            <p v-if="s.disasterHistory?.ok && !s.disasterHistory.data.length" class="muted">No declarations on record.</p>
            <p v-else-if="!s.disasterHistory?.ok" class="source-error">Source unavailable.</p>
            <div v-else v-for="d in s.disasterHistory.data.slice(0, 8)" :key="d.femaId" class="row">
              <span>{{ d.incidentType }}</span>
              <span class="muted">{{ fmtDate(d.declarationDate) }}</span>
            </div>
          </div>

          <!-- Timeline -->
          <div class="card">
            <h3>Risk Timeline</h3>
            <p v-if="!report.timeline.length" class="muted">No dated events.</p>
            <div v-for="(e, i) in report.timeline.slice(0, 12)" :key="i" class="timeline-item">
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
            <div v-for="(e, i) in newSavedEvents.slice(0, 12)" :key="i" class="timeline-item">
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
        <RiskMap :report="report" />
      </div>
    </div>
  </div>
</template>
