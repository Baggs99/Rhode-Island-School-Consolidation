import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import Fuse from 'fuse.js';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from '../types';
import {
  districtKey,
  schoolKey,
  type LeaEnrollmentMap,
  type SchoolEnrollmentMap,
  type Demographics,
} from '../lib/enrollment';
import type { BudgetsMap } from '../lib/budgets';
import type { DistrictAnchorsMap } from '../lib/anchors';
import { computeConsolidationV1, type ConsolidationParamsV1 } from '../lib/consolidationV1';

interface SidebarProps {
  districts: GeoJSONFC<DistrictFeature> | null;
  schools: GeoJSONFC<SchoolFeature> | null;
  loading: boolean;
  error: string | null;
  filters: { public: boolean; private: boolean; grade: string[] };
  setFilters: (f: typeof SidebarProps.prototype.filters) => void;
  showDistricts: boolean;
  setShowDistricts: (v: boolean) => void;
  showDistrictLabels: boolean;
  setShowDistrictLabels: (v: boolean) => void;
  clusterSchools: boolean;
  setClusterSchools: (v: boolean) => void;
  districtLevelFilter: { unified: boolean; elementary: boolean; secondary: boolean };
  setDistrictLevelFilter: (f: SidebarProps['districtLevelFilter']) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedDistrict: DistrictFeature | null;
  selectedDistrictKeys: string[];
  selectedSchool: SchoolFeature | null;
  leaEnrollment: LeaEnrollmentMap | null;
  schoolEnrollment: SchoolEnrollmentMap | null;
  enrollmentLoadError: string | null;
  budgets: BudgetsMap | null;
  anchors: DistrictAnchorsMap | null;
  showAnchors: boolean;
  setShowAnchors: (v: boolean) => void;
  onSearchSelect: (school?: SchoolFeature, district?: DistrictFeature) => void;
  onClearSelection: () => void;
  sandboxDistrictKeys: string[];
  setSandboxDistrictKeys: Dispatch<SetStateAction<string[]>>;
}

const GRADE_OPTIONS = ['Elementary', 'Middle', 'High', 'Other'] as const;

const RACE_LABELS: [keyof Demographics, string][] = [
  ['WHITE', 'White'],
  ['HISPANIC', 'Hispanic'],
  ['BLACK', 'Black'],
  ['ASIAN', 'Asian'],
  ['MULTIRACE', 'Multiracial'],
  ['NATIVE', 'Native American'],
  ['PACIFICISLANDER', 'Pacific Islander'],
];

function DemographicsBar({ demographics, total }: { demographics: Demographics; total: number }) {
  if (total <= 0) return null;
  const items = RACE_LABELS
    .map(([key, label]) => ({ label, count: demographics[key] ?? 0 }))
    .filter((d) => d.count > 0);
  if (!items.length) return null;

  const colors: Record<string, string> = {
    White: '#64b5f6',
    Hispanic: '#ffb74d',
    Black: '#81c784',
    Asian: '#ce93d8',
    Multiracial: '#a1887f',
    'Native American': '#4dd0e1',
    'Pacific Islander': '#fff176',
  };

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 4 }}>
        {items.map((d) => (
          <div
            key={d.label}
            title={`${d.label}: ${d.count.toLocaleString()} (${((d.count / total) * 100).toFixed(1)}%)`}
            style={{ width: `${(d.count / total) * 100}%`, background: colors[d.label] ?? '#bdbdbd' }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11, color: '#555' }}>
        {items.map((d) => (
          <span key={d.label}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: colors[d.label] ?? '#bdbdbd', marginRight: 3, verticalAlign: 'middle' }} />
            {d.label} {((d.count / total) * 100).toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

function GenderSplit({ demographics, total }: { demographics: Demographics; total: number }) {
  const female = demographics.FEMALE ?? 0;
  const male = demographics.MALE ?? 0;
  const other = demographics.OTHER ?? 0;
  if (female + male + other === 0) return null;
  return (
    <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
      {female > 0 && `Female: ${female.toLocaleString()}`}
      {male > 0 && ` · Male: ${male.toLocaleString()}`}
      {other > 0 && ` · Other: ${other.toLocaleString()}`}
    </div>
  );
}

const $ = (n: number) => `$${Math.round(n).toLocaleString()}`;
const $pp = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export default function Sidebar({
  districts,
  schools,
  loading,
  error,
  filters,
  setFilters,
  showDistricts,
  setShowDistricts,
  showDistrictLabels,
  setShowDistrictLabels,
  clusterSchools,
  setClusterSchools,
  districtLevelFilter,
  setDistrictLevelFilter,
  searchQuery,
  setSearchQuery,
  selectedDistrict,
  selectedDistrictKeys,
  selectedSchool,
  leaEnrollment,
  schoolEnrollment,
  enrollmentLoadError,
  budgets,
  anchors,
  showAnchors,
  setShowAnchors,
  onSearchSelect,
  onClearSelection,
  sandboxDistrictKeys,
  setSandboxDistrictKeys,
}: SidebarProps) {
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const items: Array<{ name: string; type: 'school' | 'district'; school: SchoolFeature | null; district: DistrictFeature | null }> = [];
    if (schools?.features) {
      schools.features.forEach((f) => {
        items.push({ name: f.properties.name, type: 'school', school: f, district: null });
      });
    }
    if (districts?.features) {
      districts.features.forEach((d) => {
        const name = d.properties.district_name ?? d.properties.name;
        items.push({ name, type: 'district', school: null, district: d });
      });
    }
    const fuse = new Fuse(items, { keys: ['name'], threshold: 0.4 });
    const q = searchQuery.trim();
    const out: typeof items = [];
    const seen = new Set<string>();
    fuse.search(q).forEach((r) => {
      const item = r.item;
      const key = item.school ? item.school.properties.id : item.district!.properties.district_geoid ?? item.district!.properties.geoid;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    });
    return out.slice(0, 10);
  }, [searchQuery, schools, districts]);

  const districtEnrollment = useMemo(() => {
    if (!selectedDistrict || !leaEnrollment || typeof leaEnrollment !== 'object') return null;
    const name = selectedDistrict.properties.district_name ?? selectedDistrict.properties.name ?? '';
    const key = districtKey(name);
    if (typeof window !== 'undefined' && selectedDistrict) {
      console.log('districtName clicked', name, 'key', key, 'hasKey?', (leaEnrollment as Record<string, unknown>)?.[key] != null);
    }
    return leaEnrollment[key] ?? null;
  }, [selectedDistrict, leaEnrollment]);

  const schoolEnrollmentData = useMemo(() => {
    if (!selectedSchool || !schoolEnrollment) return null;
    const distName = selectedSchool.properties.district_name ?? selectedSchool.properties.name ?? '';
    const schName = selectedSchool.properties.name ?? '';
    const key = schoolKey(distName, schName);
    return schoolEnrollment[key] ?? null;
  }, [selectedSchool, schoolEnrollment]);

  const districtBudget = useMemo(() => {
    if (!selectedDistrict || !budgets) return null;
    const name = selectedDistrict.properties.district_name ?? selectedDistrict.properties.name ?? '';
    const key = districtKey(name);
    return budgets[key] ?? null;
  }, [selectedDistrict, budgets]);

  const districtCounts = useMemo(() => {
    if (!schools?.features?.length || !selectedDistrict) return { public: 0, private: 0 };
    const geoid = selectedDistrict.properties.district_geoid ?? selectedDistrict.properties.geoid;
    let publicCount = 0;
    let privateCount = 0;
    schools.features.forEach((f) => {
      if (f.properties.district_geoid === geoid) {
        if (f.properties.school_type === 'public') publicCount++;
        else privateCount++;
      }
    });
    return { public: publicCount, private: privateCount };
  }, [schools, selectedDistrict]);

  const [consolidationParams, setConsolidationParams] = useState<ConsolidationParamsV1>({
    adminReductionRate: 1.0,
    costPerStudentMile: 3.0,
    affectedShare: 1.0,
  });

  const [filtersOpen, setFiltersOpen] = useState(false);

  // --- Consolidation Sandbox ---
  const [sandboxSearch, setSandboxSearch] = useState('');

  const districtOptions = useMemo(() => {
    if (!districts?.features) return [];
    const seen = new Set<string>();
    const opts: Array<{ key: string; name: string }> = [];
    for (const f of districts.features) {
      const name = f.properties.district_name ?? f.properties.name ?? '';
      const key = districtKey(name);
      if (key && !seen.has(key)) {
        seen.add(key);
        opts.push({ key, name });
      }
    }
    opts.sort((a, b) => a.name.localeCompare(b.name));
    return opts;
  }, [districts]);

  const districtNameByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of districtOptions) m.set(d.key, d.name);
    return m;
  }, [districtOptions]);

  const sandboxFuse = useMemo(
    () => new Fuse(districtOptions, { keys: ['name'], threshold: 0.4 }),
    [districtOptions],
  );

  const sandboxSearchResults = useMemo(() => {
    if (!sandboxSearch.trim()) return [];
    return sandboxFuse
      .search(sandboxSearch.trim())
      .map((r) => r.item)
      .filter((d) => !sandboxDistrictKeys.includes(d.key))
      .slice(0, 8);
  }, [sandboxSearch, sandboxFuse, sandboxDistrictKeys]);

  const sandboxResult = useMemo(() => {
    if (sandboxDistrictKeys.length < 2 || !budgets || !leaEnrollment || !anchors) return null;
    return computeConsolidationV1(sandboxDistrictKeys, budgets, leaEnrollment, anchors, consolidationParams);
  }, [sandboxDistrictKeys, budgets, leaEnrollment, anchors, consolidationParams]);

  const sandboxDataReady = budgets !== null && leaEnrollment !== null && anchors !== null;

  const getDisplayName = (key: string) =>
    districtNameByKey.get(key) ?? anchors?.[key]?.displayName ?? budgets?.[key]?.displayName ?? key;

  const addToSandbox = (key: string) => {
    setSandboxDistrictKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const removeFromSandbox = (key: string) => {
    setSandboxDistrictKeys((prev) => prev.filter((k) => k !== key));
  };

  const mapDistrictKey = selectedDistrict
    ? districtKey(selectedDistrict.properties.district_name ?? selectedDistrict.properties.name ?? '')
    : null;

  const mapDistrictInSandbox = mapDistrictKey ? sandboxDistrictKeys.includes(mapDistrictKey) : false;

  const toggleGrade = (g: string) => {
    const next = filters.grade.includes(g)
      ? filters.grade.filter((x) => x !== g)
      : [...filters.grade, g];
    setFilters({ ...filters, grade: next });
  };

  return (
    <div
      style={{
        width: 340,
        minWidth: 320,
        background: '#fff',
        boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: 16, borderBottom: '1px solid #eee' }}>
        <h1 style={{ margin: '0 0 12px 0', fontSize: 18, fontWeight: 600 }}>
          Rhode Island Schools
        </h1>
        <input
          type="search"
          placeholder="Search by school or district..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '10px 12px',
            border: '1px solid #ccc',
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        {searchResults.length > 0 && (
          <ul
            style={{
              margin: '8px 0 0 0',
              padding: 0,
              listStyle: 'none',
              maxHeight: 200,
              overflowY: 'auto',
              background: '#f9f9f9',
              borderRadius: 6,
            }}
          >
            {searchResults.map((r) => (
              <li
                key={r.school ? r.school.properties.id : r.district!.properties.district_geoid ?? r.district!.properties.geoid}
                onClick={() => {
                  if (r.school) onSearchSelect(r.school, r.district ?? undefined);
                  else if (r.district) onSearchSelect(undefined, r.district);
                }}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee',
                  fontSize: 13,
                }}
              >
                {r.school ? r.school.properties.name : r.district!.properties.name}
                <span style={{ color: '#666', marginLeft: 6 }}>
                  {r.school ? r.school.properties.school_type : 'District'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ borderBottom: '1px solid #eee' }}>
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 14,
            color: '#333',
          }}
        >
          Filters
          <span
            style={{
              fontSize: 12,
              color: '#999',
              transition: 'transform 0.2s',
              transform: filtersOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          >
            ▼
          </span>
        </button>
        {filtersOpen && (
          <div style={{ padding: '0 16px 16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filters.public}
                onChange={() => setFilters({ ...filters, public: !filters.public })}
              />
              Public
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filters.private}
                onChange={() => setFilters({ ...filters, private: !filters.private })}
              />
              Private
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={clusterSchools}
                onChange={() => setClusterSchools(!clusterSchools)}
              />
              Cluster schools
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showAnchors}
                onChange={() => setShowAnchors(!showAnchors)}
              />
              Show district anchors (HS/Elem)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showDistricts}
                onChange={() => setShowDistricts(!showDistricts)}
              />
              Show district boundaries
            </label>
            {showDistricts && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 24, marginBottom: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showDistrictLabels}
                  onChange={() => setShowDistrictLabels(!showDistrictLabels)}
                />
                Show district labels
              </label>
            )}
            {showDistricts && (
              <div style={{ marginLeft: 24, marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={districtLevelFilter.unified}
                    onChange={() =>
                      setDistrictLevelFilter({ ...districtLevelFilter, unified: !districtLevelFilter.unified })
                    }
                  />
                  Unified
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={districtLevelFilter.elementary}
                    onChange={() =>
                      setDistrictLevelFilter({ ...districtLevelFilter, elementary: !districtLevelFilter.elementary })
                    }
                  />
                  Elementary
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={districtLevelFilter.secondary}
                    onChange={() =>
                      setDistrictLevelFilter({ ...districtLevelFilter, secondary: !districtLevelFilter.secondary })
                    }
                  />
                  Secondary
                </label>
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 13, color: '#666' }}>Grade level</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {GRADE_OPTIONS.map((g) => (
                <button
                  key={g}
                  onClick={() => toggleGrade(g)}
                  style={{
                    padding: '6px 10px',
                    border: `1px solid ${filters.grade.includes(g) ? '#1976d2' : '#ccc'}`,
                    background: filters.grade.includes(g) ? '#e3f2fd' : '#fff',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {/* ── Consolidation Sandbox (V1) ── */}
        <div
          style={{
            background: '#fafafa',
            border: '1px solid #e0e0e0',
            padding: 14,
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10, color: '#333' }}>
            Consolidation Sandbox (V1)
          </div>

          {/* District picker */}
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Add district…"
              value={sandboxSearch}
              onChange={(e) => setSandboxSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                border: '1px solid #ccc',
                borderRadius: 6,
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
            {sandboxSearchResults.length > 0 && (
              <ul
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderTop: 'none',
                  borderRadius: '0 0 6px 6px',
                  maxHeight: 180,
                  overflowY: 'auto',
                  zIndex: 10,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                }}
              >
                {sandboxSearchResults.map((d) => (
                  <li
                    key={d.key}
                    onClick={() => {
                      addToSandbox(d.key);
                      setSandboxSearch('');
                    }}
                    style={{
                      padding: '8px 10px',
                      cursor: 'pointer',
                      fontSize: 13,
                      borderBottom: '1px solid #f0f0f0',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = '#e3f2fd';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = '#fff';
                    }}
                  >
                    {d.name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Selected district chips */}
          {sandboxDistrictKeys.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {sandboxDistrictKeys.map((key) => (
                <span
                  key={key}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 8px',
                    background: '#e3f2fd',
                    border: '1px solid #90caf9',
                    borderRadius: 16,
                    fontSize: 12,
                    color: '#1565c0',
                  }}
                >
                  {getDisplayName(key)}
                  <button
                    onClick={() => removeFromSandbox(key)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: 14,
                      lineHeight: 1,
                      color: '#1565c0',
                    }}
                    title="Remove"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Convenience buttons */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button
              onClick={() => {
                if (mapDistrictKey) addToSandbox(mapDistrictKey);
              }}
              disabled={!mapDistrictKey || mapDistrictInSandbox}
              title={
                !mapDistrictKey
                  ? 'Click a district on the map first'
                  : mapDistrictInSandbox
                    ? 'Already in sandbox'
                    : `Add ${getDisplayName(mapDistrictKey)}`
              }
              style={{
                flex: 1,
                padding: '6px 8px',
                fontSize: 12,
                border: '1px solid #ccc',
                borderRadius: 6,
                background: !mapDistrictKey || mapDistrictInSandbox ? '#f5f5f5' : '#e8f5e9',
                color: !mapDistrictKey || mapDistrictInSandbox ? '#999' : '#2e7d32',
                cursor: !mapDistrictKey || mapDistrictInSandbox ? 'default' : 'pointer',
                fontWeight: 500,
              }}
            >
              + Add map selection
            </button>
            <button
              onClick={() => setSandboxDistrictKeys([])}
              disabled={sandboxDistrictKeys.length === 0}
              style={{
                padding: '6px 10px',
                fontSize: 12,
                border: '1px solid #ccc',
                borderRadius: 6,
                background: sandboxDistrictKeys.length === 0 ? '#f5f5f5' : '#fff',
                color: sandboxDistrictKeys.length === 0 ? '#999' : '#c62828',
                cursor: sandboxDistrictKeys.length === 0 ? 'default' : 'pointer',
                fontWeight: 500,
              }}
            >
              Clear
            </button>
          </div>

          {/* Data loading indicator */}
          {!sandboxDataReady && (
            <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
              Loading budget, enrollment &amp; anchor data…
            </div>
          )}

          {/* Parameter controls */}
          <div style={{ marginBottom: 12, padding: '8px 0', borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#555' }}>Parameters</div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
              Spoke admin reduction: {Math.round(consolidationParams.adminReductionRate * 100)}%
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(consolidationParams.adminReductionRate * 100)}
                onChange={(e) =>
                  setConsolidationParams((p) => ({ ...p, adminReductionRate: Number(e.target.value) / 100 }))
                }
                style={{ width: '100%', marginTop: 2 }}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
              Students busing further: {Math.round(consolidationParams.affectedShare * 100)}%
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(consolidationParams.affectedShare * 100)}
                onChange={(e) =>
                  setConsolidationParams((p) => ({ ...p, affectedShare: Number(e.target.value) / 100 }))
                }
                style={{ width: '100%', marginTop: 2 }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              Cost per student-mile: $
              <input
                type="number"
                min={0}
                step={0.25}
                value={consolidationParams.costPerStudentMile}
                onChange={(e) =>
                  setConsolidationParams((p) => ({ ...p, costPerStudentMile: Math.max(0, Number(e.target.value)) }))
                }
                style={{ width: 70, padding: '3px 6px', borderRadius: 4, border: '1px solid #ccc' }}
              />
            </label>
          </div>

          {/* Computation results */}
          {sandboxDistrictKeys.length < 2 ? (
            <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>
              Add at least 2 districts to simulate consolidation.
            </div>
          ) : !sandboxDataReady ? null : sandboxResult && !sandboxResult.ok ? (
            <div style={{ padding: 10, background: '#fff3e0', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#c62828', fontWeight: 600, marginBottom: 6 }}>
                Cannot compute estimate — missing data:
              </div>
              {sandboxResult.missing.budgets.length > 0 && (
                <div style={{ color: '#c62828', marginBottom: 2 }}>
                  Budget: {sandboxResult.missing.budgets.join(', ')}
                </div>
              )}
              {sandboxResult.missing.enrollment.length > 0 && (
                <div style={{ color: '#c62828', marginBottom: 2 }}>
                  Enrollment: {sandboxResult.missing.enrollment.join(', ')}
                </div>
              )}
              {sandboxResult.missing.anchors.length > 0 && (
                <div style={{ color: '#c62828' }}>
                  Anchors: {sandboxResult.missing.anchors.join(', ')}
                </div>
              )}
            </div>
          ) : sandboxResult ? (
            <div style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 8 }}>
                <strong>Hub:</strong> {sandboxResult.hubName}{' '}
                <span style={{ color: '#555', fontSize: 12 }}>
                  ({(leaEnrollment?.[sandboxResult.hubKey]?.total ?? 0).toLocaleString()} students)
                </span>
              </div>

              <div style={{ marginBottom: 8, padding: '6px 0', borderTop: '1px solid #e0e0e0' }}>
                <div><strong>Combined enrollment:</strong> {sandboxResult.combinedEnrollment.toLocaleString()}</div>
                <div><strong>Combined spending:</strong> {$(sandboxResult.combinedSpending)}</div>
                <div><strong>Baseline per-pupil:</strong> {$pp(sandboxResult.baselinePerPupil)}</div>
              </div>

              <div style={{ marginBottom: 8, padding: '6px 0', borderTop: '1px solid #e0e0e0' }}>
                <div>
                  <strong>Admin savings:</strong>{' '}
                  <span style={{ color: '#2e7d32' }}>{$(sandboxResult.adminSavings)}</span>
                </div>
                <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                  {pct(sandboxResult.adminSavingsPctCombined)} of combined budget
                </div>
                <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                  Hub admin: {$(sandboxResult.adminBaselineHub)} · Spoke admin: {$(sandboxResult.adminBaselineSpokes)}
                </div>
              </div>

              <div style={{ marginBottom: 8, padding: '6px 0', borderTop: '1px solid #e0e0e0' }}>
                <div>
                  <strong>Transportation increase:</strong>{' '}
                  <span style={{ color: '#c62828' }}>{$(sandboxResult.transportationIncrease)}</span>
                </div>
                <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                  {pct(sandboxResult.transportIncreasePctCombined)} of combined budget
                </div>
                {sandboxResult.spokeBreakdown.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#555' }}>
                    {sandboxResult.spokeBreakdown.slice(0, 5).map((s) => (
                      <div key={s.key} style={{ marginTop: 2 }}>
                        {s.name}: {s.distanceMiles} mi × {s.enrollment.toLocaleString()} × {Math.round(consolidationParams.affectedShare * 100)}% × ${consolidationParams.costPerStudentMile.toFixed(2)} = {$(s.cost)}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 8, padding: '6px 0', borderTop: '1px solid #e0e0e0' }}>
                <div>
                  <strong>Net impact:</strong>{' '}
                  <span
                    style={{
                      color: sandboxResult.netImpact >= 0 ? '#2e7d32' : '#c62828',
                      fontWeight: 700,
                      fontSize: 14,
                    }}
                  >
                    {sandboxResult.netImpact >= 0
                      ? `+${$(sandboxResult.netImpact)}`
                      : `-${$(Math.abs(sandboxResult.netImpact))}`}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  {sandboxResult.netImpact >= 0 ? 'Net savings (positive)' : 'Net cost (negative)'}
                  {' · '}{pct(sandboxResult.netImpactPctCombined)} of combined budget
                </div>
                {sandboxResult.spokesSpending > 0 && (
                  <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                    vs spokes budget: {pct(sandboxResult.netImpactPctSpokesSpending)}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  <strong>Projected spending:</strong> {$(sandboxResult.projectedSpending)}
                </div>
                <div>
                  <strong>Projected per-pupil:</strong> {$pp(sandboxResult.projectedPerPupil)}
                </div>
              </div>

              {sandboxResult.warnings.length > 0 && (
                <div
                  style={{
                    padding: '6px 8px',
                    background: '#fff3e0',
                    borderRadius: 4,
                    fontSize: 11,
                    color: '#e65100',
                  }}
                >
                  <strong>Warnings:</strong>
                  {sandboxResult.warnings.map((w, i) => (
                    <div key={i}>· {w}</div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {error && (
          <div style={{ color: '#c62828', fontSize: 14, marginBottom: 16 }}>{error}</div>
        )}
        {loading && <div style={{ color: '#666' }}>Loading...</div>}
        {!loading && selectedDistrict && (
          <div
            style={{
              background: '#e3f2fd',
              padding: 16,
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {selectedDistrict.properties.district_name ?? selectedDistrict.properties.name}
              {selectedDistrict.properties.district_level && (
                <span style={{ fontWeight: 400, color: '#666', marginLeft: 6 }}>
                  ({selectedDistrict.properties.district_level})
                </span>
              )}
            </div>
            {districtEnrollment ? (
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                <strong>Total enrollment:</strong> {(districtEnrollment.total ?? 0).toLocaleString()}
                {districtEnrollment.elem_enrollment != null && districtEnrollment.sec_enrollment != null && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
                    Elem (PK–8): {districtEnrollment.elem_enrollment.toLocaleString()} · Sec (9–12): {districtEnrollment.sec_enrollment.toLocaleString()}
                  </div>
                )}
                {(districtEnrollment.FRL != null || districtEnrollment.LEP != null || districtEnrollment.IEP != null || districtEnrollment.VOCED != null) && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                    {districtEnrollment.FRL != null && `FRL: ${districtEnrollment.FRL.toLocaleString()}`}
                    {districtEnrollment.LEP != null && ` · LEP: ${districtEnrollment.LEP.toLocaleString()}`}
                    {districtEnrollment.IEP != null && ` · IEP: ${districtEnrollment.IEP.toLocaleString()}`}
                    {districtEnrollment.VOCED != null && ` · VocEd: ${districtEnrollment.VOCED.toLocaleString()}`}
                  </div>
                )}
                {districtEnrollment.demographics && (
                  <>
                    <DemographicsBar demographics={districtEnrollment.demographics} total={districtEnrollment.total ?? 0} />
                    <GenderSplit demographics={districtEnrollment.demographics} total={districtEnrollment.total ?? 0} />
                  </>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
                {enrollmentLoadError
                  ? `Enrollment JSON not found: ${enrollmentLoadError}`
                  : leaEnrollment && Object.keys(leaEnrollment).length === 0
                    ? 'Enrollment data empty. Place RIDE Oct 2024 CSVs in data/enrollment/ and run: npm run build:enrollment'
                    : leaEnrollment
                      ? 'Enrollment not found for this district (Oct 2024 RIDE).'
                      : 'Enrollment data not loaded. Place RIDE Oct 2024 CSVs in data/enrollment/ and run: npm run build:enrollment'}
              </div>
            )}
            {districtBudget && (() => {
              const hasAdjustment = districtBudget.centralAdministration !== districtBudget.centralAdministrationModel;
              const pct = (v: number | null) => v != null ? `${(v * 100).toFixed(1)}%` : '—';
              return (
                <div style={{ fontSize: 13, marginBottom: 8, padding: '8px 0', borderTop: '1px solid #bbdefb' }}>
                  <strong>Budget</strong> <span style={{ color: '#555' }}>({districtBudget.fiscalYear})</span>
                  <div style={{ marginTop: 4, color: '#333' }}>
                    Total expenditures: ${districtBudget.totalExpenditures.toLocaleString()}
                  </div>
                  <div style={{ marginTop: 2, color: '#333' }}>
                    Central admin{hasAdjustment ? ' (model)' : ''}: ${districtBudget.centralAdministrationModel.toLocaleString()}
                    <span style={{ color: '#777', marginLeft: 4, fontSize: 11 }}>
                      ({pct(hasAdjustment ? districtBudget.adminShareOfTotalModel : districtBudget.adminShareOfTotal)} of total)
                    </span>
                  </div>
                  {hasAdjustment && (
                    <div style={{ marginTop: 2, fontSize: 11, color: '#b71c1c' }}>
                      Raw extracted: ${districtBudget.centralAdministration.toLocaleString()}
                      {' '}({pct(districtBudget.adminShareOfTotal)}) — adjusted for modeling
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>
                    District Mgmt: ${districtBudget.componentsModel.districtManagement.toLocaleString()}
                    {' · '}
                    Program/Ops Mgmt: ${districtBudget.componentsModel.programOperationsManagement.toLocaleString()}
                  </div>
                  {districtBudget.flags.length > 0 && (
                    <div style={{ fontSize: 11, color: '#c62828', marginTop: 4 }}>
                      Flags: {districtBudget.flags.join(', ')}
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={{ fontSize: 14 }}>
              Public: {districtCounts.public} · Private: {districtCounts.private}
            </div>
            <button
              onClick={onClearSelection}
              style={{
                marginTop: 12,
                padding: '6px 12px',
                background: '#1976d2',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Clear
            </button>
          </div>
        )}
        {!loading && selectedSchool && (
          <div
            style={{
              background: '#f3e5f5',
              padding: 16,
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {selectedSchool.properties.name}
            </div>
            <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
              {selectedSchool.properties.district_name ?? selectedSchool.properties.name}
              {selectedSchool.properties.school_type && (
                <span style={{ marginLeft: 6 }}>({selectedSchool.properties.school_type})</span>
              )}
            </div>
            {schoolEnrollmentData ? (
              <div style={{ fontSize: 14 }}>
                <strong>Total enrollment:</strong> {(schoolEnrollmentData.total ?? 0).toLocaleString()}
                {(schoolEnrollmentData.FRL != null || schoolEnrollmentData.LEP != null || schoolEnrollmentData.IEP != null || schoolEnrollmentData.VOCED != null) && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                    {schoolEnrollmentData.FRL != null && `FRL: ${schoolEnrollmentData.FRL.toLocaleString()}`}
                    {schoolEnrollmentData.LEP != null && ` · LEP: ${schoolEnrollmentData.LEP.toLocaleString()}`}
                    {schoolEnrollmentData.IEP != null && ` · IEP: ${schoolEnrollmentData.IEP.toLocaleString()}`}
                    {schoolEnrollmentData.VOCED != null && ` · VocEd: ${schoolEnrollmentData.VOCED.toLocaleString()}`}
                  </div>
                )}
                {schoolEnrollmentData.demographics && (
                  <>
                    <DemographicsBar demographics={schoolEnrollmentData.demographics} total={schoolEnrollmentData.total ?? 0} />
                    <GenderSplit demographics={schoolEnrollmentData.demographics} total={schoolEnrollmentData.total ?? 0} />
                  </>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#666' }}>
                Enrollment not found for this school (Oct 2024 RIDE).
              </div>
            )}
            <button
              onClick={onClearSelection}
              style={{
                marginTop: 12,
                padding: '6px 12px',
                background: '#7b1fa2',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Clear
            </button>
          </div>
        )}
        {!loading && !selectedDistrict && !selectedSchool && schools && (
          <div style={{ color: '#666', fontSize: 13 }}>
            Click a district or school on the map, or use the Consolidation Sandbox above to analyze district mergers.
          </div>
        )}
      </div>
    </div>
  );
}
