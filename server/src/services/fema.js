import { fetchJson } from '../lib/httpClient.js';

// FEMA OpenFEMA — Disaster Declarations Summaries. No key.
// https://www.fema.gov/about/openfema/data-sets
const BASE = 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries';

/**
 * County-level disaster declaration history.
 * @param {string} stateFips  2-digit, e.g. '04'
 * @param {string} countyFips 3-digit county code, e.g. '013' (NOT the 5-digit GEOID)
 */
export async function getDisasterHistory(stateFips, countyFips, limit = 200) {
  const filter = `fipsStateCode eq '${stateFips}' and fipsCountyCode eq '${countyFips}'`;
  const url =
    `${BASE}?$filter=${encodeURIComponent(filter)}` +
    `&$orderby=declarationDate desc&$top=${limit}`;

  const data = await fetchJson(url, { cacheTtlMs: 6 * 60 * 60 * 1000 });
  return (data?.DisasterDeclarationsSummaries ?? []).map((d) => ({
    femaId: d.femaDeclarationString,
    disasterNumber: d.disasterNumber,
    state: d.state,
    incidentType: d.incidentType,
    title: d.declarationTitle,
    declarationDate: d.declarationDate,
    incidentBegin: d.incidentBeginDate,
    incidentEnd: d.incidentEndDate,
    programs: {
      ih: d.ihProgramDeclared,
      ia: d.iaProgramDeclared,
      pa: d.paProgramDeclared,
      hm: d.hmProgramDeclared,
    },
  }));
}

/**
 * Split a 5-digit county GEOID into {stateFips, countyFips} parts that
 * OpenFEMA expects (it filters on the 3-digit county code separately).
 */
export function splitCountyGeoid(geoid) {
  if (!geoid || geoid.length !== 5) return null;
  return { stateFips: geoid.slice(0, 2), countyFips: geoid.slice(2) };
}
