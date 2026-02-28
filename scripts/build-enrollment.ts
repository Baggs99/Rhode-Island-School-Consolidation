#!/usr/bin/env node
/**
 * Build enrollment JSON from RIDE Oct 2024 CSVs.
 * Output: frontend/public/enrollment/ri_lea_enrollment_2024-10.json, ri_school_enrollment_2024-10.json
 * Run: npm run build:enrollment
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const PROJECT_ROOT = process.cwd();
const ENROLLMENT_DATA_DIR = path.join(PROJECT_ROOT, 'Enrollment Data (As of 2024)');
const LEGACY_DATA_DIR = path.join(PROJECT_ROOT, 'data', 'enrollment');
const OUT_DIR = path.join(PROJECT_ROOT, 'frontend', 'public', 'enrollment');

const LEA_CSV_CANDIDATES = [
  path.join(ENROLLMENT_DATA_DIR, 'Actual 01OCT2024 Enrollment Data RI.csv'),
  path.join(ENROLLMENT_DATA_DIR, '01OCT2024 RI LEA Data.csv'),
  path.join(LEGACY_DATA_DIR, '01OCT2024 RI LEA Data.csv'),
];
const LEA_CSV = LEA_CSV_CANDIDATES.find((p) => fs.existsSync(p)) ?? LEA_CSV_CANDIDATES[0];

const SCHOOL_CSV_CANDIDATES = [
  path.join(ENROLLMENT_DATA_DIR, 'Actual 01OCT2024 By School Enrollment Data RI.csv'),
  path.join(ENROLLMENT_DATA_DIR, '01OCT2024 RI Data by School.csv'),
  path.join(LEGACY_DATA_DIR, '01OCT2024 RI Data by School.csv'),
];
const SCHOOL_CSV = SCHOOL_CSV_CANDIDATES.find((p) => fs.existsSync(p)) ?? SCHOOL_CSV_CANDIDATES[0];

import { normalizeDistrictName as normalize, districtKey as resolveDistrictKey } from './lib/normalize';

interface LeaRow {
  distcode?: string;
  distname?: string;
  total?: string;
  FRL?: string;
  LEP?: string;
  IEP?: string;
  [key: string]: string | undefined;
}

interface Demographics {
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

interface DistrictEnrollment {
  distcode: string;
  distname: string;
  total: number;
  elem_enrollment: number;
  sec_enrollment: number;
  FRL?: number;
  LEP?: number;
  IEP?: number;
  VOCED?: number;
  demographics?: Demographics;
  grades: Record<string, number>;
}

const ELEM_GRADES = ['GPK', 'GKG', 'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'KF', 'KG', 'PK', 'PF'];
const SEC_GRADES = ['G09', 'G10', 'G11', 'G12'];
const DEMO_FIELDS = ['NATIVE', 'ASIAN', 'BLACK', 'HISPANIC', 'MULTIRACE', 'PACIFICISLANDER', 'WHITE', 'FEMALE', 'MALE', 'OTHER'] as const;

function extractDemographics(row: Record<string, unknown>): Demographics | undefined {
  const d: Demographics = {};
  let hasAny = false;
  for (const f of DEMO_FIELDS) {
    const v = getNum(row, f, f.toLowerCase());
    if (v > 0) { (d as Record<string, number>)[f] = v; hasAny = true; }
  }
  return hasAny ? d : undefined;
}

function toNum(v: unknown): number {
  if (v == null || v === '' || v === 'N' || v === 'M') return 0;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/,/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function getCol(row: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v != null && String(v).trim()) return String(v).trim();
    const lower = Object.keys(row).find((k) => k.toLowerCase() === n.toLowerCase());
    if (lower && row[lower] != null) return String(row[lower]).trim();
  }
  return undefined;
}

function getNum(row: Record<string, unknown>, ...names: string[]): number {
  for (const n of names) {
    const v = row[n];
    if (v != null) return toNum(v);
    const lower = Object.keys(row).find((k) => k.toLowerCase() === n.toLowerCase());
    if (lower && row[lower] != null) return toNum(row[lower]);
  }
  return 0;
}

/** Sample LEA enrollment for demo when CSVs are missing. Approximate Oct 2024 figures. */
function getSampleLeaEnrollment(): Record<string, { distcode: string; distname: string; total: number; elem_enrollment: number; sec_enrollment: number; grades: Record<string, number> }> {
  const samples: [string, number, number, number][] = [
    ['cumberland', 4829, 3200, 1629],
    ['providence', 22000, 14000, 8000],
    ['warwick', 9500, 5800, 3700],
    ['cranston', 9800, 6100, 3700],
    ['pawtucket', 8500, 5300, 3200],
    ['east providence', 5100, 3100, 2000],
    ['woonsocket', 5500, 3400, 2100],
    ['newport', 2300, 1400, 900],
    ['coventry', 4800, 3000, 1800],
    ['west warwick', 2600, 1600, 1000],
    ['north kingstown', 4200, 2600, 1600],
    ['south kingstown', 3200, 2000, 1200],
    ['lincoln', 3400, 2100, 1300],
    ['bristol-warren', 3300, 2100, 1200],
    ['barrington', 3100, 1900, 1200],
    ['north providence', 2200, 1400, 800],
    ['smithfield', 2800, 1700, 1100],
    ['north smithfield', 1800, 1100, 700],
    ['johnston', 2900, 1800, 1100],
    ['scituate', 1600, 1000, 600],
    ['central falls', 2900, 1800, 1100],
    ['tiverton', 2500, 1500, 1000],
    ['exeter-west greenwich', 1800, 1100, 700],
    ['foster-glocester', 1100, 700, 400],
    ['chariho', 3300, 2000, 1300],
    ['burrillville', 1900, 1200, 700],
    ['westerly', 2100, 1300, 800],
    ['new shoreham', 170, 100, 70],
    ['little compton', 550, 350, 200],
    ['east greenwich', 2400, 1500, 900],
  ];
  const out: Record<string, { distcode: string; distname: string; total: number; elem_enrollment: number; sec_enrollment: number; grades: Record<string, number> }> = {};
  for (const [key, total, elem, sec] of samples) {
    if (total === 0) continue;
    const distname = key.replace(/\b\w/g, (c) => c.toUpperCase());
    out[normalize(key)] = {
      distcode: '',
      distname,
      total,
      elem_enrollment: elem,
      sec_enrollment: sec,
      grades: {},
    };
  }
  return out;
}

function main(): void {
  console.log('Building enrollment JSON from RIDE Oct 2024 CSVs...\n');

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  if (!fs.existsSync(LEA_CSV)) {
    console.warn(`Missing LEA CSV: ${LEA_CSV}`);
    console.warn('Place "01OCT2024 RI LEA Data.csv" in data/enrollment/ - using sample data for demo.');
    const sampleLea = getSampleLeaEnrollment();
    fs.writeFileSync(path.join(OUT_DIR, 'ri_lea_enrollment_2024-10.json'), JSON.stringify(sampleLea));
    fs.writeFileSync(path.join(OUT_DIR, 'ri_school_enrollment_2024-10.json'), '{}');
    console.log(`Wrote sample LEA data (${Object.keys(sampleLea).length} districts). Run again after adding CSVs for real data.`);
    return;
  }

  const leaRaw = fs.readFileSync(LEA_CSV, 'utf-8');
  const schoolRaw = fs.existsSync(SCHOOL_CSV)
    ? fs.readFileSync(SCHOOL_CSV, 'utf-8')
    : '';
  if (!schoolRaw) {
    console.warn('School CSV missing - writing empty school enrollment.');
  }

  const leaRows = parse(leaRaw, { columns: true, skip_empty_lines: true }) as Record<string, unknown>[];
  const schoolRows = schoolRaw
    ? (parse(schoolRaw, { columns: true, skip_empty_lines: true }) as Record<string, unknown>[])
    : [];

  const leaMap: Record<string, DistrictEnrollment> = {};
  for (const row of leaRows) {
    const distname = getCol(row, 'distname', 'DistName', 'DISTNAME', 'LEANAME', 'lea_name');
    if (!distname) continue;
    const rawDistcode = getCol(row, 'distcode', 'DistCode', 'DISTCODE', 'LEAID', 'leaid') ?? '';
    const distcode = rawDistcode.includes('.') ? String(Math.round(parseFloat(rawDistcode))).padStart(2, '0') : rawDistcode;
    const total = getNum(row, 'total', 'Total', 'TOTAL');
    const grades: Record<string, number> = {};
    const gradeCols = [...ELEM_GRADES, ...SEC_GRADES, 'KF', 'KG', 'PK', 'PF'];
    for (const col of gradeCols) {
      const val = getNum(row, col, col.toLowerCase());
      if (val > 0) grades[col] = val;
    }
    for (const k of Object.keys(row)) {
      if (/^G\d{2}$/.test(k) || ['GPK', 'GKG', 'KF', 'KG', 'PK', 'PF'].includes(k)) {
        const v = getNum(row, k);
        if (v > 0) grades[k] = v;
      }
    }
    let elem = 0;
    let sec = 0;
    for (const g of ELEM_GRADES) {
      elem += grades[g] ?? 0;
    }
    for (const g of SEC_GRADES) {
      sec += grades[g] ?? 0;
    }
    const key = normalize(distname);
    if (!key) continue;
    leaMap[key] = {
      distcode,
      distname,
      total,
      elem_enrollment: elem,
      sec_enrollment: sec,
      FRL: getNum(row, 'FRL', 'frl') || undefined,
      LEP: getNum(row, 'LEP', 'lep') || undefined,
      IEP: getNum(row, 'IEP', 'iep') || undefined,
      VOCED: getNum(row, 'VOCED', 'voced') || undefined,
      demographics: extractDemographics(row),
      grades: Object.keys(grades).length ? grades : {},
    };
  }

  const schoolMap: Record<string, {
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
    grades: Record<string, number>;
  }> = {};
  for (const row of schoolRows) {
    const distname = getCol(row, 'distname', 'DistName', 'DISTNAME', 'LEANAME');
    const schname = getCol(row, 'schname', 'SchName', 'SCHNAME', 'SCH_NAME');
    if (!distname || !schname) continue;
    const distcode = getCol(row, 'distcode', 'DistCode', 'LEAID') ?? '';
    const schcode = getCol(row, 'schcode', 'SchCode', 'SCHCODE', 'NCESSCH') ?? '';
    const total = getNum(row, 'total', 'Total', 'TOTAL');
    const grades: Record<string, number> = {};
    for (const k of Object.keys(row)) {
      if (/^G\d{2}$/.test(k) || ['GPK', 'GKG', 'KF', 'KG', 'PK', 'PF'].includes(k)) {
        const v = getNum(row, k);
        if (v > 0) grades[k] = v;
      }
    }
    const key = normalize(distname) + '||' + normalize(schname);
    schoolMap[key] = {
      distcode,
      schcode,
      distname,
      schname,
      total,
      FRL: getNum(row, 'FRL', 'frl') || undefined,
      LEP: getNum(row, 'LEP', 'lep') || undefined,
      IEP: getNum(row, 'IEP', 'iep') || undefined,
      VOCED: getNum(row, 'VOCED', 'voced') || undefined,
      demographics: extractDemographics(row),
      grades: Object.keys(grades).length ? grades : {},
    };
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const leaPath = path.join(OUT_DIR, 'ri_lea_enrollment_2024-10.json');
  const schoolPath = path.join(OUT_DIR, 'ri_school_enrollment_2024-10.json');
  fs.writeFileSync(leaPath, JSON.stringify(leaMap));
  fs.writeFileSync(schoolPath, JSON.stringify(schoolMap));

  console.log(`  LEA districts: ${Object.keys(leaMap).length}`);
  console.log(`  Schools: ${Object.keys(schoolMap).length}`);
  console.log(`  Wrote ${leaPath}`);
  console.log(`  Wrote ${schoolPath}`);
}

main();
