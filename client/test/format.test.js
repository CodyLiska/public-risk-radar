import { describe, test, expect } from 'vitest';
import {
  fmtDate,
  fmtRelative,
  aqiClass,
  severityClass,
  topObservation,
  dedupeRecentSearches,
} from '../src/lib/format.js';

describe('fmtDate', () => {
  test('renders an em dash for empty input', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('')).toBe('—');
  });
  test('formats a valid date', () => {
    // locale-dependent, so just assert it produced something date-like
    expect(fmtDate('2026-06-03T00:00:00Z')).toMatch(/2026/);
  });
});

describe('fmtRelative', () => {
  const now = Date.parse('2026-06-03T12:00:00Z');
  test('empty for missing input', () => {
    expect(fmtRelative(null, now)).toBe('');
  });
  test('"just now" under a minute', () => {
    expect(fmtRelative('2026-06-03T11:59:30Z', now)).toBe('just now');
  });
  test('minutes', () => {
    expect(fmtRelative('2026-06-03T11:45:00Z', now)).toBe('15m ago');
  });
  test('hours', () => {
    expect(fmtRelative('2026-06-03T09:00:00Z', now)).toBe('3h ago');
  });
  test('days', () => {
    expect(fmtRelative('2026-06-01T12:00:00Z', now)).toBe('2d ago');
  });
});

describe('aqiClass', () => {
  test('null → muted', () => expect(aqiClass(null)).toBe('muted'));
  test('boundaries', () => {
    expect(aqiClass(0)).toBe('ok');
    expect(aqiClass(50)).toBe('ok');
    expect(aqiClass(51)).toBe('warn');
    expect(aqiClass(100)).toBe('warn');
    expect(aqiClass(101)).toBe('danger');
    expect(aqiClass(300)).toBe('danger');
  });
});

describe('severityClass', () => {
  test('severe/extreme → danger', () => {
    expect(severityClass('Severe')).toBe('danger');
    expect(severityClass('Extreme')).toBe('danger');
  });
  test('moderate → warn', () => expect(severityClass('Moderate')).toBe('warn'));
  test('minor → ok', () => expect(severityClass('Minor')).toBe('ok'));
  test('case-insensitive', () => expect(severityClass('SEVERE')).toBe('danger'));
  test('Unknown / null / empty → muted (not red)', () => {
    expect(severityClass('Unknown')).toBe('muted');
    expect(severityClass(null)).toBe('muted');
    expect(severityClass(undefined)).toBe('muted');
    expect(severityClass('')).toBe('muted');
  });
});

describe('topObservation', () => {
  test('null for no observations', () => {
    expect(topObservation([])).toBe(null);
    expect(topObservation(undefined)).toBe(null);
  });
  test('returns the highest-AQI observation', () => {
    const obs = [
      { parameter: 'O3', aqi: 42 },
      { parameter: 'PM2.5', aqi: 88 },
      { parameter: 'NO2', aqi: 55 },
    ];
    expect(topObservation(obs).parameter).toBe('PM2.5');
  });
});

describe('dedupeRecentSearches', () => {
  test('handles null/empty', () => {
    expect(dedupeRecentSearches(null)).toEqual([]);
    expect(dedupeRecentSearches([])).toEqual([]);
  });
  test('keeps the first (most recent) occurrence of each address', () => {
    const history = [
      { id: 3, address: 'Phoenix, AZ', created_at: 'c' },
      { id: 2, address: 'Phoenix, AZ', created_at: 'b' },
      { id: 1, address: 'Tempe, AZ', created_at: 'a' },
    ];
    const out = dedupeRecentSearches(history);
    expect(out.map((l) => l.address)).toEqual(['Phoenix, AZ', 'Tempe, AZ']);
    expect(out[0].id).toBe(3); // newest of the duplicates
  });
  test('caps the result at the limit', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ id: i, address: `addr-${i}` }));
    expect(dedupeRecentSearches(history)).toHaveLength(8);
    expect(dedupeRecentSearches(history, 3)).toHaveLength(3);
  });
});
