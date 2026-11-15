/**
 * PyroLens application orchestrator (vanilla TypeScript).
 *
 * Owns the dataset, filter state, and cross-component wiring:
 *   sidebar filters  ->  filtered detections  ->  Leaflet markers
 *   heatmap cell     ->  sidebar date range   ->  same filter pipeline
 *   basemap toggle   ->  Leaflet tile layers
 *
 * All rendering lives in src/ui/*; this module only coordinates state.
 */

import {
  ALL_CONFIDENCES,
  ALL_SATELLITES,
  datasetDateRange,
  filterDetections,
  loadDataset,
  loadStatus,
  type PyreFilters,
} from './data/adapter';
import type { PyreDataset } from './types';
import { initMap, type BasemapMode, type MapHandle } from './ui/mapView';
import { initSidebar, type SidebarHandle } from './ui/sidebar';
import { initHeatmap, type HeatmapHandle } from './ui/heatmap';

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node;
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

export async function initApp(): Promise<void> {
  const statusEl = $('map-status');
  const statusInner = $('map-status-inner');
  const periodBadge = $('period-badge');
  const periodLabel = $('period-label');
  const statDetections = $('stat-detections');
  const statYears = $('stat-years');

  // ---- Load dataset ---------------------------------------------------------
  // `?t=` (set by the Live button) forces a cache-busted refetch of the JSON.
  const cacheBust = new URLSearchParams(location.search).get('t') ?? undefined;
  let dataset: PyreDataset;
  try {
    dataset = await loadDataset(cacheBust);
    if (cacheBust) history.replaceState(null, '', location.pathname);
  } catch (err) {
    statusInner.textContent = `Data load failed: ${err instanceof Error ? err.message : String(err)}`;
    statusInner.className = 'max-w-md rounded-lg border border-red-900/60 bg-red-950/30 p-6 text-center text-sm text-red-300';
    console.error(err);
    return;
  }

  statusEl.classList.add('hidden');

  const dateRange = datasetDateRange(dataset.detections);
  statYears.textContent = String(dataset.years.length);
  statDetections.textContent = dataset.detections.length.toLocaleString();

  const basemapNotice = $('basemap-notice');
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const showBasemapNotice = (text: string) => {
    basemapNotice.textContent = text;
    basemapNotice.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => basemapNotice.classList.add('hidden'), 8000);
  };

  // ---- Initialize UI modules -------------------------------------------------
  const map: MapHandle = initMap($('map'), (mode, note) => {
    showBasemapNotice(
      note === 'unreachable'
        ? `Basemap tiles unreachable — check connection or ad-blocker (${mode})`
        : `Switched ${mode} basemap to ${note} (primary provider unavailable)`,
    );
  });

  let filters: PyreFilters = {
    dateFrom: dateRange.min,
    dateTo: dateRange.max,
    satellites: new Set(ALL_SATELLITES),
    confidences: new Set(ALL_CONFIDENCES),
    frpMin: null,
    frpMax: null,
  };

  let heatmap: HeatmapHandle;

  const applyFilters = () => {
    const filtered = filterDetections(dataset.detections, filters);
    map.setDetections(filtered);
    sidebar.setResultCount(filtered.length, dataset.detections.length);
    statDetections.textContent = filtered.length.toLocaleString();
  };

  const clearPeriod = () => {
    periodBadge.classList.add('hidden');
    heatmap.setSelected(null);
  };

  const sidebar: SidebarHandle = initSidebar($('sidebar'), {
    dateRange,
    meta: dataset.meta,
    totalCount: dataset.detections.length,
    onChange: (next) => {
      // User-initiated filter edits clear any heatmap period selection.
      filters = next;
      clearPeriod();
      applyFilters();
    },
  });

  heatmap = initHeatmap($('heatmap'), {
    years: dataset.years,
    anomalies: dataset.anomalies,
    climatology: dataset.climatology,
    onPeriodSelect: (sel) => {
      exitLiveView();
      if (sel) {
        const { from, to } = monthBounds(sel.year, sel.month);
        sidebar.setDateRange(from, to); // silent: no onChange emission
        filters = sidebar.getFilters();
        applyFilters();
        heatmap.setSelected(sel);
        periodLabel.textContent = `${String(sel.month).padStart(2, '0')}/${sel.year}`;
        periodBadge.classList.remove('hidden');
      } else {
        clearPeriod();
        sidebar.setDateRange(dateRange.min, dateRange.max);
        filters = sidebar.getFilters();
        applyFilters();
      }
    },
  });

  // ---- Basemap toggle ---------------------------------------------------------
  const basemapButtons = document.querySelectorAll<HTMLButtonElement>('#basemap-toggle .basemap-btn');
  const setBasemap = (mode: BasemapMode) => {
    map.setBasemap(mode);
    for (const btn of basemapButtons) {
      const active = btn.dataset.mode === mode;
      btn.className = `basemap-btn rounded px-3 py-1 font-medium transition-colors ${
        active ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
      }`;
    }
  };
  for (const btn of basemapButtons) {
    btn.addEventListener('click', () => setBasemap(btn.dataset.mode as BasemapMode));
  }

  // ---- Live mode -------------------------------------------------------------
  // Toggles the map to a rolling window of the most recent detections instead
  // of the full historical archive. The choice persists across the auto-
  // refresh reloads via sessionStorage, and the window re-anchors to the
  // newest acq_date whenever fresher FIRMS data arrives.
  const liveBtn = $('live-btn');
  const LIVE_WINDOW_DAYS = 14;
  let liveMode = false;

  const paintLiveBtn = () => {
    liveBtn.classList.toggle('bg-amber-500', liveMode);
    liveBtn.classList.toggle('text-slate-950', liveMode);
    liveBtn.classList.toggle('bg-amber-500/10', !liveMode);
    liveBtn.classList.toggle('text-amber-300', !liveMode);
    liveBtn.title = liveMode
      ? `Live view: last ${LIVE_WINDOW_DAYS} days — click to show the full archive`
      : `Show only the latest ${LIVE_WINDOW_DAYS} days of detections`;
  };

  const latestAcqDate = () =>
    dataset.detections.reduce((m, d) => (d.acqDate > m ? d.acqDate : m), '');

  // Heatmap-driven date changes exit live view (dates belong to the cell now).
  const exitLiveView = () => {
    if (!liveMode) return;
    liveMode = false;
    sessionStorage.setItem('pyrolens:live', '0');
    paintLiveBtn();
  };

  const setLiveMode = (on: boolean) => {
    liveMode = on;
    sessionStorage.setItem('pyrolens:live', on ? '1' : '0');
    paintLiveBtn();
    if (on) {
      const latest = latestAcqDate();
      const from = new Date(`${latest}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - (LIVE_WINDOW_DAYS - 1));
      sidebar.setDateRange(from.toISOString().slice(0, 10), latest);
    } else {
      sidebar.setDateRange(dateRange.min, dateRange.max);
    }
    filters = sidebar.getFilters();
    clearPeriod();
    applyFilters();
  };

  liveBtn.addEventListener('click', () => {
    setLiveMode(!liveMode);
    void checkForUpdate();
  });

  // ---- Freshness monitor -----------------------------------------------------
  // status.json is a tiny manifest the hourly FIRMS Action rewrites whenever
  // the products change. We poll it silently; when its data_generated_at no
  // longer matches what we loaded, we reload with a cache-busting timestamp.
  const syncStatusEl = $('sync-status');
  const loadedGeneratedAt = dataset.meta.generatedAt;

  const fmtSync = (iso: string | undefined) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : `data updated ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  };

  const checkForUpdate = async () => {
    const status = await loadStatus(String(Date.now()));
    if (!status) return;
    syncStatusEl.textContent = fmtSync(status.data_generated_at);
    syncStatusEl.classList.remove('hidden');
    if (
      status.data_generated_at &&
      loadedGeneratedAt &&
      status.data_generated_at !== loadedGeneratedAt
    ) {
      // New detections were published — reload to pick them up.
      location.search = `?t=${Date.now()}`;
    }
  };

  // Silent poll every 10 minutes — cheap (status.json is <1 KB).
  window.setInterval(() => void checkForUpdate(), 10 * 60 * 1000);

  // Initial paint — restore live mode if it was active before a refresh.
  paintLiveBtn();
  applyFilters();
  if (sessionStorage.getItem('pyrolens:live') === '1') setLiveMode(true);
}
