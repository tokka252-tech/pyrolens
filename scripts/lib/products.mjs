/**
 * Shared product builders for the PyreSync data pipeline.
 *
 * Canonical detection shape (produced by import-harmonized.mjs and
 * update-live.mjs):
 *   { id, satellite, instrument, satellite_label, acq_date, acq_time,
 *     acq_datetime_utc, latitude, longitude, confidence, confidence_category,
 *     frp, brightness?, daynight, adjusted_count }
 *
 * buildAllProducts() turns a detection array into the three JSON products
 * consumed by the web app's adapter layer.
 */

import { mad, median, round } from './util.mjs';

export const SAT_INSTRUMENT = {
  aqua: 'MODIS', terra: 'MODIS', npp: 'VIIRS', noaa20: 'VIIRS',
};
export const SAT_LABEL = {
  aqua: 'Aqua (MODIS)', terra: 'Terra (MODIS)',
  npp: 'Suomi NPP (VIIRS)', noaa20: 'NOAA-20 (VIIRS)',
};
export const ALL_SATELLITES = ['aqua', 'terra', 'npp', 'noaa20'];

/**
 * Map a free-form source/instrument string to a canonical satellite ID.
 * Returns null when the source is instrument-level only ('MODIS'/'VIIRS').
 */
export function satelliteFromString(s) {
  const v = String(s ?? '').toLowerCase();
  if (v.includes('aqua')) return 'aqua';
  if (v.includes('terra')) return 'terra';
  if (v.includes('npp') || v.includes('suomi') || v.includes('snpp')) return 'npp';
  if (v.includes('noaa-20') || v.includes('noaa20') || v.includes('j2') || v.includes('noaa_j2')) return 'noaa20';
  if (v.includes('noaa') || v.includes('j1')) return 'npp';
  return null;
}

/** Normalize any confidence representation to low | nominal | high. */
export function confidenceCategory(rawConf) {
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

const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// Product 1: hotspots.geojson
// ---------------------------------------------------------------------------
export function buildHotspotsGeoJson(detections, meta = {}) {
  const lats = detections.map((d) => d.latitude);
  const lons = detections.map((d) => d.longitude);
  return {
    type: 'FeatureCollection',
    name: 'pyresync_harmonized_hotspots',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    metadata: {
      generated_at: new Date().toISOString(),
      synthetic: false,
      region: 'Nile Delta, Egypt',
      bounds: {
        lat: [Math.min(...lats), Math.max(...lats)],
        lon: [Math.min(...lons), Math.max(...lons)],
      },
      ...meta,
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
        brightness: d.brightness,
        daynight: d.daynight,
        adjusted_count: d.adjusted_count ?? 1,
        source_flag: 'HARMONIZED PROJECT DATA',
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Product 2: calendar.json (adjusted_count-weighted monthly aggregates)
// ---------------------------------------------------------------------------
export function buildCalendar(detections) {
  const years = [...new Set(detections.map((d) => Number(d.acq_date.slice(0, 4))))].sort();
  const calendar = {
    generated_at: new Date().toISOString(),
    synthetic: false,
    years,
    months: Array.from({ length: 12 }, (_, i) => i + 1),
    satellites: ALL_SATELLITES.map((id) => ({ id, label: SAT_LABEL[id] })),
    cells: {},
  };

  for (const d of detections) {
    const year = Number(d.acq_date.slice(0, 4));
    const month = Number(d.acq_date.slice(5, 7));
    const key = monthKey(year, month);
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
    cell.count = round(cell.count);
    cell.frp_total = round(cell.frp_total, 1);
    cell.frp_mean = round(cell.frp_total / cell.count, 1);
    for (const k of Object.keys(cell.by_satellite)) {
      cell.by_satellite[k] = round(cell.by_satellite[k]);
    }
  }
  return calendar;
}

// ---------------------------------------------------------------------------
// Product 3: anomalies.json (median / MAD robust z-scores)
// ---------------------------------------------------------------------------
export function buildAnomalies(calendar) {
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
      median_count: round(med),
      mad: round(mdev),
      mean_count: round(series.reduce((a, b) => a + b, 0) / series.length),
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
    anomalies.cells[monthKey(cell.year, cell.month)] = {
      count: cell.count,
      median: c.median_count,
      mad: c.mad,
      z: round(z),
      anomaly: z > 0 ? 'above' : z < 0 ? 'below' : 'normal',
    };
  }
  return anomalies;
}

/** Build all three products from a detection array. */
export function buildAllProducts(detections, meta = {}) {
  const calendar = buildCalendar(detections);
  return {
    hotspotsGeoJson: buildHotspotsGeoJson(detections, meta),
    calendar,
    anomalies: buildAnomalies(calendar),
  };
}

/**
 * Convert a GeoJSON feature's properties back into the canonical detection
 * shape (used by the live updater to reload existing hotspots).
 */
export function featureToDetection(props) {
  return {
    id: props.id,
    satellite: props.satellite,
    instrument: props.instrument,
    satellite_label: props.satellite_label,
    acq_date: props.acq_date,
    acq_time: props.acq_time,
    acq_datetime_utc: props.acq_datetime_utc,
    latitude: props.latitude,
    longitude: props.longitude,
    confidence: props.confidence,
    confidence_category: props.confidence_category,
    frp: props.frp,
    brightness: props.brightness,
    daynight: props.daynight,
    adjusted_count: props.adjusted_count ?? 1,
  };
}
