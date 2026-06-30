// Test helpers for stubbing the global fetch the httpClient uses.
//
// Tests run with REDIS_URL='' (see package.json "test" script) so the cache
// falls back to its in-memory Map — no Redis required and nothing leaks between
// runs. Note: the httpClient caches the *raw* JSON by URL, so when a single
// test calls the same URL twice it may serve the first stub. Tests that assert
// a transform therefore vary their inputs (lat/lon) to keep URLs distinct.

let installed = false;

/**
 * Stub global fetch to return the given JSON for every request.
 * @returns {() => void} restore function
 */
export function stubFetchJson(json, { ok = true, status = 200 } = {}) {
  const original = globalThis.fetch;
  // `text:` lets the same stub serve fetchText (CSV sources like FIRMS). A string
  // payload is returned as-is; anything else is JSON-stringified.
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => json,
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
  });
  installed = true;
  return () => {
    globalThis.fetch = original;
    installed = false;
  };
}

/**
 * Stub global fetch with a custom handler. The handler receives (url, init)
 * and must return a Response-like object ({ ok, status, json }).
 * @returns {{ restore: () => void, calls: () => number }}
 */
export function stubFetchWith(handler) {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (url, init) => {
    count += 1;
    return handler(url, init, count);
  };
  return {
    restore: () => { globalThis.fetch = original; },
    calls: () => count,
  };
}

export function jsonResponse(json, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => json };
}
