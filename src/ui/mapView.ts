/**
 * Leaflet map module (vanilla).
 *
 * Renders active-fire detections as FRP-scaled circle markers, color-coded
 * by satellite source. Basemap toggles between a dark scientific canvas
 * (Esri Canvas World Dark Gray — CARTO now requires an API key) and
 * high-resolution satellite imagery (Esri World Imagery). Each mode keeps a
 * keyless fallback provider on a different host. All DOM/marker state is
 * owned by this module — callers only push filtered detection arrays.
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { FireDetection } from '../types';
import { SATELLITE_COLORS } from './palette';

export type BasemapMode = 'dark' | 'satellite';

const ESRI_ATTR =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** Transparent 1×1 PNG shown for failed tiles instead of broken-image icons. */
const ERROR_TILE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const tile = (url: string, opts: L.TileLayerOptions = {}): L.TileLayer =>
  L.tileLayer(url, { errorTileUrl: ERROR_TILE_URL, ...opts });

/** Nile Delta region of interest. */
const REGION_BOUNDS: L.LatLngBoundsExpression = [
  [30.2, 29.6],
  [32.1, 32.9],
];

const CONFIDENCE_POPUP_LABEL: Record<string, string> = {
  low: 'Low',
  nominal: 'Nominal (Medium)',
  high: 'High',
};

/** FRP-scaled radius: sub-linear so extreme FRP values don't dominate. */
function frpRadius(frp: number): number {
  return Math.min(4 + Math.sqrt(Math.max(frp, 0)) * 0.9, 18);
}

function confidenceStyle(cat: string): string {
  switch (cat) {
    case 'high':
      return 'color:#f87171;font-weight:600';
    case 'nominal':
      return 'color:#fbbf24;font-weight:600';
    default:
      return 'color:#94a3b8';
  }
}

function buildPopupHtml(d: FireDetection): string {
  const confLabel = CONFIDENCE_POPUP_LABEL[d.confidenceCategory] ?? d.confidenceCategory;
  const confRaw =
    typeof d.confidenceRaw === 'string'
      ? d.confidenceRaw.toUpperCase()
      : `${d.confidenceRaw}`;
  return `
    <div style="min-width:210px">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#f59e0b">
        ${d.satelliteLabel}
      </div>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Date (UTC)</td><td>${d.acqDate}</td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Time (UTC)</td><td>${d.acqTime.slice(0, 2)}:${d.acqTime.slice(2)}</td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Latitude</td><td>${d.latitude.toFixed(5)}&deg;</td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Longitude</td><td>${d.longitude.toFixed(5)}&deg;</td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Satellite</td><td>${d.instrument}</td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Confidence</td>
            <td style="${confidenceStyle(d.confidenceCategory)}">${confLabel} <span style="color:#64748b;font-weight:400">(${confRaw})</span></td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">FRP</td><td style="font-weight:600">${d.frp.toFixed(1)} MW</td></tr>
        <tr><td style="color:#64748b;padding:1px 8px 1px 0">Day/Night</td><td>${d.daynight === 'N' ? 'Night' : 'Day'}</td></tr>
      </table>
      <div style="margin-top:6px;font-size:10px;color:#475569;border-top:1px solid #1e293b;padding-top:5px">
        ${d.id}
      </div>
    </div>`;
}

export interface MapHandle {
  setBasemap(mode: BasemapMode): void;
  setDetections(detections: FireDetection[]): void;
  destroy(): void;
}

interface ModeLayers {
  /** What gets added to the map — a TileLayer or LayerGroup. */
  primary: L.Layer;
  fallback: L.Layer;
  /** TileLayer instances inside each variant, for health monitoring. */
  primaryTiles: L.TileLayer[];
  fallbackTiles: L.TileLayer[];
  fallbackNote: string;
}

export function initMap(
  container: HTMLElement,
  onBasemapFallback?: (mode: BasemapMode, note: string) => void,
): MapHandle {
  const map = L.map(container, {
    center: [31.1, 31.2],
    zoom: 9,
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  });
  map.fitBounds(REGION_BOUNDS, { padding: [24, 24] });

  // ---- Tile layers -------------------------------------------------------
  const darkBase = tile(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { attribution: ESRI_ATTR, maxZoom: 16 },
  );
  const darkRef = tile(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    { attribution: '', maxZoom: 16 },
  );
  const darkFallback = tile('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: OSM_ATTR,
    maxZoom: 19,
  });

  const satPrimary = tile(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: ESRI_ATTR, maxZoom: 19 },
  );
  const satFallback = tile(
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
    {
      attribution: 'Imagery &copy; EOX IT Services / Sentinel-2 cloudless',
      maxZoom: 14,
    },
  );

  const modes: Record<BasemapMode, ModeLayers> = {
    dark: {
      primary: L.layerGroup([darkBase, darkRef]),
      fallback: darkFallback,
      primaryTiles: [darkBase, darkRef],
      fallbackTiles: [darkFallback],
      fallbackNote: 'OpenStreetMap',
    },
    satellite: {
      primary: satPrimary,
      fallback: satFallback,
      primaryTiles: [satPrimary],
      fallbackTiles: [satFallback],
      fallbackNote: 'Sentinel-2 cloudless',
    },
  };

  const layer = L.layerGroup().addTo(map);
  const canvasRenderer = L.canvas({ padding: 0.5 });

  let activeMode: BasemapMode = 'dark';
  const fellBack: Record<BasemapMode, boolean> = { dark: false, satellite: false };
  const health: Record<BasemapMode, { errors: number; loads: number }> = {
    dark: { errors: 0, loads: 0 },
    satellite: { errors: 0, loads: 0 },
  };

  /**
   * Tile-error watchdog: if a provider fails ~8 times with zero successes,
   * promote its fallback once and notify the app.
   */
  function watch(mode: BasemapMode, tileLayers: L.TileLayer[], isFallback: boolean) {
    for (const tl of tileLayers) {
      tl.on('tileerror', () => {
        const h = health[mode];
        h.errors++;
        if (isFallback) {
          if (h.loads === 0 && h.errors >= 16) {
            onBasemapFallback?.(mode, 'unreachable');
          }
          return;
        }
        if (!fellBack[mode] && h.loads === 0 && h.errors >= 8) {
          fellBack[mode] = true;
          swapToFallback(mode);
          onBasemapFallback?.(mode, modes[mode].fallbackNote);
          console.warn(`[PyreSync] ${mode} basemap fell back to ${modes[mode].fallbackNote}`);
        }
      });
      tl.on('tileload', () => {
        health[mode].loads++;
      });
    }
  }

  function swapToFallback(mode: BasemapMode) {
    modes[mode].primary.remove();
    modes[mode].fallback.addTo(map);
  }

  for (const mode of ['dark', 'satellite'] as BasemapMode[]) {
    watch(mode, modes[mode].primaryTiles, false);
    watch(mode, modes[mode].fallbackTiles, true);
  }

  modes.dark.primary.addTo(map);

  return {
    setBasemap(mode) {
      if (mode === activeMode) return;
      activeMode = mode;
      for (const m of ['dark', 'satellite'] as BasemapMode[]) {
        modes[m].primary.remove();
        modes[m].fallback.remove();
      }
      (fellBack[mode] ? modes[mode].fallback : modes[mode].primary).addTo(map);
    },

    setDetections(detections) {
      layer.clearLayers();
      for (const d of detections) {
        L.circleMarker([d.latitude, d.longitude], {
          renderer: canvasRenderer,
          radius: frpRadius(d.frp),
          color: SATELLITE_COLORS[d.satellite],
          weight: 1,
          opacity: 0.9,
          fillColor: SATELLITE_COLORS[d.satellite],
          fillOpacity: d.confidenceCategory === 'low' ? 0.35 : 0.7,
        })
          .bindPopup(buildPopupHtml(d), { maxWidth: 280 })
          .addTo(layer);
      }
    },

    destroy() {
      map.remove();
    },
  };
}
