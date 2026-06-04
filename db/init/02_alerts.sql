-- Public Risk Radar — alerts feature columns
-- Runs automatically on a FRESH container start (docker-entrypoint-initdb.d), after
-- 01_schema.sql. For an already-initialized dev DB this file does NOT auto-run —
-- apply it by hand once:
--   docker exec -i prr-db psql -U prr -d public_risk_radar < db/init/02_alerts.sql
-- (IF NOT EXISTS makes it safe to run repeatedly.)

-- Activation + edge-trigger de-duplication for alert subscriptions.
ALTER TABLE alert_subscriptions
  ADD COLUMN IF NOT EXISTS active        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_fired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_state    JSONB;  -- last evaluated value, for dedupe

-- The worker scans for active subscriptions every tick.
CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_active
  ON alert_subscriptions (active) WHERE active;
