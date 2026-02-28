/**
 * Shared district name normalization used across all build scripts and frontend.
 * This is the single source of truth for generating district lookup keys.
 */

export function normalizeDistrictName(s: string): string {
  if (!s || typeof s !== 'string') return '';
  let t = s
    .toLowerCase()
    .trim()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[-–—]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const suffixes = [
    ' regional school district',
    ' school district',
    ' public schools',
  ];
  for (const suf of suffixes) {
    if (t.endsWith(suf)) { t = t.slice(0, -suf.length).trim(); break; }
  }
  const levelSuffixes = [' elementary', ' secondary'];
  for (const suf of levelSuffixes) {
    if (t.endsWith(suf)) { t = t.slice(0, -suf.length).trim(); break; }
  }
  return t;
}

/** Known aliases: alternate name -> canonical key */
export const DISTRICT_ALIASES: Record<string, string> = {
  'bistol warren regional district': 'bristol warren',
};

export function districtKey(name: string): string {
  const k = normalizeDistrictName(name);
  return DISTRICT_ALIASES[k] ?? k;
}
