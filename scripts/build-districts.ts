#!/usr/bin/env node
/**
 * Merge Census TIGER UNSD, ELSD, SCSD Rhode Island school district shapefiles into one GeoJSON.
 * Input: Rhode Island United/Elementary/Secondary School Districts/tl_2025_44_*.shp
 * Output: data/districts.geojson (WGS84, FeatureCollection)
 * Dedup: same GEOID -> unified > secondary > elementary
 */

import * as fs from 'fs';
import * as path from 'path';
import * as shapefile from 'shapefile';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const LAYERS: { dir: string; base: string; level: 'unified' | 'elementary' | 'secondary'; source: string }[] = [
  { dir: 'Rhode Island United School Districts', base: 'tl_2025_44_unsd', level: 'unified', source: 'UNSD' },
  { dir: 'Rhode Island Elementary School Districts', base: 'tl_2025_44_elsd', level: 'elementary', source: 'ELSD' },
  { dir: 'Rhode Island Secondary School Districts', base: 'tl_2025_44_scsd', level: 'secondary', source: 'SCSD' },
];

const LEVEL_PRIORITY: Record<string, number> = { unified: 3, secondary: 2, elementary: 1 };
const REQUIRED_NAMES = ['Exeter-West Greenwich', 'Foster-Glocester', 'Little Compton'];

/**
 * Census TIGER classifies some RI regional districts as ELSD or SCSD,
 * but they operate locally as unified regional districts. Force them to "unified".
 */
const LEVEL_OVERRIDES: Record<string, 'unified' | 'elementary' | 'secondary'> = {
  '4400360': 'unified', // Exeter-West Greenwich Regional School District
};

/** Exclude "open ocean" / undefined districts (e.g., Census placeholder GEOID 4499997). */
const EXCLUDED_NAMES = [
  'school district not defined',
  'not defined',
  'undefined',
  'not applicable',
  'unknown',
];
const EXCLUDED_GEOIDS = new Set(['4499997', '4499998', '4499999']);

function isExcludedDistrict(name: string, geoid: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return true;
  if (EXCLUDED_GEOIDS.has(geoid)) return true;
  return EXCLUDED_NAMES.some((bad) => n === bad || n.includes(bad));
}

interface DistrictProperties {
  district_name: string;
  district_geoid: string;
  district_level: 'unified' | 'elementary' | 'secondary';
  source_layer: string;
  statefp?: string;
  countyfp?: string;
  name: string;
  geoid: string;
}

interface DistrictFeature {
  type: 'Feature';
  geometry: GeoJSON.Geometry;
  properties: DistrictProperties;
}

interface FeatureCollection {
  type: 'FeatureCollection';
  features: DistrictFeature[];
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nameContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function similarity(a: string, b: string): number {
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  if (sa === sb) return 1;
  if (sa.includes(sb) || sb.includes(sa)) return 0.8;
  let matches = 0;
  const minLen = Math.min(sa.length, sb.length);
  for (let i = 0; i < minLen; i++) if (sa[i] === sb[i]) matches++;
  return matches / Math.max(sa.length, sb.length);
}

async function readLayer(
  dir: string,
  base: string,
  level: 'unified' | 'elementary' | 'secondary',
  source: string
): Promise<DistrictFeature[]> {
  const shpPath = path.join(PROJECT_ROOT, dir, `${base}.shp`);
  if (!fs.existsSync(shpPath)) {
    console.warn(`  Skip ${source}: not found at ${shpPath}`);
    return [];
  }
  const geojson = await shapefile.read(shpPath);
  const raw = (geojson as GeoJSON.FeatureCollection).features ?? [];
  const out: DistrictFeature[] = [];
  for (const f of raw) {
    const geom = f.geometry;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
    const name = String(props.NAME ?? props.NAMELSAD ?? props.name ?? 'Unknown').trim();
    const geoid = String(props.GEOID ?? props.geoid ?? '').trim();
    if (isExcludedDistrict(name, geoid)) continue;
    out.push({
      type: 'Feature',
      geometry: geom,
      properties: {
        district_name: name,
        district_geoid: geoid,
        district_level: level,
        source_layer: source,
        statefp: props.STATEFP != null ? String(props.STATEFP) : undefined,
        countyfp: props.COUNTYFP != null ? String(props.COUNTYFP) : undefined,
        name,
        geoid,
      },
    });
  }
  return out;
}

async function main(): Promise<void> {
  console.log('Building districts.geojson from UNSD + ELSD + SCSD...\n');

  const allByLevel: DistrictFeature[][] = [[], [], []];
  for (let i = 0; i < LAYERS.length; i++) {
    const { dir, base, level, source } = LAYERS[i];
    const feats = await readLayer(dir, base, level, source);
    allByLevel[i] = feats;
    console.log(`  ${source}: ${feats.length} features`);
  }

  const byGeoid = new Map<string, DistrictFeature>();
  for (let i = LAYERS.length - 1; i >= 0; i--) {
    const level = LAYERS[i].level;
    for (const f of allByLevel[i]) {
      const geoid = f.properties.district_geoid;
      const existing = byGeoid.get(geoid);
      if (!existing || LEVEL_PRIORITY[level] > LEVEL_PRIORITY[existing.properties.district_level]) {
        byGeoid.set(geoid, f);
      }
    }
  }

  const features = Array.from(byGeoid.values());

  for (const f of features) {
    const override = LEVEL_OVERRIDES[f.properties.district_geoid];
    if (override && f.properties.district_level !== override) {
      console.log(`  Override: "${f.properties.district_name}" ${f.properties.district_level} -> ${override}`);
      f.properties.district_level = override;
    }
  }

  const fc: FeatureCollection = { type: 'FeatureCollection', features };
  ensureDataDir();
  const outPath = path.join(DATA_DIR, 'districts.geojson');
  fs.writeFileSync(outPath, JSON.stringify(fc));

  const counts = { unified: 0, elementary: 0, secondary: 0 };
  features.forEach((f) => counts[f.properties.district_level]++);
  console.log('\nCounts by level:');
  console.log(`  unified: ${counts.unified}, elementary: ${counts.elementary}, secondary: ${counts.secondary}`);
  console.log(`  total: ${features.length}`);
  console.log('\nCRS: EPSG:4326 (WGS84 lon/lat)\n');

  const names = features.map((f) => f.properties.district_name);
  for (const need of REQUIRED_NAMES) {
    const found = names.find((n) => nameContains(n, need));
    if (found) {
      console.log(`  ✓ Found: "${need}" -> "${found}"`);
    } else {
      const ranked = names
        .map((n) => ({ n, s: similarity(n, need) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 5);
      console.log(`  ✗ Not found: "${need}"`);
      console.log(`    Closest: ${ranked.map((r) => `"${r.n}"`).join(', ')}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
