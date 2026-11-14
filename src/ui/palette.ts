/**
 * Shared scientific color palette.
 * Single source of truth for satellite-source and confidence colors used by
 * the map markers, sidebar swatches, and heatmap legend.
 */

import type { ConfidenceCategory, SatelliteId } from '../types';

export const SATELLITE_COLORS: Record<SatelliteId, string> = {
  aqua: '#38bdf8', // Aqua / MODIS — cyan
  terra: '#4ade80', // Terra / MODIS — green
  npp: '#fbbf24', // Suomi NPP / VIIRS — amber
  noaa20: '#fb923c', // NOAA-20 / VIIRS — orange
};

export const SATELLITE_LABELS: Record<SatelliteId, string> = {
  aqua: 'Aqua (MODIS)',
  terra: 'Terra (MODIS)',
  npp: 'Suomi NPP (VIIRS)',
  noaa20: 'NOAA-20 (VIIRS)',
};

export const CONFIDENCE_COLORS: Record<ConfidenceCategory, string> = {
  low: '#94a3b8',
  nominal: '#fbbf24',
  high: '#f87171',
};

export const CONFIDENCE_LABELS: Record<ConfidenceCategory, string> = {
  low: 'Low',
  nominal: 'Nominal (Medium)',
  high: 'High',
};
