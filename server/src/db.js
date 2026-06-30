import pg from 'pg';
import { config } from './config.js';

// connectionTimeoutMillis so a down/unreachable Postgres fails fast (a few
// seconds) instead of hanging the request — the resilience contract requires a
// DB outage to degrade gracefully, never stall the live response.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 3000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
