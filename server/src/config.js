import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the project root (one level above /server).
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

export const config = {
  port: Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://prr:prr_dev_password@localhost:5432/public_risk_radar',
  // `??` (not `||`) so REDIS_URL='' explicitly disables Redis (→ in-memory
  // cache only); an unset var still falls back to the local default.
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  airnowApiKey: process.env.AIRNOW_API_KEY || '',
  // Background alert worker. Disabled by default so tests/CI and a plain API run
  // don't spin a loop; enable per-environment in .env.
  alertsEnabled: process.env.ALERTS_ENABLED === 'true',
  alertsIntervalMs: Number(process.env.ALERTS_INTERVAL_MS) || 5 * 60 * 1000,
  nwsUserAgent:
    process.env.NWS_USER_AGENT || 'public-risk-radar (set NWS_USER_AGENT in .env)',
  demo: {
    stateFips: process.env.DEMO_STATE_FIPS || '04',
    countyFips: process.env.DEMO_COUNTY_FIPS || '013',
  },
};
