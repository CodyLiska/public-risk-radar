// Best-effort upstream cache. Redis is preferred; memory fallback keeps the app running
// when Redis is unavailable. TTLs are source-specific.

import { createClient } from "redis";
import { config } from "../config.js";

// ── in-memory fallback ───────────────────────────────────────────────────────
const mem = new Map(); // key -> { value, expires }

function memGet(key) {
  const hit = mem.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    mem.delete(key);
    return undefined;
  }
  return hit.value;
}

function memSet(key, value, ttlMs) {
  mem.set(key, { value, expires: Date.now() + ttlMs });
}

// ── redis (optional) ─────────────────────────────────────────────────────────
let client = null;
let redisReady = false;

if (config.redisUrl) {
  client = createClient({ url: config.redisUrl });
  client.on("ready", () => {
    if (!redisReady) console.log("[cache] redis connected");
    redisReady = true;
  });
  client.on("error", (err) => {
    // The node-redis client emits 'error' on connection loss and reconnect
    // attempts; only log the transition and drop to the in-memory fallback.
    if (redisReady)
      console.warn("[cache] redis error, falling back to memory:", err.message);
    redisReady = false;
  });
  client.connect().catch((err) => {
    console.warn(
      "[cache] redis unavailable, using in-memory cache:",
      err.message,
    );
  });
}

/** Returns the cached value, or undefined on miss. Never throws. */
export async function cacheGet(key) {
  if (redisReady) {
    try {
      const v = await client.get(key);
      return v == null ? undefined : JSON.parse(v);
    } catch {
      // fall through to memory on any redis hiccup
    }
  }
  return memGet(key);
}

/** Stores a value under a TTL (ms). Best-effort; never throws. */
export async function cacheSet(key, value, ttlMs) {
  if (redisReady) {
    try {
      await client.set(key, JSON.stringify(value), { PX: ttlMs });
      return;
    } catch {
      // fall through to memory on any redis hiccup
    }
  }
  memSet(key, value, ttlMs);
}
