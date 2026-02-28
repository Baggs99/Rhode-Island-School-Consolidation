/**
 * Rhode Island School Map - Backend API
 * Serves GeoJSON for districts and schools with filtering.
 */

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import * as path from 'path';
import * as fs from 'fs';
import Fuse from 'fuse.js';

const app = express();
app.use(cors());
app.use(morgan('short'));

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_MAX_AGE = process.env.NODE_ENV === 'production' ? 3600 : 60;

interface SchoolProperties {
  id: string;
  name: string;
  school_type: 'public' | 'private';
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  grades_low?: number;
  grades_high?: number;
  grade_bucket: string;
  lat: number;
  lon: number;
  district_geoid?: string;
  district_name?: string;
  source: string;
  nces_id?: string;
  pss_id?: string;
}

interface GeoJSONFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: number[] };
  properties: SchoolProperties;
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

let districtsData: GeoJSONFC | null = null;
let schoolsData: GeoJSONFC | null = null;

function loadDistricts(): GeoJSONFC {
  if (districtsData) return districtsData;
  const p = path.join(DATA_DIR, 'districts.geojson');
  if (!fs.existsSync(p)) throw new Error('districts.geojson not found. Run: npm run build:districts');
  districtsData = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return districtsData!;
}

function loadSchools(): GeoJSONFC {
  const p = path.join(DATA_DIR, 'schools.geojson');
  if (!fs.existsSync(p)) throw new Error('schools.geojson not found. Run: npm run build:data');
  if (process.env.NODE_ENV !== 'production') {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  if (schoolsData) return schoolsData;
  schoolsData = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return schoolsData!;
}

app.get('/api/districts', (req, res) => {
  try {
    const data = loadDistricts();
    const levelParam = (req.query.level as string)?.trim();
    let features = data.features;
    if (levelParam) {
      const levels = levelParam.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
      if (levels.length) {
        features = features.filter((f: any) =>
          levels.includes(String(f.properties?.district_level ?? '').toLowerCase())
        );
      }
    }
    res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
    res.type('application/geo+json');
    res.send({ type: 'FeatureCollection', features });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/schools', (req, res) => {
  try {
    let data = loadSchools();
    const typeParam = req.query.type as string | undefined;
    const gradeParam = req.query.grade as string | undefined;
    const q = (req.query.q as string || '').trim().toLowerCase();

    let features = [...data.features];

    if (typeParam !== undefined) {
      const types = typeParam.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      features = types.length === 0 ? [] : features.filter((f) => types.includes(f.properties.school_type));
    }

    if (gradeParam) {
      const grades = gradeParam.split(',').map((g) => g.trim());
      features = features.filter((f) => grades.includes(f.properties.grade_bucket));
    }

    if (q) {
      const fuse = new Fuse(features, {
        keys: ['properties.name', 'properties.district_name'],
        threshold: 0.4,
      });
      const results = fuse.search(q);
      features = results.map((r) => r.item);
    }

    res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
    res.json({ type: 'FeatureCollection', features } as GeoJSONFC);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// In production, serve the built frontend
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
}

// Catch-all: serve frontend index.html for client-side routing
app.get('*', (_req, res) => {
  const index = path.join(FRONTEND_DIST, 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(404).send('Frontend not built. Run: npm run build');
  }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  try {
    loadDistricts();
    console.log('Districts preloaded.');
  } catch {
    console.warn('Districts not loaded. Run: npm run build:districts');
  }
  console.log(`Server listening on port ${PORT}`);
});
