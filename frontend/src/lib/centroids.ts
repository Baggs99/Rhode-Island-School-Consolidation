/**
 * District centroid types and loader.
 *
 * district-centroids.json schema:
 *   { [normalizedDistrictKey]: DistrictCentroid }
 *
 * Keys match enrollment, budgets, and districts.geojson lookups.
 */

export interface DistrictCentroid {
  displayName: string;
  lat: number;
  lon: number;
  flags: string[];
}

export type DistrictCentroidsMap = Record<string, DistrictCentroid>;

export async function loadDistrictCentroids(): Promise<DistrictCentroidsMap> {
  const res = await fetch('/centroids/district-centroids.json');
  if (!res.ok) throw new Error(`Failed to load centroids: ${res.status} ${res.statusText}`);
  return (await res.json()) as DistrictCentroidsMap;
}
