import { fetchJson } from '../lib/httpClient.js';

// U.S. Census Bureau geocoder — free, no API key.
// Returns lat/lon plus census geographies (county FIPS, tract).
// https://geocoding.geo.census.gov/geocoder/
const BASE = 'https://geocoding.geo.census.gov/geocoder/geographies';

/**
 * Geocode a one-line address or ZIP to coordinates + FIPS geographies.
 * @param {string} address
 * @returns {Promise<null | {
 *   matchedAddress: string, lat: number, lon: number,
 *   stateFips: string, countyFips: string, county: string, tract: string
 * }>}
 */
export async function geocodeAddress(address) {
  const url =
    `${BASE}/onelineaddress?address=${encodeURIComponent(address)}` +
    `&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;

  const data = await fetchJson(url, { timeoutMs: 12000, cacheTtlMs: 24 * 60 * 60 * 1000 });
  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;

  const county = match.geographies?.Counties?.[0];
  const tract = match.geographies?.['Census Tracts']?.[0];

  return {
    matchedAddress: match.matchedAddress,
    lat: match.coordinates.y,
    lon: match.coordinates.x,
    stateFips: county?.STATE ?? null,
    countyFips: county?.GEOID ?? null, // 5-digit state+county
    county: county?.NAME ?? null,
    tract: tract?.GEOID ?? null,
  };
}
