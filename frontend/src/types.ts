export interface SchoolProperties {
  id: string;
  name: string;
  school_type: 'public' | 'private';
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  grades_low?: number;
  grades_high?: number;
  grade_bucket: 'Elementary' | 'Middle' | 'High' | 'Other';
  lat: number;
  lon: number;
  district_geoid?: string;
  district_name?: string;
  source: string;
  nces_id?: string;
  pss_id?: string;
}

export interface SchoolFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: SchoolProperties;
}

export type DistrictLevel = 'unified' | 'elementary' | 'secondary';

export interface DistrictProperties {
  district_name: string;
  district_geoid: string;
  district_level?: DistrictLevel;
  source_layer?: string;
  name?: string;
  geoid?: string;
  district_type?: string;
  statefp?: string;
  unsdleaid?: string;
}

export interface DistrictFeature {
  type: 'Feature';
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][] | number[][][] };
  properties: DistrictProperties;
}

export interface GeoJSONFC<T = SchoolFeature> {
  type: 'FeatureCollection';
  features: T[];
}
