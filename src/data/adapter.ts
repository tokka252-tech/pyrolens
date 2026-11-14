/**
 * PyreSync data adapter layer.
 *
 * Responsibilities:
 *  1. Fetch the three harmonized products (hotspots.geojson, calendar.json,
 *     anomalies.json) from `public/data/`.
 *  2. Normalize heterogeneous upstream fields into canonical domain types.
 *  3. Expose pure, memoizable query helpers used by the UI.
 *
 * To connect a real backend, point the URLs below at the harmonized FIRMS
 * export service — the UI contract (PyreDataset) does not change.
 */

import type {
  AnomalyCell,
  CalendarCell,
  ConfidenceCategory,
  FireDetection,
  MonthClimatology,
  ProductMeta,
  PyreDataset,
  SatelliteId,
} from '../types';

// Relative path: resolves correctly under any deploy base (dev server,
// GitHub Pages project subpath, custom domain).
const DATA_BASE = 'data';
const URLS = {
  hotspots: `${DATA_BASE}/hotspots.geojson`,
  calendar: `${DATA_BASE}/calendar.json`,
  anomalies: `${DATA_BASE}/anomalies.json`,
} as const;

// ---------------------------------------------------------------------------
// Raw wire shapes (what the generator / a real backend emits)
// ---------------------------------------------------------------------------
interface RawGeoJsonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    satellite: string;
    instrument: string;
    satellite_label: string;
    acq_date: string;
    acq_time: string;
    acq_datetime_utc: string;
    latitude: number;
    longitude: number;
    confidence: number | string;
    confidence_category?: string;
    frp: number;
    brightness?: number;
    daynight?: string;
  };
}

interface RawCalendar {
  generated_at: string;
  synthetic: boolean;
  years: number[];
  cells: Record<string, {
    year: number;
    month: number;
    count: number;
    frp_total: number;
    frp_mean: number;
    by_satellite: Partial<Record<string, number>>;
  }>;
}

interface RawAnomalies {
  generated_at: string;
  synthetic: boolean;
  climatology: Record<string, {
    month: number;
    median_count: number;
    mad: number;
    mean_count: number;
    min_count: number;
    max_count: number;
  }>;
  cells: Record<string, {
    count: number;
    median: number;
    mad: number;
    z: number;
    anomaly: 'above' | 'below' | 'normal';
  }>;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

const VALID_SATS = new Set<SatelliteId>(['aqua', 'terra', 'npp', 'noaa20']);

function normalizeSatellite(raw: string): SatelliteId {
  const id = raw.toLowerCase();
  if (VALID_SATS.has(id as SatelliteId)) return id as SatelliteId;
  // Tolerate upstream labels like "MODIS_NRT" / "VIIRS_NOAA20_NRT".
  if (id.includes('noaa20') || id.includes('j1') || id.includes('j2')) return 'noaa20';
  if (id.includes('npp') || id.includes('viirs')) return 'npp';
  if (id.includes('aqua')) return 'aqua';
  return 'terra';
}

/**
 * FIRMS confidence normalization.
 *  - VIIRS delivers 'l' | 'n' | 'h'  -> low | nominal | high
 *  - MODIS delivers 0–100            -> <30 low, 30–79 nominal, >=80 high
 * The generator already emits `confidence_category`; we recompute it here so
 * real upstream files that omit it still normalize correctly.
 */
function normalizeConfidence(
  raw: number | string,
  category: string | undefined,
): ConfidenceCategory {
  if (category === 'low' || category === 'nominal' || category === 'high') {
    return category;
  }
  if (typeof raw === 'string') {
    const v = raw.toLowerCase();
    if (v === 'h' || v === 'high') return 'high';
    if (v === 'n' || v === 'nominal' || v === 'medium') return 'nominal';
    return 'low';
  }
  if (raw >= 80) return 'high';
  if (raw >= 30) return 'nominal';
  return 'low';
}

function normalizeDetection(f: RawGeoJsonFeature): FireDetection {
  const p = f.properties;
  return {
    id: p.id,
    satellite: normalizeSatellite(p.satellite),
    instrument: p.instrument.toUpperCase().startsWith('VIIRS') ? 'VIIRS' : 'MODIS',
    satelliteLabel: p.satellite_label,
    acqDate: p.acq_date,
    acqTime: p.acq_time,
    acqDateTimeUtc: p.acq_datetime_utc,
    latitude: p.latitude,
    longitude: p.longitude,
    confidenceRaw: p.confidence,
    confidenceCategory: normalizeConfidence(p.confidence, p.confidence_category),
    frp: p.frp,
    daynight: p.daynight === 'N' ? 'N' : 'D',
    brightness: p.brightness,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Load and normalize the full PyreSync dataset.
 * Throws if any product fails to load — callers should surface a data-error
 * state rather than rendering partial data.
 */
export async function loadDataset(cacheBust?: string): Promise<PyreDataset> {
  // `?t=` busts CDN/browser cache so the Live button always gets fresh JSON.
  const suffix = cacheBust ? `?t=${encodeURIComponent(cacheBust)}` : '';
  const [hotspots, calendar, anomalies] = await Promise.all([
    fetchJson<{ features: RawGeoJsonFeature[]; metadata?: { disclaimer?: string; synthetic?: boolean; generated_at?: string } }>(`${URLS.hotspots}${suffix}`),
    fetchJson<RawCalendar>(`${URLS.calendar}${suffix}`),
    fetchJson<RawAnomalies>(`${URLS.anomalies}${suffix}`),
  ]);

  const detections = hotspots.features.map(normalizeDetection);

  const calendarMap = new Map<string, CalendarCell>();
  for (const [key, c] of Object.entries(calendar.cells)) {
    calendarMap.set(key, {
      year: c.year,
      month: c.month,
      count: c.count,
      frpTotal: c.frp_total,
      frpMean: c.frp_mean,
      bySatellite: (c.by_satellite ?? {}) as CalendarCell['bySatellite'],
    });
  }

  const climatology = new Map<number, MonthClimatology>();
  for (const c of Object.values(anomalies.climatology)) {
    climatology.set(c.month, {
      month: c.month,
      medianCount: c.median_count,
      mad: c.mad,
      meanCount: c.mean_count,
      minCount: c.min_count,
      maxCount: c.max_count,
    });
  }

  const anomalyMap = new Map<string, AnomalyCell>();
  for (const [key, a] of Object.entries(anomalies.cells)) {
    // Reconstruct year/month from the `${year}-${MM}` key.
    const [y, m] = key.split('-').map(Number);
    anomalyMap.set(key, {
      year: y,
      month: m,
      count: a.count,
      median: a.median,
      mad: a.mad,
      z: a.z,
      anomaly: a.anomaly,
    });
  }

  const meta: ProductMeta = {
    synthetic: Boolean(hotspots.metadata?.synthetic ?? calendar.synthetic),
    generatedAt: hotspots.metadata?.generated_at ?? calendar.generated_at,
    disclaimer: hotspots.metadata?.disclaimer,
  };

  return {
    meta,
    detections,
    calendar: calendarMap,
    anomalies: anomalyMap,
    climatology,
    years: calendar.years,
  };
}

/** Freshness manifest written by scripts/update-live.mjs on each data update. */
export interface DataStatus {
  data_generated_at: string;
  detections: number;
  latest_acq_date: string;
}

/**
 * Poll the tiny status manifest (a few hundred bytes) used by the app's
 * auto-refresh monitor. Returns null when the file doesn't exist yet or the
 * request fails — callers should treat that as "no update information".
 */
export async function loadStatus(cacheBust?: string): Promise<DataStatus | null> {
  try {
    const suffix = cacheBust ? `?t=${encodeURIComponent(cacheBust)}` : '';
    const res = await fetch(`${DATA_BASE}/status.json${suffix}`);
    if (!res.ok) return null;
    return (await res.json()) as DataStatus;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filter model + pure query helper
// ---------------------------------------------------------------------------

export interface PyreFilters {
  /** Inclusive ISO date bounds `YYYY-MM-DD`. Empty string = unbounded. */
  dateFrom: string;
  dateTo: string;
  satellites: Set<SatelliteId>;
  confidences: Set<ConfidenceCategory>;
  frpMin: number | null;
  frpMax: number | null;
}

export const ALL_SATELLITES: SatelliteId[] = ['aqua', 'terra', 'npp', 'noaa20'];
export const ALL_CONFIDENCES: ConfidenceCategory[] = ['low', 'nominal', 'high'];

/**
 * Apply the sidebar filter set to the detection array.
 * Date comparisons are lexicographic on ISO dates, which is chronologically
 * correct and avoids Date parsing overhead per feature.
 */
export function filterDetections(
  detections: FireDetection[],
  f: PyreFilters,
): FireDetection[] {
  return detections.filter((d) => {
    // Checkbox semantics: an empty selection means "nothing selected" -> no
    // detections pass. Callers initialize with the full set.
    if (!f.satellites.has(d.satellite)) return false;
    if (!f.confidences.has(d.confidenceCategory)) return false;
    if (f.dateFrom && d.acqDate < f.dateFrom) return false;
    if (f.dateTo && d.acqDate > f.dateTo) return false;
    if (f.frpMin != null && d.frp < f.frpMin) return false;
    if (f.frpMax != null && d.frp > f.frpMax) return false;
    return true;
  });
}

/** Derive the full available date range from the dataset. */
export function datasetDateRange(detections: FireDetection[]): {
  min: string;
  max: string;
} {
  let min = '9999-12-31';
  let max = '0000-01-01';
  for (const d of detections) {
    if (d.acqDate < min) min = d.acqDate;
    if (d.acqDate > max) max = d.acqDate;
  }
  return { min, max };
}
