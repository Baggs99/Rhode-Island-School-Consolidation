/**
 * District anchor types and loader.
 *
 * district-anchors.json schema:
 *   { [normalizedDistrictKey]: DistrictAnchor }
 */

export interface AnchorSchool {
  name: string;
  ncesId: string;
  enrollment: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  gradeBucket: string;
  districtGeoid: string;
  districtName: string;
}

export interface DistrictAnchor {
  displayName: string;
  lat: number;
  lon: number;
  anchorType: string;
  anchorSchool: AnchorSchool | null;
  flags: string[];
}

export type DistrictAnchorsMap = Record<string, DistrictAnchor>;

export async function loadDistrictAnchors(): Promise<DistrictAnchorsMap> {
  const res = await fetch('/centroids/district-anchors.json');
  if (!res.ok) throw new Error(`Failed to load anchors: ${res.status} ${res.statusText}`);
  return (await res.json()) as DistrictAnchorsMap;
}
