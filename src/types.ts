/**
 * PyroLens domain types.
 *
 * The adapter layer normalizes heterogeneous upstream products (NASA FIRMS
 * MODIS CSV / VIIRS CSV / GeoJSON) into these canonical structures so the UI
 * never depends on a specific wire format.
 */

/** Supported satellite/instrument sources. */
export type SatelliteId = 'aqua' | 'terra' | 'npp' | 'noaa20';

/** Categorical confidence used for strict filtering. */
export type ConfidenceCategory = 'low' | 'nominal' | 'high';

/** A single normalized active-fire detection. */
export interface FireDetection {
  id: string;
  satellite: SatelliteId;
  instrument: 'MODIS' | 'VIIRS';
  satelliteLabel: string;
  /** Acquisition date, ISO `YYYY-MM-DD` (UTC). */
  acqDate: string;
  /** Acquisition time, `HHMM` UTC string as delivered by FIRMS. */
  acqTime: string;
  /** Full UTC timestamp, ISO-8601. */
  acqDateTimeUtc: string;
  latitude: number;
  longitude: number;
  /** Raw confidence value as delivered upstream (number for MODIS, 'l'|'n'|'h' for VIIRS). */
  confidenceRaw: number | string;
  confidenceCategory: ConfidenceCategory;
  /** Fire Radiative Power in megawatts (MW). */
  frp: number;
  daynight: 'D' | 'N';
  brightness?: number;
}

/** Monthly aggregate for one satellite in the calendar product. */
export interface CalendarCell {
  year: number;
  month: number;
  count: number;
  frpTotal: number;
  frpMean: number;
  bySatellite: Partial<Record<SatelliteId, number>>;
}

/** Robust climatology statistics for a calendar month. */
export interface MonthClimatology {
  month: number;
  medianCount: number;
  mad: number;
  meanCount: number;
  minCount: number;
  maxCount: number;
}

/** Anomaly statistics for a specific year-month cell. */
export interface AnomalyCell {
  year: number;
  month: number;
  count: number;
  median: number;
  mad: number;
  /** Robust z-score: (count - median) / (1.4826 * MAD). */
  z: number;
  anomaly: 'above' | 'below' | 'normal';
}

/** Product metadata carried by every upstream file. */
export interface ProductMeta {
  synthetic: boolean;
  generatedAt: string;
  disclaimer?: string;
}

/** Canonical dataset returned by the adapter. */
export interface PyreDataset {
  meta: ProductMeta;
  detections: FireDetection[];
  /** Lookup key: `${year}-${MM}` -> aggregate cell. */
  calendar: Map<string, CalendarCell>;
  /** Lookup key: `${year}-${MM}` -> anomaly stats. */
  anomalies: Map<string, AnomalyCell>;
  climatology: Map<number, MonthClimatology>;
  years: number[];
}
