import { describe, test, expect, vi, afterEach } from 'vitest';
import { searchAddress, getHistory, getEvents } from '../src/api.js';

function mockFetch(json, { ok = true, status = 200 } = {}) {
  const fn = vi.fn(async () => ({ ok, status, json: async () => json }));
  globalThis.fetch = fn;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('searchAddress', () => {
  test('encodes the address into the query string', async () => {
    const fetchFn = mockFetch({ ok: true });
    await searchAddress('1700 W Washington St, Phoenix, AZ');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/search?address=1700%20W%20Washington%20St%2C%20Phoenix%2C%20AZ',
    );
  });
  test('returns the parsed JSON', async () => {
    mockFetch({ ok: true, location: { lat: 1 } });
    expect(await searchAddress('x')).toEqual({ ok: true, location: { lat: 1 } });
  });
});

describe('getHistory', () => {
  test('calls /api/history', async () => {
    const fetchFn = mockFetch({ count: 0, locations: [] });
    await getHistory();
    expect(fetchFn).toHaveBeenCalledWith('/api/history');
  });
});

describe('getEvents', () => {
  test('builds the lat/lon/radius query with a default radius', async () => {
    const fetchFn = mockFetch({ count: 0, events: [] });
    await getEvents(33.45, -112.07);
    expect(fetchFn).toHaveBeenCalledWith('/api/events?lat=33.45&lon=-112.07&radius=50');
  });
  test('honors a custom radius', async () => {
    const fetchFn = mockFetch({ count: 0, events: [] });
    await getEvents(33.45, -112.07, 10);
    expect(fetchFn).toHaveBeenCalledWith('/api/events?lat=33.45&lon=-112.07&radius=10');
  });
});

describe('error handling', () => {
  test('throws the API-provided error message on a non-ok response', async () => {
    mockFetch({ error: 'address query param is required' }, { ok: false, status: 400 });
    await expect(searchAddress('')).rejects.toThrow('address query param is required');
  });
  test('falls back to an HTTP status message when no error field is present', async () => {
    mockFetch({}, { ok: false, status: 503 });
    await expect(getHistory()).rejects.toThrow('HTTP 503');
  });
});
