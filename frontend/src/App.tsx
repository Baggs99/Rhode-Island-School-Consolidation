import { useState, useEffect, useMemo, useCallback } from 'react';
import MapView from './components/Map';
import Sidebar from './components/Sidebar';
import { useMediaQuery } from './hooks/useMediaQuery';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from './types';
import { districtKey, type LeaEnrollmentMap, type SchoolEnrollmentMap } from './lib/enrollment';
import type { BudgetsMap } from './lib/budgets';
import type { DistrictAnchorsMap } from './lib/anchors';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || ct.includes('text/html')) {
    const body = await res.text();
    throw new Error(
      `Failed to load ${url} — status ${res.status}, content-type: ${ct}, body: ${body.slice(0, 120)}`,
    );
  }
  return (await res.json()) as T;
}

export default function App() {
  const [districts, setDistricts] = useState<GeoJSONFC<DistrictFeature> | null>(null);
  const [allSchools, setAllSchools] = useState<GeoJSONFC<SchoolFeature> | null>(null);
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
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mobileSidebarOpen') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('mobileSidebarOpen', mobileSidebarOpen ? '1' : '0');
    } catch { /* noop */ }
  }, [mobileSidebarOpen]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [distData, schoolData] = await Promise.all([
          fetchJson<GeoJSONFC<DistrictFeature>>('/geo/districts.geojson'),
          fetchJson<GeoJSONFC<SchoolFeature>>('/geo/schools.geojson'),
        ]);
        setDistricts(distData);
        setAllSchools(schoolData);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const schools = useMemo(() => {
    if (!allSchools?.features) return allSchools;
    let features = allSchools.features;
    const types: string[] = [];
    if (filters.public) types.push('public');
    if (filters.private) types.push('private');
    if (types.length > 0) {
      features = features.filter((f) => types.includes(f.properties.school_type));
    }
    if (filters.grade.length > 0) {
      features = features.filter((f) => filters.grade.includes(f.properties.grade_bucket));
    }
    return { type: 'FeatureCollection' as const, features };
  }, [allSchools, filters.public, filters.private, filters.grade]);

  useEffect(() => {
    (async () => {
      try {
        const [lea, school] = await Promise.all([
          fetchJson<LeaEnrollmentMap>('/enrollment/ri_lea_enrollment_2024-10.json'),
          fetchJson<SchoolEnrollmentMap>('/enrollment/ri_school_enrollment_2024-10.json'),
        ]);
        setLeaEnrollment(lea);
        setSchoolEnrollment(school);
        setEnrollmentLoadError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setEnrollmentLoadError(msg);
        console.error('Enrollment load error:', msg);
      }
    })();
  }, []);

  useEffect(() => {
    fetchJson<BudgetsMap>('/budgets/budgets.json')
      .then((data) => setBudgets(data))
      .catch((e) => console.warn('Budgets not loaded:', e));
  }, []);

  useEffect(() => {
    fetchJson<DistrictAnchorsMap>('/centroids/district-anchors.json')
      .then((data) => setAnchors(data))
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
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Sidebar
        isMobile={isMobile}
        mobileSidebarOpen={isMobile ? mobileSidebarOpen : true}
        onMobileClose={() => setMobileSidebarOpen(false)}
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
        isMobile={isMobile}
        onOpenPanel={() => setMobileSidebarOpen(true)}
        mobilePanelVisible={isMobile && !mobileSidebarOpen}
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

