#!/usr/bin/env node
/**
 * Build district anchors based on real school locations.
 *
 * Anchor each district to its largest PUBLIC high school (grades 9-12).
 * If none, anchor to its largest PUBLIC elementary school.
 * If none, fall back to an interior point of the district polygon.
 *
 * Input:  data/districts.geojson, data/schools.geojson,
 *         frontend/public/enrollment/ri_school_enrollment_2024-10.json
 * Output: frontend/public/centroids/district-anchors.json
 *
 * Run: npm run build:anchors
 */

import * as fs from 'fs';
import * as path from 'path';
import pointOnFeature from '@turf/point-on-feature';
import centroid from '@turf/centroid';
import { districtKey, normalizeDistrictName } from './lib/normalize';

const ROOT = process.cwd();
const DISTRICTS_PATH = path.join(ROOT, 'data', 'districts.geojson');
const SCHOOLS_PATH = path.join(ROOT, 'data', 'schools.geojson');
const ENROLLMENT_PATH = path.join(ROOT, 'frontend', 'public', 'enrollment', 'ri_school_enrollment_2024-10.json');
const OUT_DIR = path.join(ROOT, 'frontend', 'public', 'centroids');
const OUT_FILE = path.join(OUT_DIR, 'district-anchors.json');

const CHARTER_PATTERNS = /charter|academy|prep(?:\s|$)|career[\s-]?(?:and\s+)?tech|tech\s+ctr/i;
const ALTERNATIVE_PATTERNS = /\balternative\b/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchoolProps {
  id: string;
  name: string;
  school_type: string;
  grades_low: number | null;
  grades_high: number | null;
  grade_bucket: string;
  nces_id: string;
  district_geoid: string;
  district_name: string;
  lat: number;
  lon: number;
}

interface SchoolCandidate {
  name: string;
  ncesId: string;
  gradeLow: number | null;
  gradeHigh: number | null;
  gradeBucket: string;
  districtGeoid: string;
  districtName: string;
  lat: number;
  lon: number;
  enrollment: number | null;
  likelyCharter: boolean;
}

interface AnchorSchool {
  name: string;
  ncesId: string;
  enrollment: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  gradeBucket: string;
  districtGeoid: string;
  districtName: string;
}

interface DistrictAnchor {
  displayName: string;
  lat: number;
  lon: number;
  anchorType: string;
  anchorSchool: AnchorSchool | null;
  flags: string[];
}

type AnchorsMap = Record<string, DistrictAnchor>;

interface FallbackInfo {
  displayName: string;
  lat: number;
  lon: number;
  geoid: string;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHighSchool(s: SchoolCandidate): boolean {
  if (s.gradeHigh == null) return s.gradeBucket === 'High';
  if (s.gradeHigh < 12) return false;
  if (s.gradeLow != null && s.gradeLow >= 9) return true;
  return s.gradeBucket === 'High';
}

function isElementary(s: SchoolCandidate): boolean {
  if (s.gradeBucket === 'Elementary') return true;
  if (s.gradeHigh != null && s.gradeHigh <= 6) return true;
  return false;
}

function bucketPriority(b: string): number {
  switch (b) {
    case 'High': return 0;
    case 'Middle': return 1;
    case 'Elementary': return 2;
    default: return 3;
  }
}

function rankCandidates(candidates: SchoolCandidate[]): SchoolCandidate[] {
  return [...candidates].sort((a, b) => {
    const ea = a.enrollment ?? -1;
    const eb = b.enrollment ?? -1;
    if (eb !== ea) return eb - ea;
    const pa = bucketPriority(a.gradeBucket);
    const pb = bucketPriority(b.gradeBucket);
    if (pa !== pb) return pa - pb;
    const spanA = (a.gradeHigh != null && a.gradeLow != null) ? a.gradeHigh - a.gradeLow : -1;
    const spanB = (b.gradeHigh != null && b.gradeLow != null) ? b.gradeHigh - b.gradeLow : -1;
    if (spanB !== spanA) return spanB - spanA;
    return a.name.localeCompare(b.name);
  });
}

function pickBest(candidates: SchoolCandidate[]): { winner: SchoolCandidate; flags: string[] } {
  const flags: string[] = [];
  const nonCharter = candidates.filter(c => !c.likelyCharter);
  const withEnrollment = nonCharter.filter(c => c.enrollment != null && c.enrollment > 0);

  let pool: SchoolCandidate[];
  if (withEnrollment.length > 0) {
    pool = withEnrollment;
  } else if (nonCharter.length > 0) {
    pool = nonCharter;
  } else {
    pool = candidates;
  }

  const ranked = rankCandidates(pool);
  const winner = ranked[0];

  if (winner.enrollment == null || winner.enrollment <= 0) {
    flags.push('anchor_used_heuristic_no_enrollment');
  }
  if (winner.likelyCharter) {
    flags.push('anchor_may_be_charter');
  }
  if (winner.gradeLow == null && winner.gradeHigh == null) {
    flags.push('anchor_missing_grade_span');
  }
  return { winner, flags };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log('Building district anchors from school locations...\n');

  if (!fs.existsSync(DISTRICTS_PATH)) {
    console.error(`Districts GeoJSON not found: ${DISTRICTS_PATH}\nRun: npm run build:districts`);
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, '{}');
    return;
  }
  if (!fs.existsSync(SCHOOLS_PATH)) {
    console.error(`Schools GeoJSON not found: ${SCHOOLS_PATH}\nRun: npm run build:data`);
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, '{}');
    return;
  }

  // A) Build fallback points from district polygons + geoid mapping
  const districtsGeo = JSON.parse(fs.readFileSync(DISTRICTS_PATH, 'utf-8'));
  const districtFeatures: Array<{ geometry: GeoJSON.Geometry; properties: Record<string, unknown> }> =
    districtsGeo.features ?? [];

  const fallbacks = new Map<string, FallbackInfo>();
  const geoidToKey = new Map<string, string>();

  for (const f of districtFeatures) {
    const geom = f.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;

    const displayName = String(f.properties.district_name ?? f.properties.name ?? '').trim();
    const key = districtKey(displayName);
    const geoid = String(f.properties.district_geoid ?? f.properties.geoid ?? '');
    const flags: string[] = [];

    let lat: number, lon: number;
    try {
      const pt = pointOnFeature(f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>);
      [lon, lat] = pt.geometry.coordinates;
      if (isNaN(lon) || isNaN(lat)) throw new Error('NaN');
    } catch {
      try {
        const ct = centroid(f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>);
        [lon, lat] = ct.geometry.coordinates;
        flags.push('used_centroid_fallback');
      } catch {
        continue;
      }
    }

    fallbacks.set(key, { displayName, lat, lon, geoid, flags });
    if (geoid) geoidToKey.set(geoid, key);
  }

  // B) Load school enrollment keyed by "districtKey||schoolNameKey"
  let enrollmentMap: Record<string, { total?: number }> = {};
  if (fs.existsSync(ENROLLMENT_PATH)) {
    enrollmentMap = JSON.parse(fs.readFileSync(ENROLLMENT_PATH, 'utf-8'));
  } else {
    console.warn('  School enrollment file not found; all anchors will use heuristic.\n');
  }

  function lookupEnrollment(districtName: string, schoolName: string): number | null {
    const dk = normalizeDistrictName(districtName);
    const sk = normalizeDistrictName(schoolName);
    const compositeKey = `${dk}||${sk}`;
    const entry = enrollmentMap[compositeKey];
    if (entry && typeof entry.total === 'number' && entry.total > 0) return entry.total;
    return null;
  }

  // C) Parse public schools and group by district
  const schoolsGeo = JSON.parse(fs.readFileSync(SCHOOLS_PATH, 'utf-8'));
  const schoolFeatures: Array<{ geometry: { type: string; coordinates: number[] }; properties: SchoolProps }> =
    (schoolsGeo.features ?? []).filter((f: { properties: SchoolProps }) => f.properties.school_type === 'public');

  const schoolsByKey = new Map<string, SchoolCandidate[]>();

  for (const f of schoolFeatures) {
    if (f.geometry?.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    if (typeof lon !== 'number' || typeof lat !== 'number' || isNaN(lon) || isNaN(lat)) continue;

    const p = f.properties;
    const dKey = geoidToKey.get(p.district_geoid) ?? districtKey(p.district_name);

    const candidate: SchoolCandidate = {
      name: p.name,
      ncesId: p.nces_id,
      gradeLow: typeof p.grades_low === 'number' ? p.grades_low : null,
      gradeHigh: typeof p.grades_high === 'number' ? p.grades_high : null,
      gradeBucket: p.grade_bucket ?? '',
      districtGeoid: p.district_geoid,
      districtName: p.district_name,
      lat,
      lon,
      enrollment: lookupEnrollment(p.district_name, p.name),
      likelyCharter: CHARTER_PATTERNS.test(p.name) || ALTERNATIVE_PATTERNS.test(p.name),
    };

    if (!schoolsByKey.has(dKey)) schoolsByKey.set(dKey, []);
    schoolsByKey.get(dKey)!.push(candidate);
  }

  // D) Build anchors
  const anchors: AnchorsMap = {};
  let hsCount = 0, elemCount = 0, fallbackCount = 0, heuristicCount = 0, charterCount = 0;

  for (const [key, fb] of fallbacks) {
    const candidates = schoolsByKey.get(key) ?? [];
    const hsCandidates = candidates.filter(isHighSchool);
    const elemCandidates = candidates.filter(isElementary);

    let anchor: DistrictAnchor;

    if (hsCandidates.length > 0) {
      const { winner, flags } = pickBest(hsCandidates);
      flags.push('anchor_high_school');
      anchor = {
        displayName: fb.displayName,
        lat: Math.round(winner.lat * 1e6) / 1e6,
        lon: Math.round(winner.lon * 1e6) / 1e6,
        anchorType: 'high_school',
        anchorSchool: {
          name: winner.name,
          ncesId: winner.ncesId,
          enrollment: winner.enrollment,
          gradeLow: winner.gradeLow,
          gradeHigh: winner.gradeHigh,
          gradeBucket: winner.gradeBucket,
          districtGeoid: winner.districtGeoid,
          districtName: winner.districtName,
        },
        flags,
      };
      hsCount++;
      if (flags.includes('anchor_used_heuristic_no_enrollment')) heuristicCount++;
      if (flags.includes('anchor_may_be_charter')) charterCount++;
    } else if (elemCandidates.length > 0) {
      const { winner, flags } = pickBest(elemCandidates);
      flags.push('anchor_elementary_school');
      anchor = {
        displayName: fb.displayName,
        lat: Math.round(winner.lat * 1e6) / 1e6,
        lon: Math.round(winner.lon * 1e6) / 1e6,
        anchorType: 'elementary_school',
        anchorSchool: {
          name: winner.name,
          ncesId: winner.ncesId,
          enrollment: winner.enrollment,
          gradeLow: winner.gradeLow,
          gradeHigh: winner.gradeHigh,
          gradeBucket: winner.gradeBucket,
          districtGeoid: winner.districtGeoid,
          districtName: winner.districtName,
        },
        flags,
      };
      elemCount++;
      if (flags.includes('anchor_used_heuristic_no_enrollment')) heuristicCount++;
      if (flags.includes('anchor_may_be_charter')) charterCount++;
    } else {
      anchor = {
        displayName: fb.displayName,
        lat: Math.round(fb.lat * 1e6) / 1e6,
        lon: Math.round(fb.lon * 1e6) / 1e6,
        anchorType: 'fallback',
        anchorSchool: null,
        flags: [...fb.flags, 'anchor_fallback_no_school_candidates'],
      };
      fallbackCount++;
    }

    anchors[key] = anchor;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(anchors, null, 2));

  console.log(`  Total districts:        ${fallbacks.size}`);
  console.log(`  Anchored to HS:         ${hsCount}`);
  console.log(`  Anchored to elementary:  ${elemCount}`);
  console.log(`  Fallback (no schools):   ${fallbackCount}`);
  console.log(`  Heuristic (no enroll):   ${heuristicCount}`);
  console.log(`  May-be-charter:          ${charterCount}`);
  console.log(`  Output: ${OUT_FILE}\n`);

  for (const k of Object.keys(anchors).sort()) {
    const a = anchors[k];
    const school = a.anchorSchool ? ` -> ${a.anchorSchool.name}` : '';
    const enr = a.anchorSchool?.enrollment ? ` (${a.anchorSchool.enrollment})` : '';
    console.log(`  ${k.padEnd(30)} ${a.anchorType.padEnd(20)}${school}${enr}`);
  }
}

main();
