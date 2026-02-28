import { useState, useEffect, useCallback, useMemo } from 'react';
import MapView from './components/Map';
import Sidebar from './components/Sidebar';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from './types';
import { districtKey, type LeaEnrollmentMap, type SchoolEnrollmentMap } from './lib/enrollment';
import type { BudgetsMap } from './lib/budgets';
import type { DistrictAnchorsMap } from './lib/anchors';

const API_BASE = '';

export default function App() {
  const [districts, setDistricts] = useState<GeoJSONFC<DistrictFeature> | null>(null);
  const [schools, setSchools] = useState<GeoJSONFC<SchoolFeature> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    public: false,
    private: false,
    grade: [] as string[],
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDistrict, setSelectedDistrict] = useState<DistrictFeature | null>(null);
  const [selectedDistrictKeys, setSelectedDistrictKeys] = useState<string[]>([]);
  const [sandboxDistrictKeys, setSandboxDistrictKeys] = useState<string[]>([]);
  const [selectedSchool, setSelectedSchool] = useState<SchoolFeature | null>(null);
  const [highlightDistrict, setHighlightDistrict] = useState<DistrictFeature | null>(null);
  const [showDistricts, setShowDistricts] = useState(true);
  const [showDistrictLabels, setShowDistrictLabels] = useState(false);
  const [clusterSchools, setClusterSchools] = useState(false);
  const [districtLevelFilter, setDistrictLevelFilter] = useState({
    unified: true,
    elementary: true,
    secondary: true,
  });
  const [leaEnrollment, setLeaEnrollment] = useState<LeaEnrollmentMap | null>(null);
  const [schoolEnrollment, setSchoolEnrollment] = useState<SchoolEnrollmentMap | null>(null);
  const [enrollmentLoadError, setEnrollmentLoadError] = useState<string | null>(null);
  const [budgets, setBudgets] = useState<BudgetsMap | null>(null);
  const [anchors, setAnchors] = useState<DistrictAnchorsMap | null>(null);
  const [showAnchors, setShowAnchors] = useState(false);

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
    params.set('type', types.join(','));
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

  useEffect(() => {
    const leaUrl = '/enrollment/ri_lea_enrollment_2024-10.json';
    const schoolUrl = '/enrollment/ri_school_enrollment_2024-10.json';
    if (typeof window !== 'undefined') {
      console.log('enrollment fetch url', leaUrl);
    }
    const load = async () => {
      try {
        const leaRes = await fetch(leaUrl);
        if (!leaRes.ok) {
          throw new Error(`Fetch failed ${leaRes.status} ${leaRes.statusText} for ${leaUrl}. Did build:enrollment run? Output goes to frontend/public/enrollment/`);
        }
        const lea = (await leaRes.json()) as LeaEnrollmentMap;
        const schoolRes = await fetch(schoolUrl);
        if (!schoolRes.ok) {
          throw new Error(`Fetch failed ${schoolRes.status} ${schoolRes.statusText} for ${schoolUrl}`);
        }
        const school = (await schoolRes.json()) as SchoolEnrollmentMap;
        setLeaEnrollment(lea);
        setSchoolEnrollment(school);
        setEnrollmentLoadError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setEnrollmentLoadError(msg);
        console.error('Enrollment load error:', msg);
      }
    };
    load();
  }, []);

  useEffect(() => {
    fetch('/budgets/budgets.json')
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data: BudgetsMap) => setBudgets(data))
      .catch((e) => console.warn('Budgets not loaded:', e));
  }, []);

  useEffect(() => {
    fetch('/centroids/district-anchors.json')
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data: DistrictAnchorsMap) => setAnchors(data))
      .catch((e) => console.warn('Anchors not loaded:', e));
  }, []);

  const keyToGeoid = useMemo(() => {
    const m = new Map<string, string>();
    if (!districts?.features) return m;
    for (const f of districts.features) {
      const name = f.properties.district_name ?? f.properties.name ?? '';
      const geoid = f.properties.district_geoid ?? f.properties.geoid ?? '';
      if (name && geoid) m.set(districtKey(name), geoid);
    }
    return m;
  }, [districts]);

  const selectedGeoids = useMemo(
    () => selectedDistrictKeys.map((k) => keyToGeoid.get(k) ?? '').filter(Boolean),
    [selectedDistrictKeys, keyToGeoid],
  );

  const handleDistrictClick = useCallback(
    (d: DistrictFeature | null, shiftKey: boolean) => {
      if (!d) return;
      const name = d.properties.district_name ?? d.properties.name ?? '';
      const key = districtKey(name);
      setSelectedSchool(null);
      setSelectedDistrict(d);
      if (shiftKey) {
        setSelectedDistrictKeys((prev) =>
          prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
        );
      } else {
        setSelectedDistrictKeys([key]);
      }
    },
    [],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedSchool(null);
    setSelectedDistrict(null);
    setSelectedDistrictKeys([]);
    setHighlightDistrict(null);
  }, []);

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
        leaEnrollment={leaEnrollment}
        schoolEnrollment={schoolEnrollment}
        enrollmentLoadError={enrollmentLoadError}
        budgets={budgets}
        anchors={anchors}
        loading={loading}
        error={error}
        filters={filters}
        setFilters={setFilters}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedDistrict={selectedDistrict}
        selectedDistrictKeys={selectedDistrictKeys}
        selectedSchool={selectedSchool}
        showDistricts={showDistricts}
        setShowDistricts={setShowDistricts}
        showDistrictLabels={showDistrictLabels}
        setShowDistrictLabels={setShowDistrictLabels}
        clusterSchools={clusterSchools}
        setClusterSchools={setClusterSchools}
        districtLevelFilter={districtLevelFilter}
        setDistrictLevelFilter={setDistrictLevelFilter}
        showAnchors={showAnchors}
        setShowAnchors={setShowAnchors}
        onSearchSelect={(school, district) => {
          setSelectedSchool(school ?? null);
          setSelectedDistrict(district ?? null);
          setHighlightDistrict(district ?? null);
          if (district) {
            const name = district.properties.district_name ?? district.properties.name ?? '';
            setSelectedDistrictKeys([districtKey(name)]);
          } else {
            setSelectedDistrictKeys([]);
          }
        }}
        onClearSelection={handleClearSelection}
        sandboxDistrictKeys={sandboxDistrictKeys}
        setSandboxDistrictKeys={setSandboxDistrictKeys}
      />
      <MapView
        districts={filteredDistricts}
        schools={schools}
        loading={loading}
        showDistricts={showDistricts}
        showDistrictLabels={showDistrictLabels}
        showPublic={filters.public}
        showPrivate={filters.private}
        clusterSchools={clusterSchools}
        selectedDistrict={selectedDistrict}
        selectedGeoids={selectedGeoids}
        selectedSchool={selectedSchool}
        highlightDistrict={highlightDistrict}
        anchors={anchors}
        showAnchors={showAnchors}
        onDistrictClick={handleDistrictClick}
        onDistrictHover={setHighlightDistrict}
        onSchoolClick={setSelectedSchool}
      />
    </div>
  );
}

