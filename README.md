# PyreSync

Scientific web platform for visualizing and analyzing active-fire detections
from NASA FIRMS (MODIS on Aqua/Terra, VIIRS on Suomi NPP / NOAA-20) over the
Nile Delta, Egypt.

## Stack

Vanilla TypeScript + Vite — no UI framework. HTML shell + Tailwind CSS v4 +
Leaflet for maps (canvas renderer for ~57k markers). JSON files under
`public/data/` are the only data payloads; `src/data/adapter.ts` normalizes
them into typed domain objects.

## Layout

```
src/
  data/adapter.ts      Data adapter: fetch, normalize, filter
  ui/
    mapView.ts         Leaflet map: FRP-scaled canvas markers, popups, basemaps
    sidebar.ts         Filter panel DOM + PyreFilters state
    heatmap.ts         Monthly × yearly anomaly heatmap (median/MAD z-scores)
    palette.ts         Shared satellite/confidence color tokens
  types.ts             Canonical domain types
  app.ts               State orchestration / cross-component wiring
  main.ts              Entry point
public/data/           The only web-served data: hotspots.geojson, calendar.json,
                       anomalies.json (generated — see below)
raw/                   Pipeline inputs & intermediates (NOT served):
  *.parquet            Raw harmonized FIRMS exports
  *.py                 Team analysis scripts
  .venv/               Python env (pandas + pyarrow) for the pipeline
  output/              Pipeline outputs (monthly stats, merged parquet)
  harmonized_fires_export.json   Parquet → JSON export consumed by the importer
scripts/
  generate-demo-data.mjs    Synthetic demo data generator (regenerates the 3 products)
  import-harmonized.mjs     Import harmonized JSON/CSV → the 3 adapter products
```

## Data pipeline

1. **Team pipeline (Python)** — `raw/*.py` merges `*.parquet` files, dedupes,
   weights by `adjusted_count`, and emits monthly statistics into `raw/output/`.
   Requires the venv: `raw\.venv\Scripts\python.exe` (pandas + pyarrow installed).
2. **Export** — parquet → JSON records:
   `python -c "import pandas as pd, json; df = pd.read_parquet('raw/output/harmonized_fires_merged.parquet'); ..."`
   (see `raw/harmonized_fires_export.json` for the expected shape)
3. **Import** — `npm run import` reads `raw/harmonized_fires_export.json`
   (or any JSON/CSV via `node scripts/import-harmonized.mjs <file>`) and writes
   the three products into `public/data/`.

### Schema notes

The harmonized export columns: `date, lat, lon, cell_id, source, frp,
confidence_class, adjusted_count, n_detections, n_modis, n_viirs`.
`source` is instrument-level (`MODIS` / `VIIRS` / `BOTH`), so satellite
platforms are assigned deterministically (Aqua/Terra, NPP/NOAA-20). Include a
`satellite` column (`aqua|terra|npp|noaa20`) in future exports for exact
attribution. `confidence_class` is `low|nominal|high`; `adjusted_count`
weights the calendar/anomaly aggregates.

`npm run data:demo` regenerates synthetic demo data if the real pipeline
output is unavailable.

## Scripts

- `npm run dev` — dev server (http://localhost:5173)
- `npm run build` — typecheck + production build
- `npm run preview` — serve the production build
- `npm run import` — re-run the harmonized-data importer
- `npm run data:demo` — regenerate synthetic demo products
