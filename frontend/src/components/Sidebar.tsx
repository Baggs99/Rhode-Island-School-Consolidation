import { useMemo } from 'react';
import Fuse from 'fuse.js';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from '../types';

interface SidebarProps {
  districts: GeoJSONFC<DistrictFeature> | null;
  schools: GeoJSONFC<SchoolFeature> | null;
  loading: boolean;
  error: string | null;
  filters: { public: boolean; private: boolean; grade: string[] };
  setFilters: (f: typeof SidebarProps.prototype.filters) => void;
  showDistricts: boolean;
  setShowDistricts: (v: boolean) => void;
  districtLevelFilter: { unified: boolean; elementary: boolean; secondary: boolean };
  setDistrictLevelFilter: (f: SidebarProps['districtLevelFilter']) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedDistrict: DistrictFeature | null;
  selectedSchool: SchoolFeature | null;
  onSearchSelect: (school?: SchoolFeature, district?: DistrictFeature) => void;
  onClearSelection: () => void;
}

const GRADE_OPTIONS = ['Elementary', 'Middle', 'High', 'Other'] as const;

export default function Sidebar({
  districts,
  schools,
  loading,
  error,
  filters,
  setFilters,
  showDistricts,
  setShowDistricts,
  districtLevelFilter,
  setDistrictLevelFilter,
  searchQuery,
  setSearchQuery,
  selectedDistrict,
  selectedSchool,
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
            checked={showDistricts}
            onChange={() => setShowDistricts(!showDistricts)}
          />
          Show district boundaries
        </label>
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
        {!loading && !selectedDistrict && !selectedSchool && schools && (
          <div style={{ color: '#666', fontSize: 13 }}>
            Click a district or school on the map. Use search to zoom to a result.
          </div>
        )}
      </div>
    </div>
  );
}
