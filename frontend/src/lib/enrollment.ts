/**
 * Enrollment lookup utilities. Normalization must match scripts/build-enrollment.ts
 */

export interface Demographics {
  NATIVE?: number;
  ASIAN?: number;
  BLACK?: number;
  HISPANIC?: number;
  MULTIRACE?: number;
  PACIFICISLANDER?: number;
  WHITE?: number;
  FEMALE?: number;
  MALE?: number;
  OTHER?: number;
}

export interface DistrictEnrollment {
  distcode: string;
  distname: string;
  total: number;
  elem_enrollment?: number;
  sec_enrollment?: number;
  FRL?: number;
  LEP?: number;
  IEP?: number;
  VOCED?: number;
  demographics?: Demographics;
  grades?: Record<string, number>;
}

export interface SchoolEnrollment {
  distcode: string;
  schcode: string;
  distname: string;
  schname: string;
  total: number;
  FRL?: number;
  LEP?: number;
  IEP?: number;
  VOCED?: number;
  demographics?: Demographics;
  grades?: Record<string, number>;
}

export type LeaEnrollmentMap = Record<string, DistrictEnrollment>;
export type SchoolEnrollmentMap = Record<string, SchoolEnrollment>;

/** Normalize for lookup key. Must match scripts/build-enrollment.ts */
export function normalizeForKey(s: string): string {
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

/** Alias: GeoJSON/NCES normalized name -> RIDE key. Add when lookup fails. */
const DISTRICT_ALIASES: Record<string, string> = {
};

export function districtKey(name: string): string {
  const k = normalizeForKey(name);
  return DISTRICT_ALIASES[k] ?? k;
}

export function schoolKey(districtName: string, schoolName: string): string {
  return districtKey(districtName) + '||' + normalizeForKey(schoolName);
}

/** Debug: return keys that share the first 8 chars */
export function debugCandidates(
  map: Record<string, unknown>,
  key: string,
  limit = 10
): string[] {
  const prefix = key.slice(0, 8);
  return Object.keys(map)
    .filter((k) => k.slice(0, 8) === prefix || k.includes(key.slice(0, 6)))
    .slice(0, limit);
}
