/**
 * Temporal calendar heatmap + anomaly inspector (vanilla DOM).
 *
 * Rows = years, columns = calendar months. Cell color encodes the robust
 * z-score anomaly of monthly fire counts vs. monthly climatology
 * (median / MAD). Clicking a cell emits a period selection; the app maps
 * that to the sidebar date range.
 */

import type { AnomalyCell, MonthClimatology } from '../types';

export interface HeatmapOptions {
  years: number[];
  anomalies: Map<string, AnomalyCell>;
  climatology: Map<number, MonthClimatology>;
  /** Emits {year, month} on cell click, or null when the selection clears. */
  onPeriodSelect: (sel: { year: number; month: number } | null) => void;
}

export interface HeatmapHandle {
  setSelected(sel: { year: number; month: number } | null): void;
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const key = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

/** Diverging color scale: warm for positive anomalies, cool for negative. */
function cellColor(z: number, hasData: boolean): string {
  if (!hasData) return '#1e293b';
  const a = Math.min(0.15 + Math.abs(z) * 0.22, 0.92);
  if (z > 0.5) return `rgba(245, 158, 11, ${a})`;
  if (z > 0) return `rgba(245, 158, 11, ${a * 0.55})`;
  if (z < -0.5) return `rgba(56, 189, 248, ${a})`;
  if (z < 0) return `rgba(56, 189, 248, ${a * 0.55})`;
  return '#334155';
}

function anomalyLabel(z: number): string {
  if (z >= 2) return 'Extreme above';
  if (z >= 1) return 'Above average';
  if (z > 0.5) return 'Slightly above';
  if (z <= -2) return 'Extreme below';
  if (z <= -1) return 'Below average';
  if (z < -0.5) return 'Slightly below';
  return 'Normal';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function initHeatmap(root: HTMLElement, opts: HeatmapOptions): HeatmapHandle {
  let selected: { year: number; month: number } | null = null;
  let hovered: { year: number; month: number } | null = null;

  // ---- Panel header --------------------------------------------------------
  const header = el('div', 'flex items-center justify-between border-b border-slate-800/70 px-4 py-2');
  const titleWrap = el('div', 'flex items-center gap-3');
  titleWrap.appendChild(
    el('h2', 'text-xs font-semibold uppercase tracking-[0.14em] text-slate-400', 'Monthly Fire-Count Anomaly'),
  );
  titleWrap.appendChild(
    el('span', 'text-[10px] text-slate-600', 'median–MAD robust z-score vs. climatology'),
  );
  header.appendChild(titleWrap);

  const clearBtn = el(
    'button',
    'hidden rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20',
    'Clear period filter ✕',
  );
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => {
    selected = null;
    refreshSelection();
    updateInspector();
    opts.onPeriodSelect(null);
  });
  header.appendChild(clearBtn);

  // Collapse toggle: shrinks the panel to its header bar so the map reclaims
  // the space on short viewports.
  const collapseBtn = el(
    'button',
    'ml-2 rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] font-medium text-slate-400 hover:text-slate-200',
    '—',
  );
  collapseBtn.type = 'button';
  collapseBtn.title = 'Collapse / expand heatmap';
  header.appendChild(collapseBtn);

  // ---- Body: grid + inspector ----------------------------------------------
  const body = el('div', 'flex min-h-0 flex-1');
  const gridScroll = el('div', 'flex-1 overflow-auto px-4 py-3');
  const grid = el('div', 'grid gap-[3px]');
  grid.style.gridTemplateColumns = `44px repeat(12, minmax(34px, 1fr))`;
  grid.style.gridTemplateRows = `18px repeat(${opts.years.length}, 22px)`;

  // Month header row
  grid.appendChild(el('div'));
  for (const m of MONTH_SHORT) {
    grid.appendChild(el('div', 'text-center text-[10px] font-medium uppercase tracking-wide text-slate-500', m));
  }

  // Year rows: label + 12 cells
  const cellMap = new Map<string, HTMLButtonElement>();
  for (const year of opts.years) {
    grid.appendChild(el('div', 'flex items-center justify-end pr-2 text-[10px] tabular-nums text-slate-500', String(year)));
    for (let month = 1; month <= 12; month++) {
      const cell = opts.anomalies.get(key(year, month));
      const hasData = (cell?.count ?? 0) > 0;
      const btn = el('button', 'hm-cell h-[22px] w-full rounded-[3px]') as HTMLButtonElement;
      btn.type = 'button';
      btn.style.background = cellColor(cell?.z ?? 0, hasData);
      btn.title = `${MONTH_SHORT[month - 1]} ${year} — ${cell?.count ?? 0} detections, z=${(cell?.z ?? 0).toFixed(2)}`;
      btn.dataset.year = String(year);
      btn.dataset.month = String(month);
      grid.appendChild(btn);
      cellMap.set(key(year, month), btn);
    }
  }
  gridScroll.appendChild(grid);

  // Legend
  const legend = el('div', 'mt-2 flex items-center gap-4 text-[10px] text-slate-500');
  const legendItems: Array<[string, string]> = [
    ['Below climatology', 'rgba(56,189,248,0.8)'],
    ['Normal', '#334155'],
    ['Above climatology', 'rgba(245,158,11,0.85)'],
    ['No data', '#1e293b'],
  ];
  for (const [label, color] of legendItems) {
    const item = el('span', 'flex items-center gap-1.5');
    const swatch = el('span', 'inline-block h-2.5 w-2.5 rounded-sm');
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(label));
    legend.appendChild(item);
  }
  gridScroll.appendChild(legend);

  // Inspector
  const inspector = el('div', 'w-56 shrink-0 overflow-y-auto border-l border-slate-800/70 px-4 py-3 text-xs');
  body.append(gridScroll, inspector);

  root.append(header, body);
  // NOTE: root IS #heatmap — its height comes from the parent's h-[300px]
  // class. Adding h-full here would make it 100% of <main> and squeeze the
  // map to zero height.
  root.classList.add('flex', 'flex-col');

  // ---- Collapse / expand -----------------------------------------------------
  let collapsed = false;
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    collapseBtn.textContent = collapsed ? '+' : '—';
    body.style.display = collapsed ? 'none' : 'flex';
    // Inline height overrides the Tailwind h-[300px] class; '' restores it.
    root.style.height = collapsed ? '44px' : '';
  });

  // ---- Interactions ----------------------------------------------------------
  grid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.hm-cell');
    if (!btn) return;
    const year = Number(btn.dataset.year);
    const month = Number(btn.dataset.month);
    if (selected?.year === year && selected?.month === month) {
      selected = null;
      refreshSelection();
      updateInspector();
      opts.onPeriodSelect(null);
    } else {
      selected = { year, month };
      refreshSelection();
      updateInspector();
      opts.onPeriodSelect({ year, month });
    }
  });

  grid.addEventListener('mouseover', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.hm-cell');
    if (!btn) return;
    hovered = { year: Number(btn.dataset.year), month: Number(btn.dataset.month) };
    updateInspector();
  });
  grid.addEventListener('mouseleave', () => {
    hovered = null;
    updateInspector();
  });

  // ---- Rendering helpers ------------------------------------------------------
  function refreshSelection() {
    for (const [k, btn] of cellMap) {
      btn.classList.toggle('selected', selected != null && k === key(selected.year, selected.month));
    }
    clearBtn.classList.toggle('hidden', selected == null);
  }

  function statRow(label: string, value: string, accent = false): HTMLElement {
    const row = el('div', 'flex items-baseline justify-between');
    row.append(
      el('span', 'text-slate-500', label),
      el('span', accent ? 'font-semibold text-amber-400' : 'tabular-nums text-slate-200', value),
    );
    return row;
  }

  function updateInspector() {
    const active = hovered ?? selected;
    inspector.innerHTML = '';
    if (!active) {
      inspector.appendChild(el('p', 'text-slate-500', 'Hover or select a cell to inspect monthly anomaly statistics.'));
      return;
    }
    const cell: AnomalyCell | undefined = opts.anomalies.get(key(active.year, active.month));
    const clim: MonthClimatology | undefined = opts.climatology.get(active.month);
    if (!cell) {
      inspector.appendChild(el('p', 'text-slate-500', 'No anomaly record for this period.'));
      return;
    }
    const wrap = el('div', 'space-y-1.5');
    wrap.appendChild(
      el('div', 'text-[10px] font-semibold uppercase tracking-wider text-slate-500', `${MONTH_SHORT[active.month - 1]} ${active.year}`),
    );
    wrap.appendChild(statRow('Detections', String(cell.count)));
    wrap.appendChild(statRow('Monthly median', String(cell.median)));
    wrap.appendChild(statRow('z-score', cell.z.toFixed(2)));
    wrap.appendChild(statRow('Anomaly', anomalyLabel(cell.z), true));
    if (clim) {
      const cTitle = el('div', 'pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500', 'Climatology');
      wrap.appendChild(cTitle);
      wrap.appendChild(statRow('Mean', clim.meanCount.toFixed(1)));
      wrap.appendChild(statRow('Range', `${clim.minCount}–${clim.maxCount}`));
    }
    wrap.appendChild(el('p', 'pt-2 text-[10px] leading-snug text-slate-600', 'Click the cell to isolate this period on the map.'));
    inspector.appendChild(wrap);
  }

  updateInspector();

  return {
    setSelected(sel) {
      selected = sel;
      refreshSelection();
      updateInspector();
    },
  };
}
