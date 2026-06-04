-- Public Risk Radar — core schema
-- Runs automatically on first container start (docker-entrypoint-initdb.d).

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Locations the user has searched / saved ─────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    address       TEXT,
    lat           DOUBLE PRECISION NOT NULL,
    lon           DOUBLE PRECISION NOT NULL,
    geom          GEOGRAPHY(Point, 4326),
    state_fips    TEXT,
    county_fips   TEXT,          -- 5-digit (state+county), e.g. 04013
    census_tract  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locations_geom_idx ON locations USING GIST (geom);

-- ── Generic risk events (unified timeline) ──────────────────────────────────
-- Every source can be normalized into a row here for the timeline view.
CREATE TABLE IF NOT EXISTS risk_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type        TEXT NOT NULL,           -- weather | flood | fire | air | water | quake | environmental | disaster
    source      TEXT NOT NULL,           -- nws | airnow | fema | nifc | usgs_water | usgs_quake | epa_echo
    source_id   TEXT,                    -- upstream id, for dedupe
    title       TEXT,
    severity    TEXT,
    start_time  TIMESTAMPTZ,
    end_time    TIMESTAMPTZ,
    geom        GEOGRAPHY(Geometry, 4326),
    raw_json    JSONB,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS risk_events_geom_idx  ON risk_events USING GIST (geom);
CREATE INDEX IF NOT EXISTS risk_events_type_idx  ON risk_events (type);
CREATE INDEX IF NOT EXISTS risk_events_start_idx ON risk_events (start_time DESC);

-- ── FEMA county-level disaster declarations ─────────────────────────────────
CREATE TABLE IF NOT EXISTS disaster_declarations (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fema_id           TEXT UNIQUE,       -- femaDeclarationString
    disaster_number   INTEGER,
    state             TEXT,
    county_fips       TEXT,              -- 5-digit
    incident_type     TEXT,
    declaration_title TEXT,
    declaration_date  TIMESTAMPTZ,
    incident_begin    TIMESTAMPTZ,
    incident_end      TIMESTAMPTZ,
    raw_json          JSONB
);
CREATE INDEX IF NOT EXISTS disaster_county_idx ON disaster_declarations (county_fips);

-- ── EPA ECHO regulated facilities ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS epa_facilities (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registry_id       TEXT UNIQUE,
    name              TEXT,
    address           TEXT,
    lat               DOUBLE PRECISION,
    lon               DOUBLE PRECISION,
    geom              GEOGRAPHY(Point, 4326),
    programs          TEXT,
    compliance_status TEXT,
    raw_json          JSONB,
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS epa_facilities_geom_idx ON epa_facilities USING GIST (geom);

-- ── USGS water gauges ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS water_gauges (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usgs_site_id  TEXT UNIQUE,
    name          TEXT,
    lat           DOUBLE PRECISION,
    lon           DOUBLE PRECISION,
    geom          GEOGRAPHY(Point, 4326),
    parameter     TEXT,
    latest_value  DOUBLE PRECISION,
    unit          TEXT,
    observed_at   TIMESTAMPTZ,
    raw_json      JSONB,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS water_gauges_geom_idx ON water_gauges USING GIST (geom);

-- ── Alert subscriptions (post-MVP, schema stubbed now) ──────────────────────
CREATE TABLE IF NOT EXISTS alert_subscriptions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id     BIGINT REFERENCES locations(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    threshold       JSONB,
    delivery_method TEXT,              -- email | discord
    delivery_target TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
