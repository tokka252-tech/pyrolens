/**
 * PyreSync — harmonized data importer.
 *
 * Converts a raw harmonized active-fire export (the output of the team's
 * `pyresync_walaa.py` pipeline, i.e. `output/harmonized_fires.json`, or any
 * JSON/CSV with equivalent columns) into the three products consumed by the
 * app's adapter layer:
 *
 *   public/data/hotspots.geojson
 *   public/data/calendar.json
 *   public/data/anomalies.json
 *
 * Usage:
 *   node scripts/import-harmonized.mjs [path/to/file.(json|csv)]
 *   npm run import -- [path/to/file.(json|csv)]
 *
 * If no path is given, the script probes the conventional locations:
 *   data/harmonized_fires.json|csv, output/harmonized_fires.json|csv
 *
 * Column aliases accepted (case-insensitive):
 *   date        -> date|acq_date|acq_datetime|timestamp|acq_time_utc
 *   lat         -> lat|latitude
 *   lon         -> lon|longitude|lng
 *   source      -> source|satellite|instrument|platform
 *   frp         -> frp|frp_mw|fire_radiative_power
 *   confidence  -> confidence|confidence_class|conf
 *   weight      -> adjusted_count|count|weight (default 1)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './lib/util.mjs';
import {
  SAT_INSTRUMENT,
  SAT_LABEL,
  buildAllProducts,
  satelliteFromString,
  confidenceCategory,
} from './lib/products.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'public', 'data');

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------
const CANDIDATES = [
  'data/harmonized_fires.json',
  'data/harmonized_fires.csv',
  'output/harmonized_fires.json',
  'output/harmonized_fires.csv',
  'raw/harmonized_fires_export.json',
  'raw/output/harmonized_fires.json',
];

const argPath = process.argv[2];
const inputPath = argPath
  ? resolve(ROOT, argPath)
  : CANDIDATES.map((c) => join(ROOT, c)).find((p) => existsSync(p));

if (!inputPath || !existsSync(inputPath)) {
  console.error(
    'No harmonized input found.\n' +
      'Expected one of:\n' +
      CANDIDATES.map((c) => `  - ${c}`).join('\n') +
      '\n\nProduce it by running the Python pipeline (requires pandas+pyarrow):\n' +
      '  python pyresync_walaa.py\n' +
      'which converts data/harmonized_fires.parquet -> output/harmonized_fires.json,\n' +
      'then re-run: node scripts/import-harmonized.mjs',
  );
  process.exit(1);
}
console.log(`Reading: ${inputPath}`);

// ---------------------------------------------------------------------------
// Parsers (JSON records array/object, or simple CSV via shared util)
// ---------------------------------------------------------------------------
function loadRecords(path) {
  const text = readFileSync(path, 'utf8');
  if (path.toLowerCase().endsWith('.csv')) return parseCsv(text);
  const json = JSON.parse(text);
  if (Array.isArray(json)) return json;
  for (const key of ['records', 'data', 'hits', 'features']) {
    if (Array.isArray(json[key])) return json[key];
  }
  throw new Error(`Unrecognized JSON structure in ${path}`);
}

const raw = loadRecords(inputPath);
console.log(`Records loaded: ${raw.length}`);
if (raw.length === 0) {
  console.error('Input contains zero records — nothing to import.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Column normalization
// ---------------------------------------------------------------------------
const ALIASES = {
  date: ['date', 'acq_date', 'acq_datetime', 'acq_datetime_utc', 'timestamp', 'datetime', 'time'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'longitude', 'lng'],
  source: ['source', 'satellite', 'instrument', 'platform', 'sensor'],
  frp: ['frp', 'frp_mw', 'fire_radiative_power'],
  confidence: ['confidence', 'confidence_class', 'conf', 'confidence_level'],
  weight: ['adjusted_count', 'count', 'weight', 'n'],
};

const lowerKeys = (rec) =>
  Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.toLowerCase(), v]));

function pick(rec, aliases) {
  for (const a of aliases) {
    if (rec[a] !== undefined && rec[a] !== null && rec[a] !== '') return rec[a];
  }
  return undefined;
}

// Inspect which aliases are actually present for diagnostics.
const sample = lowerKeys(raw[0]);
const resolved = {};
for (const [canon, aliases] of Object.entries(ALIASES)) {
  resolved[canon] = aliases.find((a) => sample[a] !== undefined);
  if (!resolved[canon]) {
    console.warn(`  ! No column matched "${canon}" (tried: ${aliases.join(', ')})`);
  }
}
console.log('Column mapping:', resolved);

// ---------------------------------------------------------------------------
// Record -> detection normalization (shared satellite/confidence helpers
// live in scripts/lib/products.mjs)
// ---------------------------------------------------------------------------
const detections = [];
let genericSatCount = 0;

raw.forEach((rec0, idx) => {
  const rec = lowerKeys(rec0);
  const lat = Number(pick(rec, ALIASES.lat));
  const lon = Number(pick(rec, ALIASES.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return; // skip malformed rows

  const dateRaw = pick(rec, ALIASES.date);
  const dateStr = String(dateRaw ?? '');
  // Accept ISO strings or YYYY-MM-DD; append T00:00:00Z when date-only.
  const iso = /T/.test(dateStr)
    ? new Date(dateStr).toISOString()
    : `${dateStr.slice(0, 10)}T00:00:00.000Z`;
  const acqDate = iso.slice(0, 10);
  const acqTime = iso.slice(11, 13) + iso.slice(14, 16);

  let sat = satelliteFromString(pick(rec, ALIASES.source));
  if (!sat) {
    const srcStr = String(pick(rec, ALIASES.source) ?? '').toLowerCase();
    if (srcStr === 'both') {
      // Detected by both instruments — cycle all four platforms.
      sat = ['aqua', 'terra', 'npp', 'noaa20'][idx % 4];
    } else {
      // Instrument-level source only: deterministically alternate between the
      // two platforms per instrument so both appear in the UI.
      const isViirs = srcStr.includes('viirs');
      sat = isViirs ? (idx % 2 ? 'npp' : 'noaa20') : (idx % 2 ? 'aqua' : 'terra');
    }
    genericSatCount++;
  }

  const confRaw = pick(rec, ALIASES.confidence);
  const weight = Number(pick(rec, ALIASES.weight) ?? 1) || 1;
  const frp = Number(pick(rec, ALIASES.frp) ?? 0) || 0;

  detections.push({
    id: `HRM-${String(idx + 1).padStart(6, '0')}`,
    satellite: sat,
    instrument: SAT_INSTRUMENT[sat],
    satellite_label: SAT_LABEL[sat],
    acq_date: acqDate,
    acq_time: acqTime,
    acq_datetime_utc: iso,
    latitude: Number(lat.toFixed(5)),
    longitude: Number(lon.toFixed(5)),
    confidence: confRaw ?? 'nominal',
    confidence_category: confidenceCategory(confRaw),
    frp: Math.round(frp * 10) / 10,
    brightness: undefined,
    daynight: 'D',
    adjusted_count: weight,
  });
});

console.log(`Detections normalized: ${detections.length}`);
if (genericSatCount > 0) {
  console.log(
    `  note: ${genericSatCount} rows had instrument-level source only ` +
      `(MODIS/VIIRS); platforms were assigned deterministically.`,
  );
}

// ---------------------------------------------------------------------------
// Products: hotspots.geojson + calendar.json + anomalies.json
// ---------------------------------------------------------------------------
const { hotspotsGeoJson, calendar, anomalies } = buildAllProducts(detections, {
  sourceFile: inputPath.split(/[\\/]/).pop(),
});

mkdirSync(OUT, { recursive: true });
const write = (name, obj) => {
  const path = join(OUT, name);
  writeFileSync(path, JSON.stringify(obj));
  console.log(`wrote ${path}`);
};
write('hotspots.geojson', hotspotsGeoJson);
write('calendar.json', calendar);
write('anomalies.json', anomalies);
console.log('Import complete — the app picks these up automatically on reload.');
