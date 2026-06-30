// Thin fetch wrapper: timeout, retry, and an optional shared TTL cache.
// Node 20+ has global fetch/AbortController.

import { cacheGet, cacheSet } from './cache.js';

/**
 * Fetch JSON with timeout + retry + optional caching.
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeoutMs=10000]
 * @param {number} [opts.retries=2]
 * @param {number} [opts.cacheTtlMs=0]  0 disables caching
 */
export async function fetchJson(url, opts = {}) {
  const {
    headers = {},
    timeoutMs = 10000,
    retries = 2,
    cacheTtlMs = 0,
  } = opts;

  const cacheKey = cacheTtlMs > 0 ? `prr:http:${url}::${JSON.stringify(headers)}` : null;
  if (cacheKey) {
    const cached = await cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        // 4xx are client errors — retrying won't help. Only 5xx are retryable.
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.retryable = res.status >= 500;
        throw err;
      }
      const json = await res.json();
      if (cacheKey) await cacheSet(cacheKey, json, cacheTtlMs);
      return json;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Network/timeout errors have no `retryable` flag → treated as retryable.
      // A 4xx (retryable === false) stops the loop immediately.
      if (err.retryable === false || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Fetch plain text (same timeout/retry/cache as fetchJson, but res.text()).
 * Used for CSV upstreams like NASA FIRMS. Caches the raw string by URL.
 * @param {string} url
 * @param {object} [opts] same options as fetchJson
 */
export async function fetchText(url, opts = {}) {
  const {
    headers = {},
    timeoutMs = 10000,
    retries = 2,
    cacheTtlMs = 0,
  } = opts;

  const cacheKey = cacheTtlMs > 0 ? `prr:txt:${url}::${JSON.stringify(headers)}` : null;
  if (cacheKey) {
    const cached = await cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.retryable = res.status >= 500;
        throw err;
      }
      const text = await res.text();
      if (cacheKey) await cacheSet(cacheKey, text, cacheTtlMs);
      return text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.retryable === false || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}
