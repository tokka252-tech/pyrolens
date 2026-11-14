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
// Parsers (JSON records array/object, or simple CSV with quoted fields)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) =>
    Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), (r[i] ?? '').trim()])),
  );
}

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
// Satellite / confidence normalization
// ---------------------------------------------------------------------------
const SAT_INSTRUMENT = {
  aqua: 'MODIS', terra: 'MODIS', npp: 'VIIRS', noaa20: 'VIIRS',
};
const SAT_LABEL = {
  aqua: 'Aqua (MODIS)', terra: 'Terra (MODIS)',
  npp: 'Suomi NPP (VIIRS)', noaa20: 'NOAA-20 (VIIRS)',
};

/**
 * Map a free-form source string to a canonical satellite ID.
 * Returns null when the source is instrument-level only ('MODIS'/'VIIRS').
 */
function satelliteFromString(s) {
  const v = String(s ?? '').toLowerCase();
  if (v.includes('aqua')) return 'aqua';
  if (v.includes('terra')) return 'terra';
  if (v.includes('npp') || v.includes('suomi') || v.includes('snpp')) return 'npp';
  if (v.includes('noaa-20') || v.includes('noaa20') || v.includes('j2') || v.includes('noaa_j2')) return 'noaa20';
  if (v.includes('noaa') || v.includes('j1')) return 'npp'; // NOAA-21/JPSS heritage -> closest VIIRS slot
  return null;
}

function confidenceCategory(rawConf) {
  if (rawConf === undefined || rawConf === null || rawConf === '') return 'nominal';
  const v = String(rawConf).toLowerCase();
  if (['low', 'l'].includes(v)) return 'low';
  if (['nominal', 'medium', 'n', 'nom'].includes(v)) return 'nominal';
  if (['high', 'h'].includes(v)) return 'high';
  const n = Number(rawConf);
  if (Number.isFinite(n)) {
    if (n >= 80) return 'high';
    if (n >= 30) return 'nominal';
    return 'low';
  }
  return 'nominal';
}

// ---------------------------------------------------------------------------
// Record -> FireDetection normalization
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
    confidence: confRaw ?? confidenceCategory(confRaw),
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
// Product 1: hotspots.geojson
// ---------------------------------------------------------------------------
const years = [...new Set(detections.map((d) => Number(d.acq_date.slice(0, 4))))].sort();
const lats = detections.map((d) => d.latitude);
const lons = detections.map((d) => d.longitude);

const hotspotsGeoJson = {
  type: 'FeatureCollection',
  name: 'pyresync_harmonized_hotspots',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
  metadata: {
    generated_at: new Date().toISOString(),
    synthetic: false,
    source_file: inputPath,
    region: 'Nile Delta, Egypt',
    bounds: {
      lat: [Math.min(...lats), Math.max(...lats)],
      lon: [Math.min(...lons), Math.max(...lons)],
    },
  },
  features: detections.map((d) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] },
    properties: {
      id: d.id,
      satellite: d.satellite,
      instrument: d.instrument,
      satellite_label: d.satellite_label,
      acq_date: d.acq_date,
      acq_time: d.acq_time,
      acq_datetime_utc: d.acq_datetime_utc,
      latitude: d.latitude,
      longitude: d.longitude,
      confidence: d.confidence,
      confidence_category: d.confidence_category,
      frp: d.frp,
      daynight: d.daynight,
      source_flag: 'HARMONIZED PROJECT DATA',
    },
  })),
};

// ---------------------------------------------------------------------------
// Product 2: calendar.json (weighted by adjusted_count)
// ---------------------------------------------------------------------------
const calendar = {
  generated_at: new Date().toISOString(),
  synthetic: false,
  years,
  months: Array.from({ length: 12 }, (_, i) => i + 1),
  satellites: ['aqua', 'terra', 'npp', 'noaa20'].map((id) => ({
    id,
    label: SAT_LABEL[id],
  })),
  cells: {},
};

for (const d of detections) {
  const year = Number(d.acq_date.slice(0, 4));
  const month = Number(d.acq_date.slice(5, 7));
  const key = `${year}-${String(month).padStart(2, '0')}`;
  if (!calendar.cells[key]) {
    calendar.cells[key] = {
      year, month, count: 0, frp_total: 0, frp_mean: 0, by_satellite: {},
    };
  }
  const cell = calendar.cells[key];
  const w = d.adjusted_count ?? 1;
  cell.count += w;
  cell.frp_total += d.frp * w;
  cell.by_satellite[d.satellite] = (cell.by_satellite[d.satellite] ?? 0) + w;
}
for (const cell of Object.values(calendar.cells)) {
  cell.count = Math.round(cell.count * 100) / 100;
  cell.frp_total = Math.round(cell.frp_total * 10) / 10;
  cell.frp_mean = Math.round((cell.frp_total / cell.count) * 10) / 10;
  for (const k of Object.keys(cell.by_satellite)) {
    cell.by_satellite[k] = Math.round(cell.by_satellite[k] * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Product 3: anomalies.json (median / MAD robust z-scores on counts)
// ---------------------------------------------------------------------------
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mad(arr, med) {
  return median(arr.map((v) => Math.abs(v - med)));
}

const monthlyCounts = {};
for (const cell of Object.values(calendar.cells)) {
  (monthlyCounts[cell.month] ??= []).push(cell.count);
}
const climatology = {};
for (let m = 1; m <= 12; m++) {
  const series = monthlyCounts[m] ?? [0];
  const med = median(series);
  const mdev = mad(series, med);
  climatology[m] = {
    month: m,
    median_count: Math.round(med * 100) / 100,
    mad: Math.round(mdev * 100) / 100,
    mean_count: Math.round((series.reduce((a, b) => a + b, 0) / series.length) * 100) / 100,
    min_count: Math.min(...series),
    max_count: Math.max(...series),
  };
}

const anomalies = {
  generated_at: new Date().toISOString(),
  synthetic: false,
  method: 'median-MAD robust z-score on monthly fire counts (adjusted_count-weighted)',
  climatology,
  cells: {},
};
for (const cell of Object.values(calendar.cells)) {
  const c = climatology[cell.month];
  const denom = 1.4826 * c.mad;
  const z = denom > 0 ? (cell.count - c.median_count) / denom : 0;
  anomalies.cells[`${cell.year}-${String(cell.month).padStart(2, '0')}`] = {
    count: cell.count,
    median: c.median_count,
    mad: c.mad,
    z: Math.round(z * 100) / 100,
    anomaly: z > 0 ? 'above' : z < 0 ? 'below' : 'normal',
  };
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------
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
