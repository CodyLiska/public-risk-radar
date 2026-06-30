import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { stubFetchJson } from './helpers.js';
import { router } from '../src/routes/index.js';

// The service calls the NIFC upstream via the GLOBAL fetch, which stubFetchJson
// replaces. So the test must NOT use fetch to reach its own server (the stub
// would hijack it) — use node:http, which the stub doesn't touch.
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      })
      .on('error', reject);
  });
}

function makeApp() {
  const app = express();
  app.use('/api', router);
  return app;
}
async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}/api` };
}

test('GET /api/wildfires rejects missing/non-numeric coords (400, no fetch)', async () => {
  const { server, base } = await listen(makeApp());
  try {
    assert.equal((await httpGet(`${base}/wildfires?radius=50`)).status, 400);
    assert.equal((await httpGet(`${base}/wildfires?lat=x&lon=y`)).status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/wildfires returns wildfires at the requested radius', async () => {
  const restore = stubFetchJson({
    features: [
      { attributes: { IncidentName: 'TEST FIRE', DailyAcres: 1234, FireDiscoveryDateTime: 1700000000000, POOState: 'US-AZ' }, geometry: { x: -112.1, y: 33.9 } },
    ],
  });
  const { server, base } = await listen(makeApp());
  try {
    const { status, body } = await httpGet(`${base}/wildfires?lat=33.65&lon=-112.18&radius=50`);
    assert.equal(status, 200);
    assert.equal(body.radiusMiles, 50); // echoes the chosen radius
    assert.equal(body.count, 1);
    assert.equal(body.wildfires[0].name, 'TEST FIRE');
  } finally {
    server.close();
    restore();
  }
});

test('GET /api/wildfires clamps an oversized radius to 100', async () => {
  const restore = stubFetchJson({ features: [] });
  const { server, base } = await listen(makeApp());
  try {
    const { body } = await httpGet(`${base}/wildfires?lat=34.1&lon=-111.9&radius=9999`);
    assert.equal(body.radiusMiles, 100);
  } finally {
    server.close();
    restore();
  }
});
