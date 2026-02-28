#!/usr/bin/env node
/**
 * Build district centroids JSON using @turf/point-on-feature.
 *
 * Input:  data/districts.geojson
 * Output: frontend/public/centroids/district-centroids.json
 *
 * Each entry: { displayName, lat, lon, flags[] }
 * Keys use the shared normalizeDistrictName()/districtKey().
 *
 * Run: npm run build:centroids
 */

import * as fs from 'fs';
import * as path from 'path';
import pointOnFeature from '@turf/point-on-feature';
import centroid from '@turf/centroid';
import { districtKey } from './lib/normalize';

const PROJECT_ROOT = process.cwd();
const DISTRICTS_PATH = process.env.DISTRICTS_GEOJSON ?? path.join(PROJECT_ROOT, 'data', 'districts.geojson');
const OUT_DIR = path.join(PROJECT_ROOT, 'frontend', 'public', 'centroids');

interface DistrictCentroid {
  displayName: string;
  lat: number;
  lon: number;
  flags: string[];
}

type CentroidsMap = Record<string, DistrictCentroid>;

function main(): void {
  console.log('Building district centroids from districts.geojson...\n');

  if (!fs.existsSync(DISTRICTS_PATH)) {
    console.error(`Districts GeoJSON not found: ${DISTRICTS_PATH}`);
    console.error('Run: npm run build:districts first.');
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'district-centroids.json'), '{}');
    return;
  }

  const geojson = JSON.parse(fs.readFileSync(DISTRICTS_PATH, 'utf-8'));
  const features: Array<{ type: string; geometry: GeoJSON.Geometry; properties: Record<string, unknown> }> =
    geojson.features ?? [];

  const centroids: CentroidsMap = {};
  let processed = 0;
  let fallbacks = 0;
  let skipped = 0;

  for (const feature of features) {
    const geom = feature.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
      console.warn(`  Skip: feature with geometry type "${geom?.type ?? 'null'}"`);
      skipped++;
      continue;
    }

    const displayName = String(
      feature.properties.district_name ?? feature.properties.name ?? 'Unknown'
    ).trim();
    const key = districtKey(displayName);
    const flags: string[] = [];

    if (centroids[key]) {
      console.warn(`  Key collision: "${key}" (existing: "${centroids[key].displayName}", new: "${displayName}") — keeping first`);
      flags.push('key_collision');
      continue;
    }

    let lon: number;
    let lat: number;

    try {
      const pt = pointOnFeature(feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>);
      const coords = pt.geometry.coordinates;
      lon = coords[0];
      lat = coords[1];
      if (typeof lon !== 'number' || typeof lat !== 'number' || isNaN(lon) || isNaN(lat)) {
        throw new Error('Invalid coordinates from pointOnFeature');
      }
    } catch {
      try {
        const ct = centroid(feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>);
        lon = ct.geometry.coordinates[0];
        lat = ct.geometry.coordinates[1];
        flags.push('used_centroid_fallback');
        fallbacks++;
        console.warn(`  Fallback to centroid for "${displayName}"`);
      } catch {
        console.warn(`  Skip: could not compute point for "${displayName}"`);
        skipped++;
        continue;
      }
    }

    centroids[key] = {
      displayName,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      flags,
    };
    processed++;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'district-centroids.json');
  fs.writeFileSync(outPath, JSON.stringify(centroids, null, 2));

  console.log(`  Features in GeoJSON: ${features.length}`);
  console.log(`  Centroids written: ${processed}`);
  console.log(`  Fallbacks (centroid): ${fallbacks}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Output: ${outPath}\n`);

  const keys = Object.keys(centroids).sort();
  for (const k of keys) {
    const c = centroids[k];
    const flagStr = c.flags.length > 0 ? ` [${c.flags.join(', ')}]` : '';
    console.log(`  ${k.padEnd(32)} (${c.lat.toFixed(4)}, ${c.lon.toFixed(4)})${flagStr}`);
  }
}

main();
