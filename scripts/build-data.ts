#!/usr/bin/env node
/**
 * Rhode Island School Map - Data Build Script
 *
 * Builds districts.geojson and schools.geojson from public data sources.
 * Supports automated download (when URLs are accessible) or manual file placement in /data/raw.
 *
 * Data Sources:
 * - Districts: US Census TIGER/Line or NCES EDGE school district boundaries
 * - Public schools: NCES EDGE Geocode (derived from CCD) or CCD directory
 * - Private schools: NCES PSS (Private School Universe Survey)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import shp from 'shpjs';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point, type Feature, type FeatureCollection, type Polygon, type MultiPolygon } from 'geojson';

const DATA_DIR = path.join(process.cwd(), 'data');
const RAW_DIR = path.join(DATA_DIR, 'raw');

// Rhode Island bounding box (approximate)
const RI_BBOX = { minLon: -71.9, maxLon: -71.0, minLat: 41.1, maxLat: 42.0 };
const RI_STATE_FIPS = '44';
const RI_STATE_ABBR = 'RI';

// Data source URLs (may require manual download if blocked)
const URLS = {
  districts: 'https://www2.census.gov/geo/tiger/TIGER2023/UNSD/tl_2023_44_unsd.zip',
  districtsAlt: 'https://nces.ed.gov/programs/edge/data/EDGE_SCHOOLDISTRICT_TL22_SY2122.zip',
  publicSchools: 'https://nces.ed.gov/programs/edge/data/EDGE_GEOCODE_PUBLICSCH_2223.zip',
  privateSchools: 'https://nces.ed.gov/surveys/pss/zip/pss2122_pu_csv.zip',
};

interface DistrictProperties {
  // legacy fields (still populated for compatibility)
  name: string;
  geoid: string;
  // normalized fields required by frontend/API
  district_name: string;
  district_geoid: string;
  district_type?: string;
  statefp?: string;
  unsdleaid?: string;
}

interface SchoolProperties {
  id: string;
  name: string;
  school_type: 'public' | 'private';
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
  source: 'NCES_CCD' | 'NCES_PSS';
  nces_id?: string;
  pss_id?: string;
}

type SchoolFeature = Feature<GeoJSON.Point, SchoolProperties>;
type DistrictGeom = Polygon | MultiPolygon;
type DistrictFeature = Feature<DistrictGeom, DistrictProperties>;

function ensureDirs(): void {
  [DATA_DIR, RAW_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    console.log(`  Downloading ${url}...`);
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    console.log(`  Saved to ${destPath}`);
    return true;
  } catch (e) {
    console.warn(`  Download failed: ${e}`);
    return false;
  }
}

function getOrDownload(filename: string, url: string): string {
  const dest = path.join(RAW_DIR, filename);
  if (fs.existsSync(dest)) {
    console.log(`  Using existing ${filename}`);
    return dest;
  }
  return '';
}

async function ensureRawFiles(opts?: { skipDistricts?: boolean }): Promise<{
  districtsPath: string;
  publicPath: string;
  privatePath: string;
}> {
  ensureDirs();
  const districtsGeojsonExists = fs.existsSync(path.join(DATA_DIR, 'districts.geojson'));
  const districtZip = path.join(RAW_DIR, 'tl_2023_44_unsd.zip');
  const edgeDistrictZip = path.join(RAW_DIR, 'EDGE_SCHOOLDISTRICT_TL22_SY2122.zip');
  const publicZip = path.join(RAW_DIR, 'EDGE_GEOCODE_PUBLICSCH_2223.zip');
  const privateZip = path.join(RAW_DIR, 'pss2122_pu_csv.zip');

  const skipDistricts = opts?.skipDistricts ?? districtsGeojsonExists;
  if (!skipDistricts && !fs.existsSync(districtZip) && !fs.existsSync(edgeDistrictZip)) {
    const ok = await downloadFile(URLS.districts, districtZip);
    if (!ok) await downloadFile(URLS.districtsAlt, edgeDistrictZip);
  }
  if (!fs.existsSync(publicZip)) {
    await downloadFile(URLS.publicSchools, publicZip);
  }
  if (!fs.existsSync(privateZip)) {
    await downloadFile(URLS.privateSchools, privateZip);
  }

  const districtsPath = fs.existsSync(districtZip) ? districtZip : edgeDistrictZip;
  if (!skipDistricts && !fs.existsSync(districtsPath)) {
    throw new Error(
      'District boundaries not found. Run `npm run build:districts` first, or download one of:\n' +
        `  1. ${URLS.districts}\n` +
        `  2. ${URLS.districtsAlt}\n` +
        `  Save to ${RAW_DIR}/tl_2023_44_unsd.zip or EDGE_SCHOOLDISTRICT_TL22_SY2122.zip`
    );
  }
  if (!fs.existsSync(publicZip)) {
    throw new Error(
      `Public schools not found. Download ${URLS.publicSchools} and save to ${publicZip}`
    );
  }
  if (!fs.existsSync(privateZip)) {
    throw new Error(
      `Private schools not found. Download ${URLS.privateSchools} and save to ${privateZip}`
    );
  }

  return {
    districtsPath: skipDistricts ? '' : districtsPath,
    publicPath: publicZip,
    privatePath: privateZip,
  };
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

function inRIBBox(lat: number, lon: number): boolean {
  return lat >= RI_BBOX.minLat && lat <= RI_BBOX.maxLat && lon >= RI_BBOX.minLon && lon <= RI_BBOX.maxLon;
}

function parseGrade(val: string | number | undefined): number | undefined {
  if (val == null || val === '' || val === 'N' || val === 'M' || String(val) === '-1') return undefined;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return isNaN(n) ? undefined : n;
}

async function buildDistricts(districtsPath: string): Promise<FeatureCollection<DistrictGeom, DistrictProperties>> {
  console.log('Building districts.geojson...');
  const buf = fs.readFileSync(districtsPath);
  const geojson = await shp(buf);
  const features = Array.isArray(geojson) ? geojson : [geojson];
  const districts: DistrictFeature[] = [];

  for (const fc of features) {
    const feats = (fc as FeatureCollection).features || [];
    for (const f of feats) {
      if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') continue;
      const props = f.properties || {};
      const stateFips = String(props.STATEFP ?? props.statefp ?? '').padStart(2, '0');
      if (stateFips !== RI_STATE_FIPS) continue;

      const baseName = (props.NAME ?? props.NAME20 ?? props.UNSDNAME ?? 'Unknown').trim();
      const geoid = String(props.GEOID ?? props.geoid ?? props.UNSDLEA ?? '').trim();
      const lsad: string | undefined = props.LSAD ?? props.lsad;
      let districtType: string | undefined;
      if (lsad) {
        const l = String(lsad).toLowerCase();
        if (l.includes('unified')) districtType = 'Unified';
        else if (l.includes('elementary')) districtType = 'Elementary';
        else if (l.includes('secondary')) districtType = 'Secondary';
      }
      if (!districtType) districtType = 'Unified';

      const geom = f.geometry as DistrictGeom;
      districts.push({
        type: 'Feature',
        geometry: geom,
        properties: {
          name: baseName,
          geoid,
          district_name: baseName,
          district_geoid: geoid,
          district_type: districtType,
          statefp: stateFips,
          unsdleaid: props.UNSDLEA ?? props.unsdleaid,
        },
      });
    }
  }

  const fc: FeatureCollection<DistrictGeom, DistrictProperties> = {
    type: 'FeatureCollection',
    features: districts,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'districts.geojson'), JSON.stringify(fc, null, 0));
  console.log(`  Wrote ${districts.length} district features`);
  console.log(
    `  Sample districts: ${districts
      .slice(0, 5)
      .map((d) => d.properties.district_name)
      .join(', ')}`
  );
  console.log('  CRS: assumed EPSG:4326 (WGS84 lon/lat) as in TIGER/Cartographic boundary files.');
  return fc;
}

async function buildSchools(
  publicPath: string,
  privatePath: string,
  districts: FeatureCollection<DistrictGeom, DistrictProperties>
): Promise<void> {
  console.log('Building schools.geojson...');
  const schools: SchoolFeature[] = [];
  const seen = new Set<string>();

  const assignDistrict = (lat: number, lon: number): { geoid?: string; name?: string } => {
    const pt = point([lon, lat]);
    for (const f of districts.features) {
      if (booleanPointInPolygon(pt, f.geometry as any)) {
        return {
          geoid: f.properties.district_geoid ?? f.properties.geoid,
          name: f.properties.district_name ?? f.properties.name,
        };
      }
    }
    return { name: 'Unknown' };
  };

  // Public schools (EDGE Geocode shapefile)
  const publicBuf = fs.readFileSync(publicPath);
  const publicGeo = await shp(publicBuf);
  const publicFeats = Array.isArray(publicGeo) ? publicGeo.flatMap((g: any) => g.features || []) : (publicGeo as FeatureCollection).features || [];
  for (const f of publicFeats) {
    const props = f.properties || {};
    if (String(props.STFIP ?? props.OPSTFIPS ?? '').padStart(2, '0') !== RI_STATE_FIPS) continue;
    const lat = parseFloat(props.LAT ?? props.lat);
    const lon = parseFloat(props.LON ?? props.lon);
    if (isNaN(lat) || isNaN(lon) || !inRIBBox(lat, lon)) continue;
    const ncesId = String(props.NCESSCH ?? props.ncessch ?? '');
    const key = `public_${ncesId}_${lat}_${lon}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const gLow = parseGrade(props.GSLO ?? props.gslo);
    const gHigh = parseGrade(props.GSHI ?? props.gshi);
    const district = assignDistrict(lat, lon);

    schools.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: `public_${ncesId || Date.now()}_${schools.length}`,
        name: (props.NAME ?? props.name ?? 'Unknown').trim(),
        school_type: 'public',
        street: props.STREET ?? props.street,
        city: props.CITY ?? props.city,
        state: props.STATE ?? props.state ?? RI_STATE_ABBR,
        zip: props.ZIP ?? props.zip,
        grades_low: gLow,
        grades_high: gHigh,
        grade_bucket: deriveGradeBucket(gLow, gHigh),
        lat,
        lon,
        district_geoid: district.geoid,
        district_name: district.name,
        source: 'NCES_CCD',
        nces_id: ncesId || undefined,
      },
    });
  }

  // Private schools (PSS CSV)
  const AdmZip = await import('adm-zip').catch(() => null);
  const zip = AdmZip ? new (AdmZip as any).default(privatePath) : null;
  const csvName = zip?.getEntries().find((e: any) => e.entryName.toLowerCase().endsWith('.csv'))?.entryName;
  if (!csvName) throw new Error('PSS ZIP has no CSV file');
  const csvBuf = zip!.readFile(csvName);
  const csvText = (typeof csvBuf === 'string' ? csvBuf : csvBuf.toString('utf-8')).trim();
  const delim = csvText.includes('\t') ? '\t' : ',';
  const rows = parse(csvText, { columns: true, bom: true, relax_column_count: true, delimiter: delim });

  const latCols = ['LATITUDE22', 'LATITUDE', 'LAT', 'lat', 'latitude'];
  const lonCols = ['LONGITUDE22', 'LONGITUDE', 'LON', 'lon', 'longitude'];
  const nameCols = ['PINST', 'SCHNAM', 'SCHOOL_NAME', 'NAME', 'name'];
  const streetCols = ['LSOURCE', 'LSTREET1', 'STREET', 'street'];
  const cityCols = ['LCITY', 'LCITYM', 'CITY', 'city'];
  const stateCols = ['LSTATE', 'LSTABB', 'STATE', 'state'];
  const zipCols = ['LZIP', 'LZIP4', 'ZIP', 'zip'];
  const loGradeCols = ['LOGR2022', 'LGREEN', 'GSLO', 'grades_low'];
  const hiGradeCols = ['HIGR2022', 'UGREEN', 'GSHI', 'grades_high'];

  const getCol = (row: Record<string, string>, cols: string[]) => {
    for (const c of cols) if (row[c] != null && row[c] !== '') return row[c];
    return undefined;
  };

  const gradeRecode: Record<string, number> = {
    '1': 0, '2': 0, '3': 5, '4': 0, '5': 1, '6': 1, '7': 2, '8': 3, '9': 4, '10': 5, '11': 6, '12': 7, '13': 8, '14': 9, '15': 10, '16': 11, '17': 12,
  };

  for (const row of rows) {
    const state = getCol(row, stateCols);
    if (state !== 'RI' && state !== '44' && String(state || '').toUpperCase() !== 'RHODE ISLAND') continue;

    const latRaw = getCol(row, latCols);
    const lonRaw = getCol(row, lonCols);
    const lat = parseFloat(String(latRaw || '').replace(/,/g, ''));
    const lon = parseFloat(String(lonRaw || '').replace(/,/g, ''));
    if (isNaN(lat) || isNaN(lon) || !inRIBBox(lat, lon)) continue;

    const pssId = getCol(row, ['PPIN', 'PIN', 'PPIN']) ?? '';
    const name = (getCol(row, nameCols) ?? 'Unknown').trim();
    const key = `private_${pssId}_${lat}_${lon}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let gLow: number | undefined;
    let gHigh: number | undefined;
    const loR = getCol(row, loGradeCols);
    const hiR = getCol(row, hiGradeCols);
    if (loR != null) gLow = gradeRecode[String(loR)] ?? parseInt(String(loR), 10);
    if (hiR != null) gHigh = gradeRecode[String(hiR)] ?? parseInt(String(hiR), 10);
    if (isNaN(gLow!)) gLow = undefined;
    if (isNaN(gHigh!)) gHigh = undefined;

    const district = assignDistrict(lat, lon);

    schools.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: `private_${pssId || Date.now()}_${schools.length}`,
        name,
        school_type: 'private',
        street: getCol(row, streetCols),
        city: getCol(row, cityCols),
        state: state ?? RI_STATE_ABBR,
        zip: getCol(row, zipCols),
        grades_low: gLow,
        grades_high: gHigh,
        grade_bucket: deriveGradeBucket(gLow, gHigh),
        lat,
        lon,
        district_geoid: district.geoid,
        district_name: district.name,
        source: 'NCES_PSS',
        pss_id: pssId || undefined,
      },
    });
  }

  // De-dupe by name+coordinates
  const byKey = new Map<string, SchoolFeature>();
  for (const s of schools) {
    const p = s.properties;
    const k = `${p.name}|${p.lat}|${p.lon}`;
    if (!byKey.has(k)) byKey.set(k, s);
    else if (p.school_type === 'public' && byKey.get(k)!.properties.school_type === 'private') byKey.set(k, s);
  }
  const deduped = Array.from(byKey.values());

  const fc: FeatureCollection<GeoJSON.Point, SchoolProperties> = {
    type: 'FeatureCollection',
    features: deduped,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'schools.geojson'), JSON.stringify(fc, null, 0));
  console.log(`  Wrote ${deduped.length} school features (${publicFeats.filter((f: any) => (f.properties?.STFIP ?? f.properties?.OPSTFIPS) === '44').length} public, ${rows.filter((r: any) => (r.LSTATE ?? r.STATE) === 'RI').length} private before dedup)`);
}

async function main(): Promise<void> {
  console.log('RI School Map - Build Data\n');
  const districtsGeojsonPath = path.join(DATA_DIR, 'districts.geojson');
  let districts: FeatureCollection<DistrictGeom, DistrictProperties>;
  const { districtsPath, publicPath, privatePath } = await ensureRawFiles();
  if (fs.existsSync(districtsGeojsonPath)) {
    console.log('Using existing districts.geojson (from build:districts)\n');
    districts = JSON.parse(fs.readFileSync(districtsGeojsonPath, 'utf-8'));
  } else if (districtsPath) {
    districts = await buildDistricts(districtsPath);
  } else {
    throw new Error('districts.geojson not found. Run `npm run build:districts` first.');
  }
  await buildSchools(publicPath, privatePath, districts);
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
