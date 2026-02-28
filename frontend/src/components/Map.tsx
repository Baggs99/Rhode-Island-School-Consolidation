import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import Supercluster from 'supercluster';
import { toPng } from 'html-to-image';
import pointOnFeature from '@turf/point-on-feature';
import area from '@turf/area';
import type { GeoJSONFC, SchoolFeature, DistrictFeature } from '../types';
import type { DistrictAnchorsMap } from '../lib/anchors';

const RI_CENTER: [number, number] = [-71.5, 41.6];
const RI_ZOOM = 8;

// Free basemap: OpenStreetMap tiles (no API key)
// Glyphs required for symbol layer text rendering
const BASEMAP_STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
  showDistrictLabels: boolean;
  showPublic: boolean;
  showPrivate: boolean;
  clusterSchools: boolean;
  selectedDistrict: DistrictFeature | null;
  selectedGeoids: string[];
  selectedSchool: SchoolFeature | null;
  highlightDistrict: DistrictFeature | null;
  anchors: DistrictAnchorsMap | null;
  showAnchors: boolean;
  onDistrictClick: (d: DistrictFeature | null, shiftKey: boolean) => void;
  onDistrictHover: (d: DistrictFeature | null) => void;
  onSchoolClick: (s: SchoolFeature | null) => void;
}

/** All map layer IDs used for school points (clusters + unclustered). */
function collectSchoolLayerIds(clusterEnabled: boolean): string[] {
  const ids = ['school-points'];
  if (clusterEnabled) {
    ids.push('school-clusters', 'school-cluster-count');
  }
  return ids;
}

/** Small districts that need offset labels + callouts (curated). */
const OFFSET_LABEL_NAMES = new Set([
  'central falls',
  'pawtucket',
  'providence',
  'woonsocket',
  'cranston',
  'east providence',
  'little compton',
  'exeter-west greenwich',
  'foster-glocester',
]);

const SMALL_DISTRICT_AREA_KM2 = 25;
const OFFSET_DISTANCE_DEG = 0.018;
const LABEL_ABBREV_MIN_LEN = 22;

/** Format long district names for display (en dash, smart abbreviation). */
function formatLabelName(name: string): string {
  let out = name.replace(/\s*[-–—]\s*/g, '–');
  if (out.length <= LABEL_ABBREV_MIN_LEN) return out;
  out = out.replace(/West\s+Greenwich/gi, 'W. Greenwich');
  out = out.replace(/East\s+Greenwich/gi, 'E. Greenwich');
  out = out.replace(/North\s+Smithfield/gi, 'N. Smithfield');
  out = out.replace(/South\s+Kingstown/gi, 'S. Kingstown');
  return out;
}

type LabelProps = { districtName: string; offsetLabel: boolean; forceLabel: boolean; geoid: string; sortKey: number };

/** Build label points + callout lines for all district levels (unified, elementary, secondary). */
function buildDistrictLabelGeoJSON(
  districts: GeoJSONFC<DistrictFeature> | null
): {
  labels: GeoJSON.FeatureCollection<GeoJSON.Point, LabelProps>;
  callouts: GeoJSON.FeatureCollection<GeoJSON.LineString>;
} {
  const labelFeatures: GeoJSON.Feature<GeoJSON.Point, LabelProps>[] = [];
  const calloutFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  if (!districts?.features?.length) {
    return {
      labels: { type: 'FeatureCollection', features: labelFeatures },
      callouts: { type: 'FeatureCollection', features: calloutFeatures },
    };
  }
  const toLabel = districts.features;
  for (const f of toLabel) {
    const name = (f.properties?.district_name ?? f.properties?.name ?? '')?.trim();
    if (!name || /school district not defined/i.test(name)) continue;
    const geoid = f.properties?.district_geoid ?? f.properties?.geoid ?? '';
    const geom = f.geometry;
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;
    const feature = { type: 'Feature' as const, properties: {}, geometry: geom };
    const pointOn = pointOnFeature(feature as any);
    const [cx, cy] = pointOn.geometry.coordinates;
    const a = area({ type: 'FeatureCollection', features: [feature as any] } as any);
    const areaKm2 = a / 1e6;
    const nameLower = name.toLowerCase();
    const forceOffset = OFFSET_LABEL_NAMES.has(nameLower) || areaKm2 < SMALL_DISTRICT_AREA_KM2;
    const forceLabel = forceOffset;
    let labelLon = cx;
    let labelLat = cy;
    if (forceOffset) {
      labelLon = cx + OFFSET_DISTANCE_DEG;
      labelLat = cy;
      calloutFeatures.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [labelLon, labelLat],
            [cx, cy],
          ],
        },
      });
    }
    labelFeatures.push({
      type: 'Feature',
      properties: {
        districtName: formatLabelName(name),
        offsetLabel: forceOffset,
        forceLabel,
        geoid,
      },
      geometry: {
        type: 'Point',
        coordinates: [labelLon, labelLat],
      },
    });
  }
  const labels = { type: 'FeatureCollection' as const, features: labelFeatures };
  const callouts = { type: 'FeatureCollection' as const, features: calloutFeatures };
  return { labels, callouts };
}

/** Set visibility for school layers based on public/private toggles. When both off, hides all. */
function applySchoolVisibilityAndFilters(
  map: maplibregl.Map,
  opts: { showPublic: boolean; showPrivate: boolean; clusterEnabled: boolean }
): void {
  const { showPublic, showPrivate, clusterEnabled } = opts;
  const layerIds = collectSchoolLayerIds(clusterEnabled);
  const showAny = showPublic || showPrivate;
  const visibility = showAny ? 'visible' : 'none';

  for (const id of layerIds) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}

export default function Map({
  districts,
  schools,
  loading,
  showDistricts,
  showDistrictLabels,
  showPublic,
  showPrivate,
  clusterSchools,
  selectedDistrict,
  selectedGeoids,
  selectedSchool,
  highlightDistrict,
  anchors,
  showAnchors,
  onDistrictClick,
  onDistrictHover,
  onSchoolClick,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const districtsSourceRef = useRef<string | null>(null);
  const districtLabelsSourceRef = useRef<string | null>(null);
  const districtCalloutsSourceRef = useRef<string | null>(null);
  const schoolsSourceRef = useRef<string | null>(null);
  const clusterIndexRef = useRef<Supercluster<SchoolFeature, { point_count: number }> | null>(null);
  const anchorsSourceRef = useRef<boolean>(false);
  const anchorPopupRef = useRef<maplibregl.Popup | null>(null);
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

    const layerIds = ['district-fill', 'district-outline', 'district-outline-hover', 'district-highlight', 'district-flash'];
    if (districtsSourceRef.current) {
      layerIds.forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      map.removeSource(districtsSourceRef.current);
    }
    districtsSourceRef.current = 'districts';
    map.addSource('districts', { type: 'geojson', data: data as any });
    const beforeSchoolLayer = map.getLayer('school-points') ? 'school-points' : map.getLayer('school-clusters') ? 'school-clusters' : undefined;
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
    map.addLayer(
      {
        id: 'district-flash',
        type: 'fill',
        source: 'districts',
        paint: {
          'fill-color': '#fdd835',
          'fill-opacity': 0,
          'fill-opacity-transition': { duration: 600, delay: 0 },
        },
        filter: ['==', ['get', 'district_geoid'], ''],
      },
      beforeSchoolLayer
    );

    const handleClick = (e: any) => {
      const f = e.features?.[0];
      if (f) onDistrictClick(f as any, e.originalEvent?.shiftKey ?? false);
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
    const hoverGeoid =
      highlightDistrict?.properties?.district_geoid ??
      highlightDistrict?.properties?.geoid ??
      '';
    if (hoverGeoid) {
      map.setFilter('district-highlight', ['==', ['get', 'district_geoid'], hoverGeoid]);
    } else if (selectedGeoids.length > 0) {
      map.setFilter('district-highlight', ['in', ['get', 'district_geoid'], ['literal', selectedGeoids]]);
    } else {
      map.setFilter('district-highlight', ['==', ['get', 'district_geoid'], '']);
    }
  }, [highlightDistrict, selectedGeoids]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedDistrict || !map.getLayer('district-flash')) return;
    const geoid = selectedDistrict.properties.district_geoid ?? selectedDistrict.properties.geoid ?? '';
    if (!geoid) return;
    map.setFilter('district-flash', ['==', ['get', 'district_geoid'], geoid]);
    map.setPaintProperty('district-flash', 'fill-opacity', 0.5);
    const timer = setTimeout(() => {
      if (map.getLayer('district-flash')) {
        map.setPaintProperty('district-flash', 'fill-opacity', 0);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [selectedDistrict]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const visibility = showDistricts ? 'visible' : 'none';
    ['district-fill', 'district-outline', 'district-outline-hover', 'district-highlight', 'district-flash'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    });
  }, [showDistricts]);

  const districtLabelData = useMemo(
    () => buildDistrictLabelGeoJSON(districts),
    [districts]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || districts == null) return;
    if (!showDistrictLabels) {
      if (districtLabelsSourceRef.current) {
        if (map.getLayer('district-labels')) map.removeLayer('district-labels');
        if (map.getLayer('district-callouts')) map.removeLayer('district-callouts');
        map.removeSource('district-labels');
        map.removeSource('district-callouts');
        districtLabelsSourceRef.current = null;
        districtCalloutsSourceRef.current = null;
      }
      return;
    }
    if (showDistrictLabels) {
      console.log('district-labels source:', map.getSource('district-labels'));
      console.log('district-labels layer:', map.getLayer('district-labels'));
      console.log('district-callouts layer:', map.getLayer('district-callouts'));
    }
    const beforeSchool = map.getLayer('school-points') ? 'school-points' : map.getLayer('school-clusters') ? 'school-clusters' : undefined;
    if (districtLabelsSourceRef.current) {
      const labelsSrc = map.getSource('district-labels') as maplibregl.GeoJSONSource;
      const calloutsSrc = map.getSource('district-callouts') as maplibregl.GeoJSONSource;
      if (labelsSrc) labelsSrc.setData(districtLabelData.labels as any);
      if (calloutsSrc) calloutsSrc.setData(districtLabelData.callouts as any);
    } else {
      const addLabelLayers = () => {
        if (districtLabelsSourceRef.current) return;
        map.addSource('district-labels', {
          type: 'geojson',
          data: districtLabelData.labels as any,
        });
        map.addSource('district-callouts', {
          type: 'geojson',
          data: districtLabelData.callouts as any,
        });
        districtLabelsSourceRef.current = 'district-labels';
        districtCalloutsSourceRef.current = 'district-callouts';
        map.addLayer(
          {
            id: 'district-callouts',
            type: 'line',
            source: 'district-callouts',
            paint: {
              'line-color': '#1e40af',
              'line-width': 1,
              'line-dasharray': [2, 1],
            },
          },
          beforeSchool
        );
        map.addLayer({
          id: 'district-labels',
          type: 'symbol',
          source: 'district-labels',
          layout: {
            visibility: 'visible',
            'symbol-placement': 'point',
            'symbol-sort-key': ['get', 'sortKey'],
            'text-field': ['get', 'districtName'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 13,
            'text-anchor': 'center',
            'text-optional': true,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#0f172a',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
            'text-halo-blur': 0.5,
          },
        });
      };
      if (map.isStyleLoaded()) {
        addLabelLayers();
      } else {
        map.once('load', addLabelLayers);
      }
    }
  }, [districts, showDistrictLabels, districtLabelData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const labelVis = showDistrictLabels && showDistricts ? 'visible' : 'none';
    ['district-labels', 'district-callouts'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', labelVis);
    });
  }, [showDistrictLabels, showDistricts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || schools == null) return;

    const schoolGeoJSON = (schools.features?.length
      ? schools
      : { type: 'FeatureCollection' as const, features: [] }) as GeoJSONFC<SchoolFeature>;

    if (schoolsSourceRef.current) {
      if (map.getLayer('school-clusters')) map.removeLayer('school-clusters');
      if (map.getLayer('school-cluster-count')) map.removeLayer('school-cluster-count');
      if (map.getLayer('school-points')) map.removeLayer('school-points');
      map.removeSource(schoolsSourceRef.current);
    }
    schoolsSourceRef.current = 'schools';

    let updateSchools: (() => void) | undefined;
    let handleClusterClick: ((e: maplibregl.MapLayerMouseEvent) => void) | undefined;

    if (clusterSchools) {
      const index = new Supercluster<SchoolFeature, { point_count: number }>({
        radius: 50,
        maxZoom: 16,
      });
      index.load(
        schoolGeoJSON.features.map((f) => ({
          ...f,
          geometry: { type: 'Point' as const, coordinates: f.geometry.coordinates },
        }))
      );
      clusterIndexRef.current = index;

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

      updateSchools = () => {
        const zoom = map.getZoom() ?? 0;
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

      handleClusterClick = (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f?.properties?.cluster) return;
        const clusterId = (f.properties as any).cluster_id ?? f.id;
        const expansionZoom = Math.min(index.getClusterExpansionZoom(clusterId), 18);
        map.easeTo({ center: (f.geometry as any).coordinates, zoom: expansionZoom });
      };
      map.on('click', 'school-clusters', handleClusterClick);
    } else {
      clusterIndexRef.current = null;
      map.addSource('schools', {
        type: 'geojson',
        data: schoolGeoJSON as any,
        promoteId: 'id',
      });
      map.addLayer({
        id: 'school-points',
        type: 'circle',
        source: 'schools',
        paint: {
          'circle-color': ['match', ['get', 'school_type'], 'public', '#2e7d32', '#1565c0'],
          'circle-radius': ['match', ['get', 'school_type'], 'public', 6, 5],
          'circle-stroke-width': ['match', ['get', 'school_type'], 'public', 2, 3],
          'circle-stroke-color': '#fff',
        },
      });
    }

    const handleSchoolClick = (e: maplibregl.MapLayerMouseEvent) => {
      const fid = e.features?.[0]?.id;
      const school = schoolGeoJSON.features.find((s) => s.properties.id === fid);
      if (school) onSchoolClick(school);
    };
    map.on('click', 'school-points', handleSchoolClick);
    map.on('mouseenter', 'school-points', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'school-points', () => (map.getCanvas().style.cursor = ''));

    applySchoolVisibilityAndFilters(map, {
      showPublic,
      showPrivate,
      clusterEnabled: clusterSchools,
    });

    return () => {
      map.off('click', 'school-points', handleSchoolClick);
      map.off('mouseenter', 'school-points');
      map.off('mouseleave', 'school-points');
      if (clusterSchools && updateSchools && handleClusterClick) {
        map.off('zoom', updateSchools);
        map.off('moveend', updateSchools);
        map.off('click', 'school-clusters', handleClusterClick);
      }
    };
  }, [schools, clusterSchools, showPublic, showPrivate, onSchoolClick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applySchoolVisibilityAndFilters(map, {
      showPublic,
      showPrivate,
      clusterEnabled: clusterSchools,
    });
  }, [showPublic, showPrivate, clusterSchools]);


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

  const anchorGeoJSON = useMemo(() => {
    if (!anchors) return null;
    const features = Object.entries(anchors).map(([key, a]) => ({
      type: 'Feature' as const,
      properties: {
        key,
        displayName: a.displayName,
        lat: a.lat,
        lon: a.lon,
        anchorType: a.anchorType,
        schoolName: a.anchorSchool?.name ?? '',
        enrollment: a.anchorSchool?.enrollment ?? '',
        gradeBucket: a.anchorSchool?.gradeBucket ?? '',
        flags: a.flags,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [a.lon, a.lat],
      },
    }));
    return { type: 'FeatureCollection' as const, features };
  }, [anchors]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !anchorGeoJSON) return;

    const addAnchorLayers = () => {
      if (anchorsSourceRef.current) {
        const src = map.getSource('district-anchors') as maplibregl.GeoJSONSource;
        if (src) src.setData(anchorGeoJSON as any);
        return;
      }
      map.addSource('district-anchors', {
        type: 'geojson',
        data: anchorGeoJSON as any,
      });
      map.addLayer({
        id: 'district-anchors-circle',
        type: 'circle',
        source: 'district-anchors',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match', ['get', 'anchorType'],
            'high_school', '#1565c0',
            'elementary_school', '#2e7d32',
            '#e53935',
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
        layout: { visibility: 'none' },
      });
      map.addLayer({
        id: 'district-anchors-label',
        type: 'symbol',
        source: 'district-anchors',
        layout: {
          visibility: 'none',
          'text-field': ['get', 'displayName'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#1a237e',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
      anchorsSourceRef.current = true;
    };

    if (map.isStyleLoaded()) {
      addAnchorLayers();
    } else {
      map.once('load', addAnchorLayers);
    }
  }, [anchorGeoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const vis = showAnchors ? 'visible' : 'none';
    ['district-anchors-circle', 'district-anchors-label'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });

    if (!showAnchors) {
      if (anchorPopupRef.current) {
        anchorPopupRef.current.remove();
        anchorPopupRef.current = null;
      }
      return;
    }

    const handleAnchorClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, unknown>;
      const displayName = String(props.displayName ?? '');
      const key = String(props.key ?? '');
      const lat = Number(props.lat);
      const lon = Number(props.lon);
      const anchorType = String(props.anchorType ?? '');
      const schoolName = String(props.schoolName ?? '');
      const enrollment = props.enrollment !== '' && props.enrollment != null ? Number(props.enrollment) : null;
      let flags: string[] = [];
      try {
        const raw = props.flags;
        flags = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw as string[] : [];
      } catch { /* empty */ }

      const schoolLine = schoolName
        ? `School: ${escapeHtml(schoolName)}${enrollment != null ? ` (${enrollment.toLocaleString()} enrolled)` : ''}<br/>`
        : '';

      if (anchorPopupRef.current) anchorPopupRef.current.remove();
      anchorPopupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font-family: sans-serif; font-size: 13px;">
            <strong>${escapeHtml(displayName)}</strong><br/>
            Type: ${escapeHtml(anchorType.replace(/_/g, ' '))}<br/>
            ${schoolLine}
            Lat/Lon: ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/>
            Flags: ${flags.length ? escapeHtml(flags.join(', ')) : 'none'}
          </div>
        `)
        .addTo(map);
    };

    const handleEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const handleLeave = () => { map.getCanvas().style.cursor = ''; };

    map.on('click', 'district-anchors-circle', handleAnchorClick);
    map.on('mouseenter', 'district-anchors-circle', handleEnter);
    map.on('mouseleave', 'district-anchors-circle', handleLeave);

    return () => {
      map.off('click', 'district-anchors-circle', handleAnchorClick);
      map.off('mouseenter', 'district-anchors-circle', handleEnter);
      map.off('mouseleave', 'district-anchors-circle', handleLeave);
    };
  }, [showAnchors]);

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
