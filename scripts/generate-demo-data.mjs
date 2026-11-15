/**
 * PyroLens — Synthetic demo data generator.
 *
 * Produces three harmonized data products under public/data/:
 *   - hotspots.geojson : point features (GeoJSON), one per fire detection
 *   - calendar.json    : monthly per-satellite aggregates (count + FRP)
 *   - anomalies.json   : monthly climatology (median/MAD) + per-cell z-scores
 *
 * The data is SYNTHETIC and intended only to exercise the UI. It mimics the
 * structure of NASA FIRMS MODIS/VIIRS active-fire products so the adapter
 * layer can be swapped for a real harmonized backend without UI changes.
 *
 * Run: node scripts/generate-demo-data.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so generated data is stable across runs.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261114);
const rrange = (a, b) => a + rand() * (b - a);
const rint = (a, b) => Math.floor(rrange(a, b + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---------------------------------------------------------------------------
// Region & instruments
// ---------------------------------------------------------------------------
// Nile Delta bounding region (approx): lat 30.4–31.9, lon 29.9–32.6
const LAT_MIN = 30.35, LAT_MAX = 31.95;
const LON_MIN = 29.9, LON_MAX = 32.65;

const SATELLITES = [
  { id: 'aqua',    label: 'Aqua (MODIS)',      instrument: 'MODIS', confidenceKind: 'numeric', swath: 2330 },
  { id: 'terra',   label: 'Terra (MODIS)',     instrument: 'MODIS', confidenceKind: 'numeric', swath: 2330 },
  { id: 'npp',     label: 'Suomi NPP (VIIRS)', instrument: 'VIIRS', confidenceKind: 'viirs',   swath: 3040 },
  { id: 'noaa20',  label: 'NOAA-20 (VIIRS)',   instrument: 'VIIRS', confidenceKind: 'viirs',   swath: 3040 },
];

const YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

// Fire seasonality: strong peak May–Sep (agricultural burning), low winter.
const SEASON_WEIGHT = [0.35, 0.45, 0.7, 1.0, 1.6, 2.4, 3.0, 2.8, 1.9, 0.9, 0.5, 0.4];

// Agriculture-belt hotspots inside the delta (lat, lon, weight) — fires
// cluster along irrigation canals and field parcels.
const CLUSTERS = [
  { lat: 31.05, lon: 30.45, w: 3.0 }, // central delta / Sharqia
  { lat: 30.95, lon: 31.30, w: 2.4 }, // eastern delta / Dumyat
  { lat: 31.20, lon: 30.00, w: 1.8 }, // western delta / Beheira
  { lat: 30.70, lon: 31.05, w: 1.5 }, // southern delta fringe
  { lat: 31.45, lon: 31.85, w: 1.2 }, // Damietta branch
  { lat: 30.85, lon: 30.10, w: 1.0 }, // Rosetta branch
];

function sampleLocation() {
  if (rand() < 0.75) {
    const c = pick(CLUSTERS);
    const spread = rrange(0.05, 0.35);
    return {
      lat: Math.min(LAT_MAX, Math.max(LAT_MIN, c.lat + rrange(-spread, spread))),
      lon: Math.min(LON_MAX, Math.max(LON_MIN, c.lon + rrange(-spread, spread))),
    };
  }
  return { lat: rrange(LAT_MIN, LAT_MAX), lon: rrange(LON_MIN, LON_MAX) };
}

function sampleDate(year) {
  // Weighted month selection by seasonality.
  const total = SEASON_WEIGHT.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  let month = 1;
  for (let m = 0; m < 12; m++) {
    r -= SEASON_WEIGHT[m];
    if (r <= 0) { month = m + 1; break; }
  }
  const day = rint(1, 28);
  const hour = rint(0, 23);
  const minute = rint(0, 59);
  const acqTime = String(hour * 100 + minute).padStart(4, '0');
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${acqTime.slice(0, 2)}:${acqTime.slice(2)}:00Z`;
  return { month, day, acqTime, iso };
}

function sampleConfidence(sat) {
  if (sat.confidenceKind === 'viirs') {
    const r = rand();
    return r < 0.25 ? 'l' : r < 0.75 ? 'n' : 'h';
  }
  // MODIS numeric 0–100
  const r = rand();
  return r < 0.2 ? rint(0, 29) : r < 0.65 ? rint(30, 79) : rint(80, 100);
}

function confidenceCategory(value, kind) {
  if (kind === 'viirs') {
    if (value === 'h') return 'high';
    if (value === 'n') return 'nominal';
    return 'low';
  }
  if (value >= 80) return 'high';
  if (value >= 30) return 'nominal';
  return 'low';
}

function sampleFrp() {
  // Log-normal-ish FRP distribution in MW.
  const base = Math.exp(rrange(Math.log(0.5), Math.log(80)));
  return Math.round(base * 10) / 10;
}

// ---------------------------------------------------------------------------
// Generate detections (~1600 across 10 years)
// ---------------------------------------------------------------------------
const features = [];
const DETECTIONS = 1600;

for (let i = 0; i < DETECTIONS; i++) {
  const sat = pick(SATELLITES);
  const year = pick(YEARS);
  const { lat, lon } = sampleLocation();
  const { month, day, acqTime, iso } = sampleDate(year);
  const confidence = sampleConfidence(sat);
  const frp = sampleFrp();
  const daynight = rand() < 0.22 ? 'N' : 'D';

  features.push({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))],
    },
    properties: {
      id: `PYR-DEMO-${String(i + 1).padStart(5, '0')}`,
      satellite: sat.id,
      instrument: sat.instrument,
      satellite_label: sat.label,
      acq_date: iso.slice(0, 10),
      acq_time: acqTime,
      acq_datetime_utc: iso,
      latitude: Number(lat.toFixed(5)),
      longitude: Number(lon.toFixed(5)),
      confidence: confidence,
      confidence_category: confidenceCategory(confidence, sat.confidenceKind),
      frp: frp,
      brightness: Math.round(rrange(320, 360) * 10) / 10,
      daynight: daynight,
      scan: rint(0, 1354),
      track: rint(1, 16),
      version: 'demo-1.0',
      source_flag: 'SYNTHETIC DEMO DATA — NOT NASA FIRMS',
    },
  });
}

const hotspotsGeoJson = {
  type: 'FeatureCollection',
  name: 'pyrolens_nile_delta_hotspots',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
  metadata: {
    generated_at: new Date().toISOString(),
    synthetic: true,
    disclaimer: 'SYNTHETIC DEMO DATA, NOT NASA FIRMS. Structure mirrors NASA FIRMS MODIS/VIIRS active-fire products.',
    region: 'Nile Delta, Egypt',
    bounds: { lat: [LAT_MIN, LAT_MAX], lon: [LON_MIN, LON_MAX] },
  },
  features,
};

// ---------------------------------------------------------------------------
// calendar.json — monthly aggregates per satellite
// ---------------------------------------------------------------------------
const calendar = {
  generated_at: new Date().toISOString(),
  synthetic: true,
  years: YEARS,
  months: MONTHS,
  satellites: SATELLITES.map((s) => ({ id: s.id, label: s.label })),
  // cells keyed `${year}-${month}` -> per-satellite aggregates + totals
  cells: {},
};

for (const f of features) {
  const p = f.properties;
  const year = Number(p.acq_date.slice(0, 4));
  const month = Number(p.acq_date.slice(5, 7));
  const key = `${year}-${String(month).padStart(2, '0')}`;
  if (!calendar.cells[key]) {
    calendar.cells[key] = {
      year, month,
      count: 0, frp_total: 0, frp_mean: 0,
      by_satellite: {},
    };
  }
  const cell = calendar.cells[key];
  cell.count += 1;
  cell.frp_total += p.frp;
  cell.by_satellite[p.satellite] = (cell.by_satellite[p.satellite] ?? 0) + 1;
}
for (const cell of Object.values(calendar.cells)) {
  cell.frp_total = Math.round(cell.frp_total * 10) / 10;
  cell.frp_mean = Math.round((cell.frp_total / cell.count) * 10) / 10;
}

// ---------------------------------------------------------------------------
// anomalies.json — monthly climatology (median / MAD) + z-scores per cell
// ---------------------------------------------------------------------------
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mad(arr, med) {
  return median(arr.map((v) => Math.abs(v - med)));
}

// Build monthly time series of fire counts per calendar month (1..12)
const monthlyCounts = {}; // month -> [counts per year]
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
    median_count: Math.round(med * 10) / 10,
    mad: Math.round(mdev * 10) / 10,
    mean_count: Math.round((series.reduce((a, b) => a + b, 0) / series.length) * 10) / 10,
    min_count: Math.min(...series),
    max_count: Math.max(...series),
  };
}

const anomalies = {
  generated_at: new Date().toISOString(),
  synthetic: true,
  method: 'median-MAD robust z-score on monthly fire counts',
  climatology,
  // cells keyed `${year}-${month}` -> { count, z, anomaly }
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
const write = (name, obj) => {
  const path = join(OUT, name);
  writeFileSync(path, JSON.stringify(obj));
  console.log(`wrote ${path}`);
};

write('hotspots.geojson', hotspotsGeoJson);
write('calendar.json', calendar);
write('anomalies.json', anomalies);
console.log(`features: ${features.length}`);
