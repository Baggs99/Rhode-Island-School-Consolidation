import { useState, useEffect, useCallback, useMemo } from 'react';
import Map from './components/Map';
import Sidebar from './components/Sidebar';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from './types';

const API_BASE = '';

export default function App() {
  const [districts, setDistricts] = useState<GeoJSONFC<DistrictFeature> | null>(null);
  const [schools, setSchools] = useState<GeoJSONFC<SchoolFeature> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    public: true,
    private: true,
    grade: [] as string[],
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDistrict, setSelectedDistrict] = useState<DistrictFeature | null>(null);
  const [selectedSchool, setSelectedSchool] = useState<SchoolFeature | null>(null);
  const [highlightDistrict, setHighlightDistrict] = useState<DistrictFeature | null>(null);
  const [showDistricts, setShowDistricts] = useState(true);
  const [districtLevelFilter, setDistrictLevelFilter] = useState({
    unified: true,
    elementary: true,
    secondary: true,
  });

  const loadDistricts = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/districts`);
    if (!res.ok) throw new Error('Failed to load districts');
    const data = await res.json();
    setDistricts(data);
  }, []);

  const loadSchools = useCallback(async () => {
    const types: string[] = [];
    if (filters.public) types.push('public');
    if (filters.private) types.push('private');
    const gradeParam = filters.grade.length ? filters.grade.join(',') : undefined;
    const params = new URLSearchParams();
    if (types.length) params.set('type', types.join(','));
    if (gradeParam) params.set('grade', gradeParam);
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    const res = await fetch(`${API_BASE}/api/schools?${params}`);
    if (!res.ok) throw new Error('Failed to load schools');
    const data = await res.json();
    setSchools(data);
  }, [filters.public, filters.private, filters.grade, searchQuery]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await loadDistricts();
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadDistricts]);

  useEffect(() => {
    if (!loading) loadSchools();
  }, [loading, loadSchools]);

  const filteredDistricts = useMemo(() => {
    if (!districts?.features?.length) return districts;
    const levels: string[] = [];
    if (districtLevelFilter.unified) levels.push('unified');
    if (districtLevelFilter.elementary) levels.push('elementary');
    if (districtLevelFilter.secondary) levels.push('secondary');
    if (levels.length === 0)
      return { type: 'FeatureCollection' as const, features: [] as DistrictFeature[] };
    const filtered = districts.features.filter((f) => {
      const l = (f.properties?.district_level ?? 'unified').toLowerCase();
      return levels.includes(l);
    });
    return { type: 'FeatureCollection' as const, features: filtered };
  }, [districts, districtLevelFilter]);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <Sidebar
        districts={districts}
        schools={schools}
        loading={loading}
        error={error}
        filters={filters}
        setFilters={setFilters}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedDistrict={selectedDistrict}
        selectedSchool={selectedSchool}
        showDistricts={showDistricts}
        setShowDistricts={setShowDistricts}
        districtLevelFilter={districtLevelFilter}
        setDistrictLevelFilter={setDistrictLevelFilter}
        onSearchSelect={(school, district) => {
          setSelectedSchool(school);
          setSelectedDistrict(district ?? null);
          setHighlightDistrict(district ?? null);
        }}
        onClearSelection={() => {
          setSelectedSchool(null);
          setSelectedDistrict(null);
          setHighlightDistrict(null);
        }}
      />
      <Map
        districts={filteredDistricts}
        schools={schools}
        loading={loading}
        showDistricts={showDistricts}
        selectedDistrict={selectedDistrict}
        selectedSchool={selectedSchool}
        highlightDistrict={highlightDistrict}
        onDistrictClick={setSelectedDistrict}
        onDistrictHover={setHighlightDistrict}
        onSchoolClick={setSelectedSchool}
      />
    </div>
  );
}
