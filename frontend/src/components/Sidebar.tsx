import { useMemo } from 'react';
import Fuse from 'fuse.js';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from '../types';
import {
  districtKey,
  schoolKey,
  type LeaEnrollmentMap,
  type SchoolEnrollmentMap,
  type Demographics,
} from '../lib/enrollment';

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
  selectedSchool: SchoolFeature | null;
  leaEnrollment: LeaEnrollmentMap | null;
  schoolEnrollment: SchoolEnrollmentMap | null;
  enrollmentLoadError: string | null;
  onSearchSelect: (school?: SchoolFeature, district?: DistrictFeature) => void;
  onClearSelection: () => void;
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
  selectedSchool,
  leaEnrollment,
  schoolEnrollment,
  enrollmentLoadError,
  onSearchSelect,
  onClearSelection,
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

      <div style={{ padding: 16, borderBottom: '1px solid #eee' }}>
        <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Filters</div>
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

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
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
            Click a district or school on the map. Use search to zoom to a result.
          </div>
        )}
      </div>
    </div>
  );
}
