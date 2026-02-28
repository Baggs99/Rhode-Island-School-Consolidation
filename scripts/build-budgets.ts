#!/usr/bin/env node
/**
 * Build budgets JSON from district budget CSVs.
 *
 * Input:  Budget Data/*.csv  (tab-delimited, possibly UTF-16)
 * Output: frontend/public/budgets/budgets.json
 *
 * Schema per district:
 *   displayName, sourceFile, fiscalYear, totalExpenditures,
 *   centralAdministration, components { districtManagement, programOperationsManagement },
 *   flags[]
 *
 * Run: npm run build:budgets
 */

import * as fs from 'fs';
import * as path from 'path';
import { districtKey } from './lib/normalize';

const PROJECT_ROOT = process.cwd();
const BUDGET_DIR_CANDIDATES = [
  path.join(PROJECT_ROOT, 'Budget Data'),
  path.join(PROJECT_ROOT, 'data', 'budgets'),
];
const BUDGET_DIR = BUDGET_DIR_CANDIDATES.find((d) => fs.existsSync(d)) ?? BUDGET_DIR_CANDIDATES[0];
const OUT_DIR = path.join(PROJECT_ROOT, 'frontend', 'public', 'budgets');

// --- Types ---

interface BudgetComponents {
  districtManagement: number;
  programOperationsManagement: number;
}

interface DistrictBudget {
  displayName: string;
  sourceFile: string;
  fiscalYear: string;
  totalExpenditures: number;
  centralAdministration: number;
  centralAdministrationModel: number;
  adminShareOfTotal: number | null;
  adminShareOfTotalModel: number | null;
  components: BudgetComponents;
  componentsModel: BudgetComponents;
  flags: string[];
}

type BudgetsMap = Record<string, DistrictBudget>;

const ADMIN_SHARE_OUTLIER = 0.15;
const ADMIN_SHARE_CAP = 0.10;

// Fiscal years in preference order (most recent first)
const FY_PREFERENCE = ['2025-26', '2024-25', '2023-24'];

// --- Helpers ---

function readFileWithEncodingFallback(filePath: string): string {
  const raw = fs.readFileSync(filePath);
  // Check for UTF-16 LE BOM (0xFF 0xFE)
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.toString('utf16le');
  }
  const utf8 = raw.toString('utf-8');
  // If the file has many replacement chars, try UTF-16 LE without BOM
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacementCount > 10) {
    return raw.toString('utf16le');
  }
  return utf8;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  return firstLine.includes('\t') ? '\t' : ',';
}

function parseMoney(value: string | undefined | null): number {
  if (value == null) return NaN;
  let s = String(value).trim();
  if (!s) return NaN;
  const isNegative = s.startsWith('(') && s.endsWith(')');
  s = s
    .replace(/[$,\s]/g, '')
    .replace(/^\(/, '')
    .replace(/\)$/, '');
  if (!s || s === '-') return NaN;
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return isNegative ? -n : n;
}

interface ParsedRow {
  cells: string[];
}

function parseTable(text: string, delimiter: string): { headerLines: string[][]; dataRows: ParsedRow[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { headerLines: [], dataRows: [] };

  const splitLine = (line: string): string[] => {
    if (delimiter === '\t') {
      return line.split('\t').map((c) => c.trim());
    }
    // CSV: basic split handling quoted fields
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === delimiter && !inQuotes) { cells.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  };

  const headerLines = [splitLine(lines[0]), splitLine(lines[1])];
  const dataRows: ParsedRow[] = [];
  for (let i = 2; i < lines.length; i++) {
    dataRows.push({ cells: splitLine(lines[i]) });
  }
  return { headerLines, dataRows };
}

interface ColumnMapping {
  revenueOrExpCol: number;
  detailsCol: number;
  detail2Col: number;
  leaNameCol: number;
  fyDollarColumns: { fy: string; colIndex: number }[];
}

function buildColumnMapping(headerLines: string[][]): ColumnMapping | null {
  if (headerLines.length < 2) return null;
  const fyRow = headerLines[0];
  const labelRow = headerLines[1];

  // Find label columns
  let revenueOrExpCol = -1;
  let detailsCol = -1;
  let detail2Col = -1;
  let leaNameCol = -1;

  for (let i = 0; i < labelRow.length; i++) {
    const lc = labelRow[i].toLowerCase().replace(/\s+/g, ' ').trim();
    if (lc === 'revenues or expenditures') revenueOrExpCol = i;
    else if (lc === 'details' || lc === 'detail 1') detailsCol = i;
    else if (lc === 'detail 2') detail2Col = i;
    else if (lc === 'lea name') leaNameCol = i;
  }

  if (detailsCol < 0) {
    // Try to find by position: col0=RevOrExp, col1=Details, col2=Detail2, col3=LEA
    if (labelRow.length >= 4) {
      revenueOrExpCol = 0;
      detailsCol = 1;
      detail2Col = 2;
      leaNameCol = 3;
    } else {
      return null;
    }
  }

  // Find FY dollar columns: look at fyRow for year patterns, then match with "$" in labelRow
  const fyDollarColumns: { fy: string; colIndex: number }[] = [];
  for (let i = 0; i < fyRow.length; i++) {
    const fyCell = fyRow[i].trim();
    const fyMatch = fyCell.match(/(\d{4})\s*-\s*(\d{2,4})/);
    if (fyMatch) {
      const labelBelow = (labelRow[i] ?? '').trim();
      if (labelBelow === '$' || labelBelow.toLowerCase().startsWith('$')) {
        const fy = `${fyMatch[1]}-${fyMatch[2].length === 2 ? fyMatch[2] : fyMatch[2].slice(-2)}`;
        fyDollarColumns.push({ fy, colIndex: i });
      }
    }
  }

  if (fyDollarColumns.length === 0) {
    // Fallback: find any column with "$" label and scan the FY row above
    for (let i = 0; i < labelRow.length; i++) {
      if ((labelRow[i] ?? '').trim() === '$') {
        // Walk left in fyRow to find the FY label
        let fy = '';
        for (let j = i; j >= 0; j--) {
          const cell = (fyRow[j] ?? '').trim();
          const m = cell.match(/(\d{4})\s*-\s*(\d{2,4})/);
          if (m) { fy = `${m[1]}-${m[2].length === 2 ? m[2] : m[2].slice(-2)}`; break; }
        }
        if (fy) fyDollarColumns.push({ fy, colIndex: i });
      }
    }
  }

  return { revenueOrExpCol, detailsCol, detail2Col, leaNameCol, fyDollarColumns };
}

function pickLatestFiscalYear(available: { fy: string; colIndex: number }[]): { fy: string; colIndex: number } | null {
  for (const preferred of FY_PREFERENCE) {
    const match = available.find((a) => a.fy === preferred);
    if (match) return match;
  }
  // Fallback: take the last (rightmost) column as likely most recent
  return available.length > 0 ? available[available.length - 1] : null;
}

function matchesCategory(cell: string, target: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return norm(cell) === norm(target);
}

function isExpenditureRow(cells: string[], mapping: ColumnMapping): boolean {
  if (mapping.revenueOrExpCol < 0) return true;
  const val = (cells[mapping.revenueOrExpCol] ?? '').trim().toLowerCase();
  return val === '' || val === 'expenditures' || val === 'expenditure';
}

function extractDistrictName(filename: string): string {
  let name = path.basename(filename, path.extname(filename));
  // Strip known suffixes/annotations from filenames
  name = name
    .replace(/\s*-\s*Rough Data\s*/i, '')
    .replace(/\s*-\s*Weird.*$/i, '')
    .replace(/\s*This is messy.*$/i, '')
    .replace(/\s*Expenses and Revenues\s*/i, '')
    .trim();
  return name;
}

// --- Main ---

function emptyBudget(displayName: string, sourceFile: string, flags: string[]): DistrictBudget {
  return {
    displayName,
    sourceFile,
    fiscalYear: '',
    totalExpenditures: 0,
    centralAdministration: 0,
    centralAdministrationModel: 0,
    adminShareOfTotal: null,
    adminShareOfTotalModel: null,
    components: { districtManagement: 0, programOperationsManagement: 0 },
    componentsModel: { districtManagement: 0, programOperationsManagement: 0 },
    flags,
  };
}

function extractRaw(filePath: string): {
  displayName: string;
  sourceFile: string;
  fiscalYear: string;
  totalExpenditures: number;
  districtManagement: number;
  programOpsManagement: number;
  flags: string[];
} | null {
  const sourceFile = path.basename(filePath);
  const displayName = extractDistrictName(sourceFile);
  const flags: string[] = [];

  let text: string;
  try {
    text = readFileWithEncodingFallback(filePath);
  } catch {
    return null;
  }

  const delimiter = detectDelimiter(text);
  const { headerLines, dataRows } = parseTable(text, delimiter);
  if (headerLines.length < 2 || dataRows.length === 0) return null;

  const mapping = buildColumnMapping(headerLines);
  if (!mapping || mapping.fyDollarColumns.length === 0) {
    return { displayName, sourceFile, fiscalYear: '', totalExpenditures: 0, districtManagement: 0, programOpsManagement: 0, flags: ['missing_fiscal_year'] };
  }

  const chosen = pickLatestFiscalYear(mapping.fyDollarColumns);
  if (!chosen) {
    return { displayName, sourceFile, fiscalYear: '', totalExpenditures: 0, districtManagement: 0, programOpsManagement: 0, flags: ['missing_fiscal_year'] };
  }

  const fiscalYear = `FY${chosen.fy}`;
  const colIdx = chosen.colIndex;

  let totalExpenditures = 0;
  let districtManagement = 0;
  let programOpsManagement = 0;
  let foundTotal = false;
  let foundDM = false;
  let foundPOM = false;

  const hasDetail2 = mapping.detail2Col >= 0;

  for (const row of dataRows) {
    const cells = row.cells;
    const detail1 = (cells[mapping.detailsCol] ?? '').trim();
    const detail2 = hasDetail2 ? (cells[mapping.detail2Col] ?? '').trim() : '';
    const dollarVal = parseMoney(cells[colIdx]);

    if (!isExpenditureRow(cells, mapping)) continue;

    if (matchesCategory(detail1, 'Total') && (!hasDetail2 || matchesCategory(detail2, 'Total'))) {
      if (!isNaN(dollarVal) && dollarVal > 0) {
        totalExpenditures = dollarVal;
        foundTotal = true;
      }
    }

    if (!hasDetail2) continue;

    if (matchesCategory(detail1, 'Leadership') && matchesCategory(detail2, 'District Management')) {
      if (!isNaN(dollarVal)) { districtManagement = dollarVal; foundDM = true; }
    }

    if (matchesCategory(detail1, 'Leadership') && matchesCategory(detail2, 'Program Operations Management')) {
      if (!isNaN(dollarVal)) { programOpsManagement = dollarVal; foundPOM = true; }
    }
  }

  if (!foundTotal) flags.push('missing_total_expenditures');
  if (!foundDM) flags.push('missing_district_management');
  if (!foundPOM) flags.push('missing_program_operations_management');
  if (!hasDetail2) flags.push('no_detail2_column');

  return { displayName, sourceFile, fiscalYear, totalExpenditures, districtManagement, programOpsManagement, flags };
}

function processFile(filePath: string): DistrictBudget {
  const sourceFile = path.basename(filePath);
  const displayName = extractDistrictName(sourceFile);

  const raw = extractRaw(filePath);
  if (!raw) return emptyBudget(displayName, sourceFile, ['parse_failed']);

  const flags = raw.flags;
  const { totalExpenditures, districtManagement, programOpsManagement, fiscalYear } = raw;

  // Raw values
  const centralAdministration = districtManagement + programOpsManagement;
  if (centralAdministration > totalExpenditures && totalExpenditures > 0) {
    flags.push('admin_gt_total');
  }

  // --- Model values (conservative clamping) ---
  let dmModel = districtManagement;
  let pomModel = programOpsManagement;

  if (districtManagement < 0) {
    flags.push('district_management_negative');
    dmModel = 0;
  }
  if (programOpsManagement < 0) {
    flags.push('program_operations_management_negative');
    pomModel = 0;
  }

  let centralAdminModel = dmModel + pomModel;

  let adminShareOfTotal: number | null = null;
  let adminShareOfTotalModel: number | null = null;

  if (totalExpenditures > 0) {
    adminShareOfTotal = centralAdministration / totalExpenditures;
    const rawModelShare = centralAdminModel / totalExpenditures;

    if (rawModelShare > ADMIN_SHARE_OUTLIER) {
      flags.push('admin_share_outlier');
      const cap = totalExpenditures * ADMIN_SHARE_CAP;
      centralAdminModel = Math.round(Math.min(centralAdminModel, cap));
      flags.push('admin_share_capped_model');
    }

    adminShareOfTotalModel = centralAdminModel / totalExpenditures;
  } else {
    flags.push('total_expenditures_missing_or_zero');
    centralAdminModel = Math.max(0, centralAdminModel);
    adminShareOfTotalModel = null;
  }

  // Round share values for readability
  if (adminShareOfTotal !== null) adminShareOfTotal = Math.round(adminShareOfTotal * 1e6) / 1e6;
  if (adminShareOfTotalModel !== null) adminShareOfTotalModel = Math.round(adminShareOfTotalModel * 1e6) / 1e6;

  return {
    displayName: raw.displayName,
    sourceFile: raw.sourceFile,
    fiscalYear,
    totalExpenditures,
    centralAdministration,
    centralAdministrationModel: centralAdminModel,
    adminShareOfTotal,
    adminShareOfTotalModel,
    components: { districtManagement, programOperationsManagement: programOpsManagement },
    componentsModel: { districtManagement: dmModel, programOperationsManagement: pomModel },
    flags,
  };
}

function main(): void {
  console.log('Building budgets JSON from district budget CSVs...\n');

  if (!fs.existsSync(BUDGET_DIR)) {
    console.error(`Budget data directory not found: ${BUDGET_DIR}`);
    console.error('Place district budget CSVs in "Budget Data/" and re-run.');
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'budgets.json'), '{}');
    return;
  }

  const files = fs.readdirSync(BUDGET_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) {
    console.warn('No CSV files found in', BUDGET_DIR);
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'budgets.json'), '{}');
    return;
  }

  const budgets: BudgetsMap = {};
  let parseFailed = 0;
  let missingAdmin = 0;
  let negativeAdmin = 0;
  let outlierShare = 0;
  let cappedModel = 0;

  for (const file of files) {
    const filePath = path.join(BUDGET_DIR, file);
    const result = processFile(filePath);
    const key = districtKey(result.displayName);

    if (result.flags.includes('parse_failed')) parseFailed++;
    if (result.flags.includes('missing_district_management') || result.flags.includes('missing_program_operations_management')) missingAdmin++;
    if (result.flags.includes('district_management_negative') || result.flags.includes('program_operations_management_negative')) negativeAdmin++;
    if (result.flags.includes('admin_share_outlier')) outlierShare++;
    if (result.flags.includes('admin_share_capped_model')) cappedModel++;

    budgets[key] = result;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'budgets.json');
  fs.writeFileSync(outPath, JSON.stringify(budgets, null, 2));

  console.log(`  Processed: ${files.length} files`);
  console.log(`  Parse failed: ${parseFailed}`);
  console.log(`  Missing admin categories: ${missingAdmin}`);
  console.log(`  Negative admin components: ${negativeAdmin}`);
  console.log(`  Admin share outliers (>${(ADMIN_SHARE_OUTLIER * 100).toFixed(0)}%): ${outlierShare}`);
  console.log(`  Model values capped: ${cappedModel}`);
  console.log(`  Output: ${outPath}\n`);

  // Print summary table
  const keys = Object.keys(budgets).sort();
  const colW = [28, 11, 16, 16, 16, 40];
  console.log(
    '  ' +
    'District'.padEnd(colW[0]) +
    'FY'.padEnd(colW[1]) +
    'Total Exp.'.padEnd(colW[2]) +
    'Admin (raw)'.padEnd(colW[3]) +
    'Admin (model)'.padEnd(colW[4]) +
    'Flags'
  );
  console.log('  ' + '-'.repeat(colW.reduce((a, b) => a + b, 0)));
  for (const k of keys) {
    const b = budgets[k];
    const fmtDollar = (v: number) => v !== 0 ? `$${v.toLocaleString()}` : '$0';
    const rawDiff = b.centralAdministration !== b.centralAdministrationModel;
    const modelStr = rawDiff ? fmtDollar(b.centralAdministrationModel) : '=';
    console.log(
      '  ' +
      k.padEnd(colW[0]) +
      b.fiscalYear.padEnd(colW[1]) +
      fmtDollar(b.totalExpenditures).padEnd(colW[2]) +
      fmtDollar(b.centralAdministration).padEnd(colW[3]) +
      modelStr.padEnd(colW[4]) +
      (b.flags.length > 0 ? b.flags.join(', ') : 'OK')
    );
  }
}

main();
