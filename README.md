# Rhode Island School Map

Interactive web map showing Rhode Island school district boundaries and every public and private school.

## Data Sources

| Dataset | Source | Description |
|--------|--------|-------------|
| **District boundaries** | [US Census TIGER/Line](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) UNSD + ELSD + SCSD | Merged unified, elementary, and secondary school district polygons (see [District merge](#district-boundaries-unsd--elsd--scsd) below) |
| **Public schools** | [NCES EDGE Geocode](https://nces.ed.gov/programs/edge/Geographic/SchoolLocations) (derived from [CCD](https://nces.ed.gov/ccd/)) | Common Core of Data (CCD) provides annual administrative data on public schools; EDGE adds latitude/longitude geocodes |
| **Private schools** | [NCES Private School Universe Survey (PSS)](https://nces.ed.gov/surveys/pss/pssdata.asp) | Biennial survey of private elementary and secondary schools with addresses and coordinates |

### District boundaries: UNSD + ELSD + SCSD

Census TIGER provides three school district layers for Rhode Island:

- **UNSD** (Unified School Districts): Districts that operate all grade levels (K–12).
- **ELSD** (Elementary School Districts): Districts that operate elementary grades only.
- **SCSD** (Secondary School Districts): Districts that operate secondary grades only.

**Why merge all three?** UNSD alone omits several RI districts that operate as separate elementary/secondary systems—e.g., Exeter-West Greenwich, Foster-Glocester, Little Compton. By merging UNSD + ELSD + SCSD, all relevant boundaries appear on the map.

The build script (`npm run build:districts`) reads shapefiles from these folders at repo root:

- `Rhode Island United School Districts/` (tl_2025_44_unsd.shp)
- `Rhode Island Elementary School Districts/` (tl_2025_44_elsd.shp)
- `Rhode Island Secondary School Districts/` (tl_2025_44_scsd.shp)

Deduplication: when the same GEOID appears in multiple layers, we keep one (unified > secondary > elementary). Districts with different GEOIDs (e.g., overlapping elementary vs secondary) are kept as separate features.

### CCD vs PSS

- **CCD (Common Core of Data)**: Annual collection of public school data (enrollment, staffing, addresses). The EDGE program geocodes these to lat/long.
- **PSS (Private School Universe Survey)**: Biennial survey of private schools. Provides similar fields plus latitude/longitude in the CSV.

## Tech Stack

- **Frontend**: React + Vite + TypeScript, MapLibre GL JS (no Mapbox token)
- **Backend**: Node + Express
- **Data processing**: Node scripts with shpjs, csv-parse, turf.js, adm-zip

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Build data

**Districts** (merge UNSD + ELSD + SCSD):

Place Census TIGER shapefiles in these folders at repo root (same level as `backend/`, `frontend/`):

- `Rhode Island United School Districts/` (tl_2025_44_unsd.shp + .dbf, .shx, .prj)
- `Rhode Island Elementary School Districts/` (tl_2025_44_elsd.shp + .dbf, .shx, .prj)
- `Rhode Island Secondary School Districts/` (tl_2025_44_scsd.shp + .dbf, .shx, .prj)

Then run:

```bash
npm run build:districts
```

This produces `data/districts.geojson`.

**Schools** (public + private):

```bash
npm run build:data
```

This downloads (or reads from `data/raw/`) and produces `data/schools.geojson`. If automated download fails, create `data/raw/` and place the required ZIPs; see the script for URLs.

### 3. Run development

```bash
npm run dev
```

- Frontend: http://localhost:5173  
- Backend: http://localhost:3001  

Sample data is included so the app runs without running `build:data` first; run `build:data` for full RI data.

## Basemap

Uses [OpenStreetMap](https://www.openstreetmap.org/) tiles via `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. No API key required. If OSM tiles become unavailable, switch to another free raster source in `frontend/src/components/Map.tsx`.

## Deployment

1. Run `npm run build:districts` and `npm run build:data` to generate GeoJSON.
2. Build frontend: `npm run build`
3. Serve the backend (which can also serve the built frontend from `frontend/dist`) or use a separate static host.
4. Set `BACKEND_PORT` and `FRONTEND_PORT` via environment (see `.env.example`).

## Known Limitations

- Grade bucket derivation: If grade span is missing, schools default to "Other".
- NCES downloads may require manual placement if behind a firewall.
- District boundaries are from Census/EDGE; boundaries may not exactly match local LEA definitions.
- Private school data lags public (PSS is biennial).

## Project Structure

```
repo/
  frontend/       React + Vite + MapLibre
  backend/        Express API
  data/
    raw/          Raw downloads (place here if manual)
    districts.geojson
    schools.geojson
  scripts/
    build-districts.ts  Merge UNSD+ELSD+SCSD → districts.geojson
    build-data.ts       Schools pipeline
  README.md
```
