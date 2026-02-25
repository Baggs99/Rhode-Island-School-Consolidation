#!/usr/bin/env node
/**
 * Build public_schools.geojson from NCES CCD directory CSV + EDGE Geocode (for coordinates).
 * CCD does not include lat/lon; we merge with EDGE Geocode by NCESSCH.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as shapefile from 'shapefile';
import AdmZip from 'adm-zip';
import type { Feature, FeatureCollection } from 'geojson';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const FALLBACK_CACHE_PATH = path.join(DATA_DIR, 'public_school_fallback_geocodes.json');
const COORD_OVERRIDES_PATH = path.join(DATA_DIR, 'public_school_coordinate_overrides.json');
const RI_BBOX_WIDE = { minLon: -72.1, maxLon: -70.7, minLat: 40.9, maxLat: 42.3 };
const RI_STATE_FIPS = '44';
const EDGE_PUBLIC_URL = 'https://nces.ed.gov/programs/edge/data/EDGE_GEOCODE_PUBLICSCH_2223.zip';

interface SchoolProps {
  id: string;
  name: string;
  school_type: 'public';
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  grades_low?: number;
  grades_high?: number;
  grade_bucket: 'Elementary' | 'Middle' | 'High' | 'Other';
  lat: number;
  lon: number;
  district_geoid?: string;
  district_name?: string;
  source: string;
  nces_id?: string;
}

function ensureDirs(): void {
  [DATA_DIR, RAW_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    console.log(`  Downloading EDGE Geocode...`);
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    console.log(`  Saved to ${path.basename(destPath)}`);
    return true;
  } catch (e) {
    console.warn(`  Download failed: ${e}`);
    return false;
  }
}

function deriveGradeBucket(low?: number, high?: number): 'Elementary' | 'Middle' | 'High' | 'Other' {
  if (low == null && high == null) return 'Other';
  const lo = low ?? 0;
  const hi = high ?? 12;
  if (hi <= 5 || (lo <= 5 && hi <= 8)) return 'Elementary';
  if (lo >= 6 && hi <= 8) return 'Middle';
  if (lo >= 9 || hi >= 9) return 'High';
  return 'Other';
}

function parseGrade(val: string | number | undefined): number | undefined {
  if (val == null || val === '' || val === 'N' || val === 'M' || String(val) === '-1') return undefined;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return isNaN(n) ? undefined : n;
}

function inRIBBoxWide(lat: number, lon: number): boolean {
  return (
    lat >= RI_BBOX_WIDE.minLat &&
    lat <= RI_BBOX_WIDE.maxLat &&
    lon >= RI_BBOX_WIDE.minLon &&
    lon <= RI_BBOX_WIDE.maxLon
  );
}

interface FallbackCacheEntry {
  lat: number;
  lon: number;
  source: 'CensusGeocoder';
  matchedAddress?: string;
}

type FallbackCache = Record<string, FallbackCacheEntry>;

function loadCoordOverrides(): Record<string, { lat: number; lon: number }> {
  if (!fs.existsSync(COORD_OVERRIDES_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(COORD_OVERRIDES_PATH, 'utf-8'));
    const out: Record<string, { lat: number; lon: number }> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      const entry = v as { lat?: number; lon?: number };
      if (entry && typeof entry.lat === 'number' && typeof entry.lon === 'number') {
        out[String(k)] = { lat: entry.lat, lon: entry.lon };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadFallbackCache(): FallbackCache {
  if (!fs.existsSync(FALLBACK_CACHE_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(FALLBACK_CACHE_PATH, 'utf-8'));
    return typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveFallbackCache(cache: FallbackCache): void {
  fs.writeFileSync(FALLBACK_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function geocodeWithCensus(
  street: string,
  city: string,
  state: string,
  zip: string
): Promise<{ lat: number; lon: number; matchedAddress?: string } | null> {
  const parts = [street, city, state, zip].filter(Boolean);
  if (parts.length < 2) return null;
  const address = parts.join(', ');
  const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const matches = data?.result?.addressMatches;
    if (!Array.isArray(matches) || matches.length === 0) return null;
    const m = matches[0];
    const x = parseFloat(m?.coordinates?.x);
    const y = parseFloat(m?.coordinates?.y);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return {
      lat: y,
      lon: x,
      matchedAddress: m.matchedAddress,
    };
  } catch {
    return null;
  }
}

async function loadEdgeCoords(): Promise<Map<string, { lat: number; lon: number }>> {
  const zipPath = path.join(RAW_DIR, 'EDGE_GEOCODE_PUBLICSCH_2223.zip');
  if (!fs.existsSync(zipPath)) {
    const ok = await downloadFile(EDGE_PUBLIC_URL, zipPath);
    if (!ok) {
      throw new Error(
        `EDGE Geocode not found. Download from ${EDGE_PUBLIC_URL} and save to ${zipPath}`
      );
    }
  }
  const extractDir = path.join(RAW_DIR, 'edge_geocode_extract');
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
  }
  function findShp(dir: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = findShp(full);
        if (found) return found;
      } else if (e.name.endsWith('.shp')) return full;
    }
    return null;
  }
  const shpPath = findShp(extractDir);
  if (!shpPath) {
    throw new Error(`EDGE zip has no .shp file in ${extractDir}`);
  }
  const geojson = await shapefile.read(shpPath);
  const features = (geojson as FeatureCollection).features || [];
  const map = new Map<string, { lat: number; lon: number }>();
  for (const f of features) {
    const p = (f as Feature).properties || {};
    const stateFips = String(p.STFIP ?? p.OPSTFIPS ?? '').padStart(2, '0');
    if (stateFips !== RI_STATE_FIPS) continue;
    const ncessch = String(p.NCESSCH ?? p.ncessch ?? '').trim();
    const lat = parseFloat(p.LAT ?? p.lat);
    const lon = parseFloat(p.LON ?? p.lon);
    if (ncessch && !isNaN(lat) && !isNaN(lon) && inRIBBoxWide(lat, lon)) {
      map.set(ncessch, { lat, lon });
    }
  }
  return map;
}

function findCcdPath(): string {
  const candidates = [
    path.join(PROJECT_ROOT, 'Rhode Island Public Schools', 'ccd_sch_029_2425_w_1a_073025.csv'),
    path.join(PROJECT_ROOT, 'Rhode Island Public Schools', 'ccd_sch*.csv'),
  ];
  const exact = candidates[0];
  if (fs.existsSync(exact)) return exact;
  const dir = path.join(PROJECT_ROOT, 'Rhode Island Public Schools');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('ccd_sch') && f.endsWith('.csv'));
    if (files[0]) return path.join(dir, files[0]);
  }
  throw new Error(`CCD CSV not found. Place ccd_sch_029_2425_w_1a_073025.csv in "Rhode Island Public Schools/"`);
}

async function main(): Promise<void> {
  console.log('Building public_schools.geojson from CCD + EDGE Geocode\n');

  ensureDirs();
  const ccdPath = findCcdPath();
  console.log(`  Reading CCD: ${path.relative(PROJECT_ROOT, ccdPath)}`);

  const csvText = fs.readFileSync(ccdPath, 'utf-8').trim();
  const rows = parse(csvText, { columns: true, bom: true, relax_column_count: true });

  const totalRows = rows.length;
  const riRows = rows.filter((r: Record<string, string>) => {
    const st = (r.LSTATE ?? r.ST ?? '').trim();
    const fipst = String(r.FIPST ?? '').padStart(2, '0');
    return st === 'RI' || fipst === RI_STATE_FIPS;
  });

  console.log(`  Total rows: ${totalRows}`);
  console.log(`  RI rows: ${riRows.length}`);

  const uniqueByNcessch = new Map<string, Record<string, string>>();
  for (const r of riRows) {
    const id = String(r.NCESSCH ?? r.ncessch ?? '').trim();
    if (id && !uniqueByNcessch.has(id)) uniqueByNcessch.set(id, r);
  }
  const uniqueRows = [...uniqueByNcessch.values()];
  console.log(`  Unique RI schools by NCESSCH: ${uniqueRows.length}`);

  const edgeCoords = await loadEdgeCoords();
  const fallbackCache = loadFallbackCache();
  const coordOverrides = loadCoordOverrides();

  let usedEdge = 0;
  let usedCachedFallback = 0;
  let newlyGeocoded = 0;
  const failedGeocode: { ncessch: string; name: string; address: string }[] = [];

  const schools: Feature<GeoJSON.Point, SchoolProps>[] = [];

  for (const row of uniqueRows) {
    const ncessch = String(row.NCESSCH ?? row.ncessch ?? '').trim();
    const street =
      [row.LSTREET1, row.LSTREET2, row.LSTREET3].filter(Boolean).join(', ') ||
      row.MSTREET1 ||
      '';
    const city = row.LCITY ?? row.MCITY ?? '';
    const state = row.LSTATE ?? row.MSTATE ?? 'RI';
    const zip = row.LZIP ?? row.MZIP ?? '';

    let coords: { lat: number; lon: number } | undefined = edgeCoords.get(ncessch);
    if (coords) {
      usedEdge++;
    } else {
      const cached = fallbackCache[ncessch];
      if (cached) {
        coords = { lat: cached.lat, lon: cached.lon };
        usedCachedFallback++;
      } else {
        const geo = await geocodeWithCensus(street, city, state, zip);
        if (geo) {
          coords = { lat: geo.lat, lon: geo.lon };
          fallbackCache[ncessch] = {
            lat: geo.lat,
            lon: geo.lon,
            source: 'CensusGeocoder',
            matchedAddress: geo.matchedAddress,
          };
          newlyGeocoded++;
        }
      }
    }

    if (!coords) {
      const addr = [street, city, state, zip].filter(Boolean).join(', ');
      failedGeocode.push({
        ncessch,
        name: (row.SCH_NAME ?? row.sch_name ?? 'Unknown').trim(),
        address: addr || '(no address)',
      });
      continue;
    }

    const override = coordOverrides[ncessch];
    const lat = override ? override.lat : coords.lat;
    const lon = override ? override.lon : coords.lon;
    const name = (row.SCH_NAME ?? row.sch_name ?? 'Unknown').trim();
    const gLow = parseGrade(row.GSLO ?? row.gslo);
    const gHigh = parseGrade(row.GSHI ?? row.gshi);

    schools.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: `public_${ncessch}`,
        name,
        school_type: 'public',
        street: street || undefined,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
        grades_low: gLow,
        grades_high: gHigh,
        grade_bucket: deriveGradeBucket(gLow, gHigh),
        lat,
        lon,
        district_geoid: row.LEAID?.trim() || undefined,
        district_name: row.LEA_NAME?.trim() || undefined,
        source: 'NCES_CCD_2024_2025',
        nces_id: ncessch || undefined,
      },
    });
  }

  if (newlyGeocoded > 0) saveFallbackCache(fallbackCache);

  console.log(`  Schools using EDGE coords: ${usedEdge}`);
  console.log(`  Schools using cached fallback: ${usedCachedFallback}`);
  console.log(`  Schools newly geocoded this run: ${newlyGeocoded}`);
  if (failedGeocode.length > 0) {
    console.log(`  Failed geocoding (${failedGeocode.length}):`);
    for (const f of failedGeocode) {
      console.log(`    ${f.ncessch} | ${f.name} | ${f.address}`);
    }
  }
  console.log(`  Total output: ${schools.length} schools`);
  console.log(`  First 5: ${schools.slice(0, 5).map((s) => s.properties.name).join(', ')}`);

  if (schools.length < 250) {
    console.warn(`  Sanity check: expected ~250+ RI public schools, got ${schools.length}`);
  } else {
    console.log(`  Sanity check: ${schools.length} public schools (>= 250)`);
  }

  const fc: FeatureCollection<GeoJSON.Point, SchoolProps> = {
    type: 'FeatureCollection',
    features: schools,
  };
  const outPath = path.join(DATA_DIR, 'public_schools.geojson');
  fs.writeFileSync(outPath, JSON.stringify(fc, null, 0));
  console.log(`\n  Wrote ${outPath} (${schools.length} features)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
