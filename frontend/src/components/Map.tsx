import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import Supercluster from 'supercluster';
import { toPng } from 'html-to-image';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from '../types';

const RI_CENTER: [number, number] = [-71.5, 41.6];
const RI_ZOOM = 8;

// Free basemap: OpenStreetMap tiles (no API key)
// Fallback: MapLibre demo tiles
const BASEMAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

interface MapProps {
  districts: GeoJSONFC<DistrictFeature> | null;
  schools: GeoJSONFC<SchoolFeature> | null;
  loading: boolean;
  showDistricts: boolean;
  selectedDistrict: DistrictFeature | null;
  selectedSchool: SchoolFeature | null;
  highlightDistrict: DistrictFeature | null;
  onDistrictClick: (d: DistrictFeature | null) => void;
  onDistrictHover: (d: DistrictFeature | null) => void;
  onSchoolClick: (s: SchoolFeature | null) => void;
}

export default function Map({
  districts,
  schools,
  loading,
  showDistricts,
  selectedDistrict,
  selectedSchool,
  highlightDistrict,
  onDistrictClick,
  onDistrictHover,
  onSchoolClick,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const districtsSourceRef = useRef<string | null>(null);
  const schoolsSourceRef = useRef<string | null>(null);
  const clusterIndexRef = useRef<Supercluster<SchoolFeature, { point_count: number }> | null>(null);
  const [clusterZoom, setClusterZoom] = useState(0);
  const [exportingPng, setExportingPng] = useState(false);
  const [hoveredDistrictLabel, setHoveredDistrictLabel] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE as any,
      center: RI_CENTER,
      zoom: RI_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || districts == null) return;
    const data = districts;

    const layerIds = ['district-fill', 'district-outline', 'district-outline-hover', 'district-highlight'];
    if (districtsSourceRef.current) {
      layerIds.forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      map.removeSource(districtsSourceRef.current);
    }
    districtsSourceRef.current = 'districts';
    map.addSource('districts', { type: 'geojson', data: data as any });
    const beforeSchoolLayer = map.getLayer('school-clusters') ? 'school-clusters' : undefined;
    map.addLayer(
      {
        id: 'district-fill',
        type: 'fill',
        source: 'districts',
        paint: {
          'fill-color': '#2563eb',
          'fill-opacity': [
            'match',
            ['coalesce', ['get', 'district_level'], 'unified'],
            'elementary',
            0.06,
            'secondary',
            0.1,
            0.12,
          ],
        },
      },
      beforeSchoolLayer
    );
    map.addLayer(
      {
        id: 'district-outline',
        type: 'line',
        source: 'districts',
        paint: {
          'line-color': '#1e40af',
          'line-width': [
            'match',
            ['coalesce', ['get', 'district_level'], 'unified'],
            'unified',
            3,
            'secondary',
            2,
            1.5,
          ],
        },
      },
      beforeSchoolLayer
    );
    map.addLayer(
      {
        id: 'district-outline-hover',
        type: 'line',
        source: 'districts',
        paint: { 'line-color': '#1e40af', 'line-width': 4 },
        filter: ['==', ['get', 'district_geoid'], ''],
      },
      beforeSchoolLayer
    );
    map.addLayer(
      {
        id: 'district-highlight',
        type: 'line',
        source: 'districts',
        paint: { 'line-color': '#1e3a8a', 'line-width': 3 },
        filter: ['==', ['get', 'district_geoid'], ''],
      },
      beforeSchoolLayer
    );

    const handleClick = (e: any) => {
      const f = e.features?.[0];
      if (f) onDistrictClick(f as any);
    };
    const handleMove = (e: any) => {
      const f = e.features?.[0];
      if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      onDistrictHover(f as any);
      const name = f.properties?.district_name ?? f.properties?.name ?? 'Unknown district';
      const level = f.properties?.district_level ?? 'unified';
      const displayName = `${name} (${level})`;
      setHoveredDistrictLabel({ name: displayName, x: e.point.x, y: e.point.y });
      map.setFilter('district-outline-hover', ['==', ['get', 'district_geoid'], String(f.properties?.district_geoid ?? '')]);
    };
    const handleLeave = () => {
      map.getCanvas().style.cursor = '';
      onDistrictHover(null);
      setHoveredDistrictLabel(null);
      map.setFilter('district-outline-hover', ['==', ['get', 'district_geoid'], '']);
    };

    map.on('click', 'district-fill', handleClick);
    map.on('mousemove', 'district-fill', handleMove);
    map.on('mouseleave', 'district-fill', handleLeave);

    return () => {
      map.off('click', 'district-fill', handleClick);
      map.off('mousemove', 'district-fill', handleMove);
      map.off('mouseleave', 'district-fill', handleLeave);
    };
  }, [districts, onDistrictClick, onDistrictHover]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('district-highlight')) return;
    const geoid =
      highlightDistrict?.properties?.district_geoid ??
      highlightDistrict?.properties?.geoid ??
      selectedDistrict?.properties?.district_geoid ??
      selectedDistrict?.properties?.geoid ??
      '';
    map.setFilter('district-highlight', ['==', ['get', 'district_geoid'], geoid]);
  }, [highlightDistrict, selectedDistrict]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const visibility = showDistricts ? 'visible' : 'none';
    ['district-fill', 'district-outline', 'district-outline-hover', 'district-highlight'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    });
  }, [showDistricts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !schools?.features?.length) return;

    const index = new Supercluster<SchoolFeature, { point_count: number }>({
      radius: 50,
      maxZoom: 16,
    });
    index.load(
      schools.features.map((f) => ({
        ...f,
        geometry: { type: 'Point' as const, coordinates: f.geometry.coordinates },
      }))
    );
    clusterIndexRef.current = index;

    if (schoolsSourceRef.current) {
      if (map.getLayer('school-clusters')) map.removeLayer('school-clusters');
      if (map.getLayer('school-cluster-count')) map.removeLayer('school-cluster-count');
      if (map.getLayer('school-points')) map.removeLayer('school-points');
      map.removeSource(schoolsSourceRef.current);
    }
    schoolsSourceRef.current = 'schools';

    const getClusterGeoJSON = (zoom: number) => {
      const b = map.getBounds();
      const bounds: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      const clusters = index.getClusters(bounds, Math.floor(zoom));
      return {
        type: 'FeatureCollection' as const,
        features: clusters.map((c) => {
          if (c.properties.cluster) {
            return {
              type: 'Feature' as const,
              id: c.id,
              properties: {
                cluster: true,
                point_count: c.properties.point_count,
                point_count_abbreviated: c.properties.point_count >= 1000 ? `${(c.properties.point_count / 1000).toFixed(1)}k` : String(c.properties.point_count),
                cluster_id: c.id,
              },
              geometry: c.geometry,
            };
          }
          return {
            type: 'Feature' as const,
            id: (c as SchoolFeature).properties.id,
            properties: { ...(c as SchoolFeature).properties, cluster: false },
            geometry: (c as SchoolFeature).geometry,
          };
        }),
      };
    };

    const updateSchools = () => {
      const zoom = map.getZoom() ?? 0;
      setClusterZoom(zoom);
      const source = map.getSource('schools') as maplibregl.GeoJSONSource;
      if (source) source.setData(getClusterGeoJSON(zoom) as any);
    };

    map.addSource('schools', {
      type: 'geojson',
      data: getClusterGeoJSON(map.getZoom() ?? RI_ZOOM) as any,
      promoteId: 'id',
    });
    map.addLayer({
      id: 'school-clusters',
      type: 'circle',
      source: 'schools',
      filter: ['==', ['get', 'cluster'], true],
      paint: {
        'circle-color': ['match', ['get', 'point_count'], 1, '#4caf50', '#2196f3'],
        'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 100, 28],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });
    map.addLayer({
      id: 'school-cluster-count',
      type: 'symbol',
      source: 'schools',
      filter: ['==', ['get', 'cluster'], true],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-size': 12,
      },
      paint: { 'text-color': '#fff' },
    });
    map.addLayer({
      id: 'school-points',
      type: 'circle',
      source: 'schools',
      filter: ['!=', ['get', 'cluster'], true],
      paint: {
        'circle-color': ['match', ['get', 'school_type'], 'public', '#2e7d32', '#1565c0'],
        'circle-radius': ['match', ['get', 'school_type'], 'public', 6, 5],
        'circle-stroke-width': ['match', ['get', 'school_type'], 'public', 2, 3],
        'circle-stroke-color': '#fff',
      },
    });

    map.on('zoom', updateSchools);
    map.on('moveend', updateSchools);

    map.on('click', 'school-clusters', (e) => {
      const f = e.features?.[0];
      if (!f?.properties?.cluster) return;
      const clusterId = (f.properties as any).cluster_id ?? f.id;
      const zoom = map.getZoom() ?? 0;
      const index = clusterIndexRef.current;
      if (!index) return;
      const expansionZoom = Math.min(index.getClusterExpansionZoom(clusterId), 18);
      map.easeTo({ center: (f.geometry as any).coordinates, zoom: expansionZoom });
    });
    map.on('click', 'school-points', (e) => {
      const fid = e.features?.[0]?.id;
      const school = schools.features.find((s) => s.properties.id === fid);
      if (school) onSchoolClick(school);
    });
    map.on('mouseenter', 'school-clusters', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseenter', 'school-points', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'school-clusters', () => map.getCanvas().style.cursor = '');
    map.on('mouseleave', 'school-points', () => map.getCanvas().style.cursor = '');
  }, [schools, onSchoolClick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedDistrict) return;
    const geom = selectedDistrict.geometry;
    const coords: [number, number][] = [];
    if (geom.type === 'Polygon') {
      geom.coordinates.forEach((ring) => {
        ring.forEach((c) => coords.push([c[0], c[1]]));
      });
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((poly) => {
        poly.forEach((ring) => {
          ring.forEach((c) => coords.push([c[0], c[1]]));
        });
      });
    }
    if (!coords.length) return;
    let minLon = coords[0][0];
    let maxLon = coords[0][0];
    let minLat = coords[0][1];
    let maxLat = coords[0][1];
    coords.forEach(([lon, lat]) => {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
    const bounds = new maplibregl.LngLatBounds(
      [minLon, minLat],
      [maxLon, maxLat],
    );
    map.fitBounds(bounds, { padding: 40, maxZoom: 13 });
  }, [selectedDistrict]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedSchool) return;
    const [lon, lat] = selectedSchool.geometry.coordinates;
    const popup = new maplibregl.Popup({ closeButton: true })
      .setLngLat([lon, lat])
      .setHTML(renderSchoolPopup(selectedSchool))
      .addTo(map);
    map.flyTo({ center: [lon, lat], zoom: 14 });
    return () => popup.remove();
  }, [selectedSchool]);

  const handleExportGeoJSON = useCallback(() => {
    if (!schools?.features?.length) return;
    let feats = schools.features;
    const map = mapRef.current;
    if (map) {
      const b = map.getBounds();
      feats = feats.filter((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return lat >= b.getSouth() && lat <= b.getNorth() && lon >= b.getWest() && lon <= b.getEast();
      });
    }
    const fc = { type: 'FeatureCollection' as const, features: feats };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'schools-export.geojson';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [schools]);

  const handleExportPNG = useCallback(async () => {
    if (!containerRef.current && !mapRef.current) return;
    setExportingPng(true);
    try {
      const map = mapRef.current;
      if (map) {
        try {
          const canvas = map.getCanvas();
          const dataUrl = canvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = 'map-export.png';
          a.click();
          setExportingPng(false);
          return;
        } catch {
          // fall through to html-to-image below
        }
      }

      if (containerRef.current) {
        const dataUrl = await toPng(containerRef.current, { cacheBust: true });
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'map-export.png';
        a.click();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to export map as PNG', err);
      alert('Unable to export map as PNG. Please try again.');
    } finally {
      setExportingPng(false);
    }
  }, []);

  return (
    <div style={{ flex: 1, position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {hoveredDistrictLabel && (
        <div
          style={{
            position: 'absolute',
            top: hoveredDistrictLabel.y + 12,
            left: hoveredDistrictLabel.x + 12,
            background: 'rgba(0,0,0,0.8)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {hoveredDistrictLabel.name}
        </div>
      )}
      {loading && (
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          Loading...
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <button
          onClick={handleExportGeoJSON}
          disabled={!schools?.features?.length}
          style={{
            padding: '8px 12px',
            background: '#1976d2',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: schools?.features?.length ? 'pointer' : 'not-allowed',
            fontSize: 13,
          }}
        >
          Export visible schools (GeoJSON)
        </button>
        <button
          onClick={handleExportPNG}
          disabled={exportingPng}
          style={{
            padding: '8px 12px',
            background: exportingPng ? '#90a4ae' : '#1976d2',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: exportingPng ? 'wait' : 'pointer',
            fontSize: 13,
          }}
        >
          {exportingPng ? 'Exporting…' : 'Export map view (PNG)'}
        </button>
      </div>
    </div>
  );
}

function renderSchoolPopup(s: SchoolFeature): string {
  const p = s.properties;
  const addr = [p.street, [p.city, p.state, p.zip].filter(Boolean).join(', ')].filter(Boolean).join('<br/>');
  const grades = p.grades_low != null || p.grades_high != null
    ? `Grades ${p.grades_low ?? '?'}-${p.grades_high ?? '?'}`
    : '';
  const idLine = p.nces_id ? `NCES ID: ${p.nces_id}` : p.pss_id ? `PSS ID: ${p.pss_id}` : '';
  const gmUrl = `https://www.google.com/maps?q=${p.lat},${p.lon}`;
  return `
    <div style="min-width: 220px; font-family: sans-serif; font-size: 13px;">
      <strong>${escapeHtml(p.name)}</strong><br/>
      <span style="color:#666">${escapeHtml(p.school_type)}</span><br/>
      ${addr ? `<br/>${addr}` : ''}
      ${grades ? `<br/>${grades}` : ''}
      ${idLine ? `<br/>${idLine}` : ''}
      <br/><a href="${gmUrl}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>`;
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
