#!/usr/bin/env node
/**
 * Build private_schools.geojson from NCES PSS (Private School Universe Survey) CSV.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import type { Feature, FeatureCollection } from 'geojson';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

interface SchoolProps {
  id: string;
  name: string;
  school_type: 'private';
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  grades_low?: number;
  grades_high?: number;
  grade_bucket: 'Elementary' | 'Middle' | 'High' | 'Other';
  lat: number;
  lon: number;
  district_geoid?: string | null;
  district_name?: string | null;
  source: string;
  pss_id?: string;
}

function ensureDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

function findPssPath(): string {
  const candidates = [
    path.join(PROJECT_ROOT, 'Rhode Island Private Schools', 'pss2122_pu.csv'),
  ];
  const exact = candidates[0];
  if (fs.existsSync(exact)) return exact;
  const dir = path.join(PROJECT_ROOT, 'Rhode Island Private Schools');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
    if (files[0]) return path.join(dir, files[0]);
  }
  throw new Error(`PSS CSV not found. Place pss2122_pu.csv in "Rhode Island Private Schools/"`);
}

async function main(): Promise<void> {
  console.log('Building private_schools.geojson from NCES PSS...\n');

  ensureDirs();
  const csvPath = findPssPath();
  console.log(`  Reading: ${path.relative(PROJECT_ROOT, csvPath)}`);

  const csvText = fs.readFileSync(csvPath, 'utf-8').trim();
  const delim = csvText.includes('\t') ? '\t' : ',';
  const rows = parse(csvText, { columns: true, bom: true, relax_column_count: true, delimiter: delim });

  console.log(`  Total rows in CSV: ${rows.length}`);

  const riRows = rows.filter((r: Record<string, string>) => r.PSTABB === 'RI');
  console.log(`  Total RI rows found: ${riRows.length}`);

  const getCol = (row: Record<string, string>, cols: string[]) => {
    for (const c of cols) if (row[c] != null && row[c] !== '') return row[c];
    return undefined;
  };

  const gradeRecode: Record<string, number> = {
    '1': 0, '2': 0, '3': 5, '4': 0, '5': 1, '6': 1, '7': 2, '8': 3, '9': 4, '10': 5, '11': 6, '12': 7, '13': 8, '14': 9, '15': 10, '16': 11, '17': 12,
  };

  let withCoords = 0;
  const schools: Feature<GeoJSON.Point, SchoolProps>[] = [];

  for (const row of riRows) {
    const lat = parseFloat(row.LATITUDE22);
    const lon = parseFloat(row.LONGITUDE22);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    withCoords++;

    const pssId = getCol(row, ['PPIN', 'PIN']) ?? '';
    const name = (getCol(row, ['PINST', 'SCHNAM', 'SCHOOL_NAME', 'NAME']) ?? 'Unknown').trim();
    const street = getCol(row, ['PADDRS', 'PL_ADD', 'STREET', 'street']);
    const city = getCol(row, ['PCITY', 'PL_CIT', 'CITY', 'city']);
    const state = row.PSTABB ?? 'RI';
    const zip = getCol(row, ['PZIP', 'PL_ZIP', 'ZIP', 'zip']);

    let gLow: number | undefined;
    let gHigh: number | undefined;
    const loR = getCol(row, ['LOGR2022', 'LGREEN', 'GSLO']);
    const hiR = getCol(row, ['HIGR2022', 'UGREEN', 'GSHI']);
    if (loR != null) gLow = gradeRecode[String(loR)] ?? parseInt(String(loR), 10);
    if (hiR != null) gHigh = gradeRecode[String(hiR)] ?? parseInt(String(hiR), 10);
    if (gLow !== undefined && isNaN(gLow)) gLow = undefined;
    if (gHigh !== undefined && isNaN(gHigh)) gHigh = undefined;

    schools.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: `private_${pssId || schools.length}`,
        name,
        school_type: 'private',
        street: street || undefined,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
        grades_low: gLow,
        grades_high: gHigh,
        grade_bucket: deriveGradeBucket(gLow, gHigh),
        lat,
        lon,
        district_geoid: undefined,
        district_name: undefined,
        source: 'NCES_PSS_2021_2022',
        pss_id: pssId || undefined,
      },
    });
  }

  console.log(`  Rows with numeric lat/lon: ${withCoords}`);
  console.log(`  Total RI private schools: ${riRows.length}`);
  console.log(`  With valid coordinates: ${withCoords}`);
  console.log(`  First 5 school names: ${schools.slice(0, 5).map((s) => s.properties.name).join(', ')}`);

  const fc: FeatureCollection<GeoJSON.Point, SchoolProps> = {
    type: 'FeatureCollection',
    features: schools,
  };
  const outPath = path.join(DATA_DIR, 'private_schools.geojson');
  fs.writeFileSync(outPath, JSON.stringify(fc, null, 0));
  console.log(`  Output features: ${schools.length}`);
  console.log(`\n  Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
