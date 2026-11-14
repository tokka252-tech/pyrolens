#!/usr/bin/env node
/**
 * PyreSync — live FIRMS updater.
 *
 * Fetches the latest NASA FIRMS near-real-time active-fire detections for the
 * Nile Delta bounding box and merges them into the app's data products:
 *
 *   public/data/hotspots.geojson
 *   public/data/calendar.json
 *   public/data/anomalies.json
 *
 * Usage:
 *   FIRMS_MAP_KEY=<key> node scripts/update-live.mjs [--days N] [--out dir]
 *
 * Designed to run on a schedule (see .github/workflows/firms-live.yml) or
 * locally. Existing detections are deduplicated by
 * (satellite, timestamp, ~100m position) so re-runs are idempotent.
 *
 * NOTE: FIRMS NRT latency is ~1–3 hours and polar-orbiting sensors only
 * overfly a region roughly every 12h per instrument — "live" means latest
 * available orbital pass, not instantaneous detection.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './lib/util.mjs';
import {
  ALL_SATELLITES,
  SAT_INSTRUMENT,
  SAT_LABEL,
  buildAllProducts,
  confidenceCategory,
  featureToDetection,
  satelliteFromString,
} from './lib/products.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'public', 'data');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MAP_KEY = process.env.FIRMS_MAP_KEY;
if (!MAP_KEY) {
  // Graceful skip: scheduled CI runs without the secret configured should not
  // fail the workflow — they simply publish nothing new.
  console.warn('FIRMS_MAP_KEY not set — skipping live update.');
  console.warn('Get a free key at https://firms.modaps.eosdis.nasa.gov/api/');
  process.exit(0);
}

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const DAYS = Number(argValue('--days', '2'));
const OUT = argValue('--out', OUT_DIR);

// Nile Delta bounding box (slightly wider than the analysis region).
const BBOX = '29.4,30.2,32.9,32.2';
// FIRMS area-API sources — matches harmonize.py LIVE_SOURCES exactly.
// NOAA-20/21 are deliberately excluded: adding a second VIIRS platform would
// inflate VIIRS-era counts relative to the 2012+ archive baseline.
const SOURCES = ['MODIS_NRT', 'VIIRS_SNPP_NRT'];

// ---------------------------------------------------------------------------
// FIRMS fetch + parse
// ---------------------------------------------------------------------------
async function fetchFirmsCsv(source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${source}/${BBOX}/${DAYS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FIRMS ${source}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('latitude')) {
    throw new Error(`FIRMS ${source}: unexpected response — ${text.slice(0, 200)}`);
  }
  return parseCsv(text);
}

/** FIRMS CSV row -> canonical detection. Returns null for malformed rows. */
function firmsRowToDetection(row, source) {
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  const frp = Number(row.frp);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const acqDate = row.acq_date; // YYYY-MM-DD
  const t = String(row.acq_time ?? '0000').padStart(4, '0');
  const hh = t.slice(0, 2);
  const mm = t.slice(2, 4);
  const iso = `${acqDate}T${hh}:${mm}:00Z`;

  const satRaw = row.satellite ?? '';
  let satellite = satelliteFromString(satRaw);
  if (!satellite) {
    // e.g. "NPP"/"SNPP"/"NOAA-20" may arrive under `instrument` instead.
    satellite = satelliteFromString(row.instrument ?? '');
  }
  if (!satellite) return null;

  const confRaw = row.confidence ?? '';
  return {
    id: `FIRMS-${source}-${iso}-${lat.toFixed(4)}-${lon.toFixed(4)}`,
    satellite,
    instrument: SAT_INSTRUMENT[satellite],
    satellite_label: SAT_LABEL[satellite],
    acq_date: acqDate,
    acq_time: t,
    acq_datetime_utc: iso,
    latitude: Number(lat.toFixed(5)),
    longitude: Number(lon.toFixed(5)),
    confidence: confRaw,
    confidence_category: confidenceCategory(confRaw),
    frp: Number.isFinite(frp) ? Math.round(frp * 10) / 10 : 0,
    brightness: row.bright_ti4 ? Number(row.bright_ti4) : undefined,
    daynight: String(row.daynight ?? 'D').toUpperCase().startsWith('N') ? 'N' : 'D',
    adjusted_count: 1,
    scan: row.scan ? Number(row.scan) : undefined,
    track: row.track ? Number(row.track) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const dedupeKey = (d) =>
  `${d.satellite}|${d.acq_datetime_utc}|${d.latitude.toFixed(4)}|${d.longitude.toFixed(4)}`;

async function main() {
  console.log(`Fetching FIRMS NRT (last ${DAYS} day(s)) for bbox ${BBOX} …`);

  // 1. Load existing detections from hotspots.geojson (the app's master file).
  const geojsonPath = join(OUT_DIR, 'hotspots.geojson');
  const existing = existsSync(geojsonPath)
    ? JSON.parse(readFileSync(geojsonPath, 'utf8'))
    : { features: [] };
  const detections = new Map();
  for (const f of existing.features ?? []) {
    const d = featureToDetection(f.properties);
    detections.set(dedupeKey(d), d);
  }
  console.log(`Existing detections: ${detections.size}`);

  // 2. Fetch + normalize new FIRMS rows.
  let fetched = 0;
  let added = 0;
  for (const source of SOURCES) {
    const rows = await fetchFirmsCsv(source);
    fetched += rows.length;
    for (const row of rows) {
      const d = firmsRowToDetection(row, source);
      if (!d) continue;
      const key = dedupeKey(d);
      if (!detections.has(key)) {
        detections.set(key, d);
        added++;
      }
    }
    console.log(`  ${source}: ${rows.length} rows`);
  }
  console.log(`FIRMS rows: ${fetched} · new detections added: ${added}`);

  // Nothing new — leave products untouched so scheduled runs don't churn
  // generated_at timestamps and trigger pointless republishes.
  if (added === 0) {
    console.log('No new detections — products unchanged.');
    return;
  }

  // 3. Rebuild all three products.
  const all = [...detections.values()].sort((a, b) =>
    a.acq_datetime_utc.localeCompare(b.acq_datetime_utc),
  );
  const { hotspotsGeoJson, calendar, anomalies } = buildAllProducts(all, {
    source_note: `Includes FIRMS NRT feed (last ${DAYS} days) merged with harmonized archive`,
  });

  mkdirSync(OUT, { recursive: true });
  const write = (name, obj) => {
    writeFileSync(join(OUT, name), JSON.stringify(obj));
    console.log(`wrote ${join(OUT, name)}`);
  };
  write('hotspots.geojson', hotspotsGeoJson);
  write('calendar.json', calendar);
  write('anomalies.json', anomalies);
  console.log(`Total detections: ${all.length}`);
}

main().catch((err) => {
  console.error('Live update failed:', err.message ?? err);
  process.exit(1);
});
