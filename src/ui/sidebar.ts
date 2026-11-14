/**
 * Sidebar filter module (vanilla DOM).
 *
 * Builds the full filter panel inside the sidebar container: result counter,
 * date range, satellite/instrument checkboxes, confidence checkboxes, FRP
 * bounds, reset action, and dataset provenance. Owns the PyreFilters state
 * and notifies the app via `onChange` on every mutation — including
 * programmatic date updates driven by the heatmap.
 */

import {
  ALL_CONFIDENCES,
  ALL_SATELLITES,
  type PyreFilters,
} from '../data/adapter';
import type { ConfidenceCategory, ProductMeta, SatelliteId } from '../types';
import { CONFIDENCE_COLORS, CONFIDENCE_LABELS, SATELLITE_COLORS, SATELLITE_LABELS } from './palette';

export interface SidebarOptions {
  /** Full dataset date bounds, used for input min/max and reset. */
  dateRange: { min: string; max: string };
  meta: ProductMeta | null;
  totalCount: number;
  onChange: (filters: PyreFilters) => void;
}

export interface SidebarHandle {
  /**
   * Programmatically set the date range (used by heatmap cell clicks).
   * Does NOT emit onChange — the caller reads getFilters() and reapplies.
   */
  setDateRange(from: string, to: string): void;
  /** Current filter state (safe copy). */
  getFilters(): PyreFilters;
  setResultCount(shown: number, total: number): void;
}

const SECTION_CLS =
  'border-b border-slate-800/70 px-4 py-4';
const SECTION_TITLE_CLS =
  'mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500';
const INPUT_CLS =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-amber-500';
const LABEL_CLS =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 text-sm text-slate-300 hover:bg-slate-800/60';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  html = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

export function initSidebar(root: HTMLElement, opts: SidebarOptions): SidebarHandle {
  const state: PyreFilters = {
    dateFrom: opts.dateRange.min,
    dateTo: opts.dateRange.max,
    satellites: new Set<SatelliteId>(ALL_SATELLITES),
    confidences: new Set<ConfidenceCategory>(ALL_CONFIDENCES),
    frpMin: null,
    frpMax: null,
  };

  const emit = () => opts.onChange({ ...state, satellites: new Set(state.satellites), confidences: new Set(state.confidences) });

  // ---- Result summary -----------------------------------------------------
  const summary = el('div', 'border-b border-slate-800/70 px-4 py-3');
  summary.innerHTML = `
    <div class="text-[11px] uppercase tracking-wider text-slate-500">Detections</div>
    <div class="mt-0.5 text-xl font-semibold tabular-nums text-slate-100">
      <span id="sb-result-count">0</span>
      <span class="ml-1 text-xs font-normal text-slate-500">/ <span id="sb-total-count">${opts.totalCount.toLocaleString()}</span></span>
    </div>`;
  root.appendChild(summary);

  const resultCountEl = summary.querySelector<HTMLElement>('#sb-result-count')!;
  const totalCountEl = summary.querySelector<HTMLElement>('#sb-total-count')!;

  // ---- Section builder ----------------------------------------------------
  function section(title: string): HTMLElement {
    const s = el('section', SECTION_CLS);
    s.appendChild(el('h3', SECTION_TITLE_CLS, title));
    root.appendChild(s);
    return s;
  }

  // ---- Date range ---------------------------------------------------------
  const dateSection = section('Date Range (UTC)');
  const dateWrap = el('div', 'space-y-2');

  const fromLabel = el('label', 'block');
  fromLabel.innerHTML = '<span class="mb-1 block text-xs text-slate-400">From</span>';
  const dateFromInput = el('input', INPUT_CLS);
  dateFromInput.type = 'date';
  dateFromInput.value = state.dateFrom;
  dateFromInput.min = opts.dateRange.min;
  dateFromInput.max = opts.dateRange.max;
  dateFromInput.addEventListener('change', () => {
    state.dateFrom = dateFromInput.value;
    emit();
  });
  fromLabel.appendChild(dateFromInput);

  const toLabel = el('label', 'block');
  toLabel.innerHTML = '<span class="mb-1 block text-xs text-slate-400">To</span>';
  const dateToInput = el('input', INPUT_CLS);
  dateToInput.type = 'date';
  dateToInput.value = state.dateTo;
  dateToInput.min = opts.dateRange.min;
  dateToInput.max = opts.dateRange.max;
  dateToInput.addEventListener('change', () => {
    state.dateTo = dateToInput.value;
    emit();
  });
  toLabel.appendChild(dateToInput);

  dateWrap.append(fromLabel, toLabel);
  dateSection.appendChild(dateWrap);

  // ---- Satellite / instrument ---------------------------------------------
  const satSection = section('Satellite / Instrument');
  const satList = el('ul', 'space-y-1.5');
  for (const id of ALL_SATELLITES) {
    const li = el('li');
    const label = el('label', LABEL_CLS);
    const cb = el('input', 'h-3.5 w-3.5 accent-amber-500');
    cb.type = 'checkbox';
    cb.checked = state.satellites.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.satellites.add(id);
      else state.satellites.delete(id);
      emit();
    });
    const dot = el('span', 'inline-block h-2.5 w-2.5 rounded-full');
    dot.style.backgroundColor = SATELLITE_COLORS[id];
    label.append(cb, dot, document.createTextNode(SATELLITE_LABELS[id]));
    li.appendChild(label);
    satList.appendChild(li);
  }
  satSection.appendChild(satList);

  // ---- Confidence ---------------------------------------------------------
  const confSection = section('Confidence Level');
  const confList = el('ul', 'space-y-1.5');
  for (const id of ALL_CONFIDENCES) {
    const li = el('li');
    const label = el('label', LABEL_CLS);
    const cb = el('input', 'h-3.5 w-3.5 accent-amber-500');
    cb.type = 'checkbox';
    cb.checked = state.confidences.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.confidences.add(id);
      else state.confidences.delete(id);
      emit();
    });
    const dot = el('span', 'inline-block h-2.5 w-2.5 rounded-full');
    dot.style.backgroundColor = CONFIDENCE_COLORS[id];
    label.append(cb, dot, document.createTextNode(CONFIDENCE_LABELS[id]));
    li.appendChild(label);
    confList.appendChild(li);
  }
  confSection.appendChild(confList);

  // ---- FRP ----------------------------------------------------------------
  const frpSection = section('Fire Radiative Power (MW)');
  const frpWrap = el('div', 'flex items-center gap-2');
  const numOrNull = (v: string): number | null => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const frpMinInput = el('input', INPUT_CLS);
  frpMinInput.type = 'number';
  frpMinInput.min = '0';
  frpMinInput.step = '0.1';
  frpMinInput.placeholder = 'Min';
  frpMinInput.addEventListener('change', () => {
    state.frpMin = numOrNull(frpMinInput.value);
    emit();
  });

  const frpSep = el('span', 'text-slate-500', '–');

  const frpMaxInput = el('input', INPUT_CLS);
  frpMaxInput.type = 'number';
  frpMaxInput.min = '0';
  frpMaxInput.step = '0.1';
  frpMaxInput.placeholder = 'Max';
  frpMaxInput.addEventListener('change', () => {
    state.frpMax = numOrNull(frpMaxInput.value);
    emit();
  });

  frpWrap.append(frpMinInput, frpSep, frpMaxInput);
  frpSection.appendChild(frpWrap);

  // ---- Reset ---------------------------------------------------------------
  const resetWrap = el('div', 'px-4 py-4');
  const resetBtn = el(
    'button',
    'w-full rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-amber-500/60 hover:text-amber-400',
    'Reset Filters',
  );
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    state.dateFrom = opts.dateRange.min;
    state.dateTo = opts.dateRange.max;
    state.satellites = new Set(ALL_SATELLITES);
    state.confidences = new Set(ALL_CONFIDENCES);
    state.frpMin = null;
    state.frpMax = null;
    dateFromInput.value = state.dateFrom;
    dateToInput.value = state.dateTo;
    for (const cb of satList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      cb.checked = true;
    }
    for (const cb of confList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      cb.checked = true;
    }
    frpMinInput.value = '';
    frpMaxInput.value = '';
    emit();
  });
  resetWrap.appendChild(resetBtn);
  root.appendChild(resetWrap);

  // ---- Provenance ----------------------------------------------------------
  if (opts.meta) {
    const prov = el('div', 'mt-auto border-t border-slate-800/70 px-4 py-3');
    const badge = el(
      'div',
      `mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        opts.meta.synthetic
          ? 'bg-amber-500/15 text-amber-400'
          : 'bg-emerald-500/15 text-emerald-400'
      }`,
      opts.meta.synthetic ? 'Synthetic Demo Data' : 'Live Data',
    );
    const disclaimer = el(
      'p',
      'text-[11px] leading-snug text-slate-500',
      opts.meta.disclaimer ??
        'Harmonized MODIS/VIIRS active-fire detections for the Nile Delta, Egypt.',
    );
    const genDate = el(
      'p',
      'mt-1 text-[10px] text-slate-600',
      `Generated ${opts.meta.generatedAt ? new Date(opts.meta.generatedAt).toLocaleDateString() : '—'}`,
    );
    prov.append(badge, disclaimer, genDate);
    root.appendChild(prov);
  }

  return {
    setDateRange(from, to) {
      state.dateFrom = from;
      state.dateTo = to;
      dateFromInput.value = from;
      dateToInput.value = to;
      // Intentionally silent: heatmap-driven period selection is applied by
      // the app layer, which must not clear the heatmap selection.
    },
    getFilters() {
      return {
        ...state,
        satellites: new Set(state.satellites),
        confidences: new Set(state.confidences),
      };
    },
    setResultCount(shown, total) {
      resultCountEl.textContent = shown.toLocaleString();
      totalCountEl.textContent = total.toLocaleString();
    },
  };
}
