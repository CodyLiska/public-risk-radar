import { describe, test, expect } from 'vitest';
import {
  fmtDate,
  fmtMonthDayYear,
  fmtRelative,
  severityClass,
  topObservation,
  dedupeRecentSearches,
  groupGaugesBySite,
  summarizeDisasterTypes,
  disasterColor,
  titleCase,
  aqiScale,
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
  test('renders date-only (UTC midnight) values as their UTC calendar day', () => {
    // FEMA declarationDate — must not slip back a day in negative-offset zones.
    // Forced to UTC in code, so this is deterministic regardless of the test machine's TZ.
    expect(fmtDate('2024-06-28T00:00:00.000Z')).toBe('6/28/2024');
    expect(fmtDate('2024-06-28')).toBe('6/28/2024');
  });
  test('renders real (non-midnight) timestamps in local time', () => {
    // a noon-UTC instant lands on the same calendar day across US timezones
    expect(fmtDate('2024-06-28T12:00:00Z')).toMatch(/6\/28\/2024/);
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

describe('groupGaugesBySite', () => {
  test('handles null/empty', () => {
    expect(groupGaugesBySite(null)).toEqual([]);
    expect(groupGaugesBySite([])).toEqual([]);
  });
  test('collapses multi-parameter readings into one entry per site', () => {
    const gauges = [
      { siteId: '1', name: 'Salt River', lat: 33.4, lon: -112.0, parameter: 'Discharge (cfs)', value: 0 },
      { siteId: '1', name: 'Salt River', lat: 33.4, lon: -112.0, parameter: 'Gage height (ft)', value: 1.07 },
      { siteId: '2', name: 'Skunk Creek', lat: 33.7, lon: -112.2, parameter: 'Discharge (cfs)', value: 0 },
    ];
    const out = groupGaugesBySite(gauges);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ siteId: '1', name: 'Salt River', lat: 33.4, lon: -112.0 }); // coords carried for map fly-to
    expect(out[0].readings).toEqual([
      { parameter: 'Discharge (cfs)', value: 0 },
      { parameter: 'Gage height (ft)', value: 1.07 },
    ]);
    expect(out[1].readings).toHaveLength(1);
  });
  test('caps at the limit of distinct sites but keeps later readings for chosen sites', () => {
    const gauges = [
      { siteId: 'a', name: 'A', parameter: 'Discharge (cfs)', value: 1 },
      { siteId: 'b', name: 'B', parameter: 'Discharge (cfs)', value: 2 },
      { siteId: 'c', name: 'C', parameter: 'Discharge (cfs)', value: 3 }, // beyond limit 2 — dropped
      { siteId: 'a', name: 'A', parameter: 'Gage height (ft)', value: 4 }, // chosen site — kept
    ];
    const out = groupGaugesBySite(gauges, 2);
    expect(out.map((g) => g.siteId)).toEqual(['a', 'b']);
    expect(out[0].readings).toHaveLength(2);
  });
});

describe('summarizeDisasterTypes', () => {
  test('handles null/empty', () => {
    expect(summarizeDisasterTypes(null)).toEqual({ total: 0, byType: [] });
    expect(summarizeDisasterTypes([])).toEqual({ total: 0, byType: [] });
  });
  test('counts by incidentType over the full list, sorted by count desc', () => {
    const decls = [
      { incidentType: 'Fire' },
      { incidentType: 'Flood' },
      { incidentType: 'Fire' },
      { incidentType: 'Hurricane' },
      { incidentType: 'Flood' },
      { incidentType: 'Fire' },
    ];
    const out = summarizeDisasterTypes(decls);
    expect(out.total).toBe(6);
    expect(out.byType).toEqual([
      { type: 'Fire', count: 3 },
      { type: 'Flood', count: 2 },
      { type: 'Hurricane', count: 1 },
    ]);
  });
});

describe('fmtMonthDayYear', () => {
  test('em dash for empty', () => expect(fmtMonthDayYear(null)).toBe('—'));
  test('renders a date-only value in UTC as "Mon D, YYYY"', () => {
    // FEMA declarationDate — must not slip a day in negative-offset zones
    expect(fmtMonthDayYear('2024-06-28T00:00:00.000Z')).toBe('Jun 28, 2024');
  });
});

describe('titleCase', () => {
  test('ALL CAPS → Title Case', () => {
    expect(titleCase('BOULDER VIEW FIRE')).toBe('Boulder View Fire');
    expect(titleCase('HURRICANE KATRINA EVACUATION')).toBe('Hurricane Katrina Evacuation');
  });
  test('keeps connector words lowercase except the first', () => {
    expect(titleCase('SEVERE STORMS AND FLOODING')).toBe('Severe Storms and Flooding');
    expect(titleCase('THE BIG ONE')).toBe('The Big One');
  });
  test('handles empty', () => expect(titleCase('')).toBe(''));
});

describe('disasterColor', () => {
  test('known types get distinct colours', () => {
    expect(disasterColor('Fire')).not.toBe(disasterColor('Flood'));
    expect(disasterColor('Severe Storm')).toMatch(/^#/);
  });
  test('unknown type falls back to neutral grey', () => {
    expect(disasterColor('Volcano')).toBe('#9aa3b2');
  });
});

describe('aqiScale', () => {
  test('returns null for missing input', () => {
    expect(aqiScale(null)).toBe(null);
    expect(aqiScale(undefined)).toBe(null);
  });
  test('places a value in the correct band', () => {
    expect(aqiScale(30).band.key).toBe('good');
    expect(aqiScale(93).band.key).toBe('moderate');
    expect(aqiScale(120).band.key).toBe('usg');
    expect(aqiScale(175).band.key).toBe('unhealthy');
    expect(aqiScale(250).band.key).toBe('veryunhealthy');
    expect(aqiScale(400).band.key).toBe('hazardous');
  });
  test('markerPct advances within/across bands and clamps at the ends', () => {
    expect(aqiScale(0).markerPct).toBe(0);
    expect(aqiScale(9999).markerPct).toBe(100);
    // 93 sits near the top of the 2nd of 6 bands → ~31%, close to the next tier
    const at93 = aqiScale(93).markerPct;
    expect(at93).toBeGreaterThan(28);
    expect(at93).toBeLessThan(34);
  });
});
