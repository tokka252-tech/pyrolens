#!/usr/bin/env python3
# AI-usage disclosure (NASA Space Apps Challenge 2026): this script was developed with
# assistance from Claude (Anthropic) - drafting, refactoring and documentation - and was
# reviewed and tested by the PyroLens team. Live NRT syncing is NOT part of this script.
"""PyroLens end-to-end OFFLINE pipeline: raw NASA FIRMS detections -> dashboard exports.

The script merges the two stages of the PyroLens project into one sequential flow
(MODIS C6.1 ~1 km, 2000 onwards, and VIIRS S-NPP ~375 m, 2012 onwards).

The script is strictly offline: it never opens a network connection. It reads the FIRMS
CSV files (archive and any manually downloaded NRT files) from ``--input``. Live
Near-Real-Time syncing is done separately by ``scripts/update-live.mjs`` (GitHub Actions).

Stage A - Harmonization (formerly ``harmonize.py``)
    1. load     read every ``fire_*.csv``, unify columns, build UTC timestamps,
                unify confidence classes
    2. clean    drop invalid / outside-AOI rows; archive wins over NRT; exact duplicates
    3. grid     project to UTM 36N and snap detections to a common 1 km grid
    4. mask     learn static-source / offshore cells from the archive ``type`` field
    5. filter   nominal+high confidence, vegetation fires, outside the static mask
    6. dedup    one event per (1 km cell, UTC day)
    7. calibr.  monthly MODIS->VIIRS sensitivity ratio ``k`` -> ``adjusted_count``
    8. export   parquet + CSV.GZ, qa_report.json, qa_tables/*.csv, figures

Stage B - Analytics (formerly ``pryesync walaa.py``)
    9. monthly  aggregate ``adjusted_count`` (fire_count) and FRP per (year, month)
    10. climate historical mean / standard deviation per calendar month
    11. anomaly Z-score = (fire_count - historical_mean) / historical_std
    12. export  ``calendar.json``, ``monthly_statistics.csv`` and
                ``harmonized_fires_merged.parquet`` for the frontend dashboard

Usage (defaults: ``--input <script dir>/data``, ``--output <script dir>/out``)::

    python main_pipeline.py                          # offline run
    python main_pipeline.py --input ./data --output ./out
    python main_pipeline.py --no-calibrate           # adjusted_count = 1.0 everywhere
    python main_pipeline.py --skip-harmonize         # re-run only stage B on existing output

Output layout (inside ``--output``)::

    harmonized_fires.parquet | harmonized_fires.csv.gz   one row per fire event
    qa_report.json, qa_tables/*.csv, before_after.png, calibration_overlap.png
    frontend/calendar.json, frontend/monthly_statistics.csv,
    frontend/harmonized_fires_merged.parquet

Harmonized event schema (``OUTPUT_COLUMNS``)
    date, lat, lon, cell_id, source (MODIS | VIIRS | BOTH), frp (max, MW; not
    comparable between sensors), confidence_class (nominal | high), adjusted_count
    (VIIRS-equivalent weight), n_detections, n_modis, n_viirs.

Caveats
    * An "event" is a 1 km cell-day, not a physical fire.
    * The static-source mask is learned from the archive; NRT data keeps a small
      residual of static sources (see ``mask_holdout`` in the QA report).
    * ``k`` is a statistical estimate (bootstrap CI in the QA report).
    * NRT detections are provisional and may be revised by FIRMS.
    * Months not fully covered by the data are flagged ``is_complete = False`` and are
      excluded from the climatology baseline; their ``z_score`` is null.
    * Months without any event do not appear in the monthly table (same behaviour as
      the original analytics script).
"""
from __future__ import annotations

import argparse
import glob
import json
import logging
import sys
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
import pandas as pd

# ----------------------------------------------------------------------------
# CONFIGURATION
# ----------------------------------------------------------------------------
logger = logging.getLogger("pyrolens")

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT_DIR = BASE_DIR / "data"
DEFAULT_OUTPUT_DIR = BASE_DIR / "out"
FRONTEND_SUBDIR = "frontend"

AOI = dict(lat_min=30.0, lat_max=31.6, lon_min=29.5, lon_max=32.5)  # edit if the AOI changes
GRID_M = 1000                  # common grid cell size (m) = MODIS native pixel
UTM_ZONE = 36                  # one fixed zone for the whole AOI (lon 29.5-32.5)
MODIS_NOMINAL_MIN = 30         # FIRMS convention: 0-29 low, 30-79 nominal, 80-100 high
MODIS_HIGH_MIN = 80
KEEP_CLASSES = ("nominal", "high")
MASK_MIN_NONVEG = 3            # static mask: >= 3 non-vegetation detections in the cell ...
MASK_MIN_SHARE = 0.5           # ... and >= 50 % of the cell's archive detections
VEG_TYPE = 0                   # FIRMS 'type': 0 vegetation, 1 volcano, 2 static land, 3 offshore
MASK_HOLDOUT_FROM = "2023-01-01"   # mask validation: learn before, test from this date
OUTPUT_COLUMNS = ["date", "lat", "lon", "cell_id", "source", "frp", "confidence_class",
                  "adjusted_count", "n_detections", "n_modis", "n_viirs"]
N_BOOT = 2000
RNG_SEED = 42
MIN_BASELINE_YEARS = 3         # minimum complete months per calendar month to score a Z

# Columns every FIRMS CSV must provide (checked by ``load_firms``)
REQUIRED_COLUMNS = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument",
                    "confidence", "frp", "daynight"}


class PipelineError(Exception):
    """Controlled, user-facing failure of the pipeline (bad input, empty result, ...)."""


@dataclass
class PipelineConfig:
    """All run-time settings of the pipeline.

    Attributes:
        input_dir: Folder with the FIRMS CSVs (read only).
        output_dir: Folder for harmonized files, QA outputs and figures.
        calibrate: If True, ``adjusted_count`` holds the MODIS->VIIRS ratio for
            MODIS-only events before full VIIRS coverage; otherwise it is 1.0.
        make_plots: Also write ``before_after.png`` and ``calibration_overlap.png``.
        skip_harmonize: Skip stage A and load the existing harmonized file from
            ``output_dir``.
        frontend_dir: Folder for the dashboard exports; defaults to
            ``output_dir / "frontend"``.
    """

    input_dir: Path = DEFAULT_INPUT_DIR
    output_dir: Path = DEFAULT_OUTPUT_DIR
    calibrate: bool = True
    make_plots: bool = True
    skip_harmonize: bool = False
    frontend_dir: Optional[Path] = None

    def __post_init__(self) -> None:
        """Normalise every path to an absolute ``Path`` and fill the frontend default."""
        self.input_dir = Path(self.input_dir).expanduser().resolve()
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.frontend_dir = (Path(self.frontend_dir).expanduser().resolve()
                             if self.frontend_dir else self.output_dir / FRONTEND_SUBDIR)


@dataclass
class HarmonizationResult:
    """Outcome of stage A.

    Attributes:
        events: Harmonized event table in the ``OUTPUT_COLUMNS`` schema.
        qa: QA dictionary (also saved as ``qa_report.json``).
        coverage_start: First day covered by the input data.
        coverage_end: Last day covered by BOTH sensors (conservative).
    """

    events: pd.DataFrame
    qa: Dict[str, Any] = field(default_factory=dict)
    coverage_start: pd.Timestamp = pd.NaT
    coverage_end: pd.Timestamp = pd.NaT


# ----------------------------------------------------------------------------
# SMALL HELPERS
# ----------------------------------------------------------------------------
def configure_logging(level: str = "INFO") -> None:
    """Configure console logging for the whole pipeline.

    Args:
        level: Logging level name (DEBUG, INFO, WARNING, ERROR).

    Raises:
        ValueError: If ``level`` is not a valid logging level name.
    """
    numeric = logging.getLevelName(level.upper())
    if not isinstance(numeric, int):
        raise ValueError(f"Invalid log level: {level}")
    logging.basicConfig(level=numeric, format="%(asctime)s %(levelname)-7s %(message)s",
                        datefmt="%H:%M:%S", force=True)


def _check(condition: bool, message: str) -> None:
    """Raise ``AssertionError`` when ``condition`` is false (also works under ``python -O``).

    Args:
        condition: Result of the integrity test.
        message: Description of the violated rule.

    Raises:
        AssertionError: If ``condition`` is false.
    """
    if not condition:
        raise AssertionError(message)


def _finite_or_none(value: float) -> Optional[float]:
    """Return ``value`` as float, or None when it is NaN/inf (keeps JSON valid).

    Args:
        value: Any number.

    Returns:
        The float value or None.
    """
    value = float(value)
    return value if np.isfinite(value) else None


def _to_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Convert a DataFrame to JSON-safe records (NaN/NaT become None).

    Args:
        df: Table to convert.

    Returns:
        A list of dictionaries, one per row, containing only Python scalars.
    """
    clean = df.astype(object).where(df.notna(), None)
    return clean.to_dict(orient="records")


def _write_parquet_or_csv(df: pd.DataFrame, parquet_path: Path) -> Path:
    """Write ``df`` as parquet, falling back to ``.csv.gz`` if pyarrow is missing.

    Args:
        df: Table to save.
        parquet_path: Target ``.parquet`` path.

    Returns:
        The path that was actually written.
    """
    try:
        df.to_parquet(parquet_path, index=False)
        return parquet_path
    except ImportError:
        fallback = parquet_path.with_suffix(".csv.gz")
        logger.warning("pyarrow not installed (pip install pyarrow); writing %s instead",
                       fallback.name)
        df.to_csv(fallback, index=False, compression="gzip")
        return fallback


# ----------------------------------------------------------------------------
# PROJECTION
# ----------------------------------------------------------------------------
def to_utm(lat: Any, lon: Any, zone: int = UTM_ZONE) -> Tuple[np.ndarray, np.ndarray]:
    """Project WGS84 latitude / longitude (degrees) to UTM easting / northing (metres).

    Krueger series implemented locally so pyproj is not required. One fixed zone (36N) is
    used for the whole AOI so every cell belongs to one continuous grid (scale error at
    lon 29.5 is about 0.1 %). Check value: ``to_utm(30, 33) -> (500000.0, 3318785.35)``.

    Args:
        lat: Latitude(s) in degrees (scalar or array).
        lon: Longitude(s) in degrees (scalar or array).
        zone: UTM zone number (northern hemisphere).

    Returns:
        Tuple ``(easting, northing)`` in metres.
    """
    a = 6378137.0
    f = 1 / 298.257223563
    k0 = 0.9996
    n = f / (2 - f)
    big_a = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    alpha = [n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16, 13 * n ** 2 / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240]
    e = np.sqrt(f * (2 - f))
    phi = np.radians(np.asarray(lat, float))
    lam = np.radians(np.asarray(lon, float) - ((zone - 1) * 6 - 180 + 3))
    t = np.sinh(np.arctanh(np.sin(phi)) - e * np.arctanh(e * np.sin(phi)))
    xi = np.arctan2(t, np.cos(lam))
    eta = np.arctanh(np.sin(lam) / np.sqrt(1 + t ** 2))
    x, y = eta.copy(), xi.copy()
    for j, al in enumerate(alpha, 1):
        x += al * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
        y += al * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
    return 500000 + k0 * big_a * x, k0 * big_a * y


# ----------------------------------------------------------------------------
# STAGE A - HARMONIZATION
# ----------------------------------------------------------------------------
def load_firms(input_dir: Path) -> pd.DataFrame:
    """Read every ``fire_*.csv`` in ``input_dir`` into one tidy table (one row per detection).

    The file name decides provenance: ``_nrt_`` -> product ``nrt`` (else ``archive``).
    Empty files are skipped. Columns: sensor, satellite, product, lat, lon, frp, daynight,
    type (NaN for NRT), dt_utc and conf_class (low / nominal / high; MODIS 0-29 / 30-79 /
    80-100, VIIRS l/n/h).

    Args:
        input_dir: Folder with the FIRMS CSV files.

    Returns:
        All detections concatenated.

    Raises:
        FileNotFoundError: If no ``fire_*.csv`` file exists.
        ValueError: If a file lacks required columns or all files are empty.
    """
    files = sorted(Path(p) for p in glob.glob(str(input_dir / "fire_*.csv")))
    if not files:
        raise FileNotFoundError(f"No fire_*.csv files found in '{input_dir}'. Put the FIRMS CSVs there "
                                f"or pass --input <folder>.")
    parts = []
    for fp in files:
        name = fp.name.lower()
        product = "nrt" if "_nrt_" in name else "archive"
        d = pd.read_csv(fp)
        if d.empty:
            logger.info("  skipped %-40s (0 rows)", name)
            continue
        miss = REQUIRED_COLUMNS - set(d.columns)
        if miss:
            raise ValueError(f"{name}: missing columns {sorted(miss)}")
        sensor = np.where(d["instrument"].astype(str).str.upper() == "MODIS", "MODIS", "VIIRS")
        out = pd.DataFrame({
            "sensor": sensor,
            "satellite": d["satellite"].astype(str),
            "product": product,
            "lat": d["latitude"].astype(float),
            "lon": d["longitude"].astype(float),
            "frp": pd.to_numeric(d["frp"], errors="coerce"),
            "daynight": d["daynight"].astype(str),
            "type": pd.to_numeric(d["type"], errors="coerce") if "type" in d.columns else np.nan,
        })
        # FIRMS acq_date/acq_time are already UTC; acq_time is HHMM without leading zeros.
        hhmm = d["acq_time"].astype(int).astype(str).str.zfill(4)
        out["dt_utc"] = pd.to_datetime(d["acq_date"].astype(str) + " " + hhmm,
                                       format="%Y-%m-%d %H%M", utc=True)
        if (out["sensor"] == "MODIS").all():
            c = pd.to_numeric(d["confidence"], errors="coerce")
            out["conf_class"] = np.select([c >= MODIS_HIGH_MIN, c >= MODIS_NOMINAL_MIN, c >= 0],
                                          ["high", "nominal", "low"], default="unknown")
        else:
            out["conf_class"] = d["confidence"].astype(str).str.strip().str.lower().map(
                {"l": "low", "n": "nominal", "h": "high",
                 "low": "low", "nominal": "nominal", "high": "high"}).fillna("unknown")
        parts.append(out)
        logger.info("  loaded %-40s %8d rows  [%s, %s]", name, len(out), sensor[0], product)
    if not parts:
        raise ValueError("All input files are empty")
    return pd.concat(parts, ignore_index=True)


def clean_detections(raw: pd.DataFrame) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """Drop invalid / outside-AOI rows, let the archive supersede NRT, remove duplicates.

    Archive rows are authoritative: NRT rows on or before the archive's last day (per
    sensor) are dropped. The duplicate key ignores the satellite label (files can name the
    same satellite differently, e.g. 'N' and 'SNPP').

    Args:
        raw: Output of ``load_firms``.

    Returns:
        Tuple ``(clean_table, stats)`` where stats holds dropped-row counts, rows per
        sensor after cleaning and the last detection time per sensor.
    """
    stats: Dict[str, Any] = {}
    n0 = len(raw)
    df = raw.dropna(subset=["lat", "lon", "dt_utc", "frp"])
    df = df[df.lat.between(AOI["lat_min"], AOI["lat_max"]) & df.lon.between(AOI["lon_min"], AOI["lon_max"])]
    df = df[df.conf_class != "unknown"]
    stats["dropped_invalid_or_outside_aoi"] = int(n0 - len(df))

    last_arch = df[df["product"] == "archive"].groupby("sensor")["dt_utc"].max().dt.normalize()
    sensor_last = df["sensor"].map(last_arch)
    drop = df["product"].eq("nrt") & sensor_last.notna() & (df["dt_utc"].dt.normalize() <= sensor_last)
    stats["nrt_rows_superseded_by_archive"] = int(drop.sum())
    df = df[~drop]
    df = df.sort_values("product", kind="stable").drop_duplicates(["sensor", "dt_utc", "lat", "lon"], keep="first")
    stats["rows_after_clean"] = df.groupby("sensor").size().to_dict()

    stats["freshness"] = {str(sensor): {"last_detection_utc": str(grp["dt_utc"].max())}
                          for sensor, grp in df.groupby("sensor")}
    return df.copy(), stats


def grid_detections(df: pd.DataFrame) -> pd.DataFrame:
    """Snap every detection to the common 1 km UTM grid and add its UTC day.

    Args:
        df: Cleaned detections with ``lat``, ``lon`` and ``dt_utc``.

    Returns:
        Copy with added columns ``ix``, ``iy``, ``cell_id`` (``"<ix>_<iy>"``, km) and
        ``date`` (naive UTC day).
    """
    out = df.copy()
    x, y = to_utm(out["lat"].values, out["lon"].values)
    out["ix"] = np.floor(x / GRID_M).astype(int)
    out["iy"] = np.floor(y / GRID_M).astype(int)
    out["cell_id"] = out["ix"].astype(str) + "_" + out["iy"].astype(str)
    out["date"] = out["dt_utc"].dt.tz_localize(None).dt.normalize()
    return out


def _mask_from(table: pd.DataFrame) -> Set[str]:
    """Return cells with enough non-vegetation detections to count as static / offshore.

    Args:
        table: Archive detections with boolean ``nonveg`` and ``cell_id``.

    Returns:
        Set of cell ids meeting ``MASK_MIN_NONVEG`` and ``MASK_MIN_SHARE``.
    """
    g = table.groupby("cell_id").agg(n=("nonveg", "size"), nv=("nonveg", "sum"))
    return set(g[(g.nv >= MASK_MIN_NONVEG) & (g.nv / g.n >= MASK_MIN_SHARE)].index)


def learn_static_mask(df: pd.DataFrame) -> Tuple[Set[str], Dict[str, Any]]:
    """Learn static-source / offshore cells from the archive ``type`` field and validate it.

    NRT files have no ``type``, so the learned mask is what cleans them. The validation
    learns on data before ``MASK_HOLDOUT_FROM`` and tests on the rest.

    Args:
        df: Gridded detections (needs ``type``, ``cell_id``, ``date``).

    Returns:
        Tuple ``(mask_cells, holdout_metrics)``; metrics are None when the hold-out
        period has no archive data.
    """
    arch = df[df["type"].notna()].copy()
    arch["nonveg"] = arch["type"] != VEG_TYPE
    mask_cells = _mask_from(arch) if len(arch) else set()

    cut = pd.Timestamp(MASK_HOLDOUT_FROM)
    train, test = arch[arch.date < cut], arch[arch.date >= cut]
    holdout: Dict[str, Any] = {"n_test": int(len(test)), "recall_of_nonveg": None,
                               "precision": None, "veg_records_lost": None}
    if len(train) and len(test):
        in_mask = test["cell_id"].isin(_mask_from(train))
        holdout["recall_of_nonveg"] = _finite_or_none(in_mask[test.nonveg].mean())
        holdout["precision"] = _finite_or_none(test.nonveg[in_mask].mean())
        holdout["veg_records_lost"] = _finite_or_none(in_mask[~test.nonveg].mean())
    else:
        logger.warning("Static-mask hold-out skipped: no archive data before/after %s", MASK_HOLDOUT_FROM)
    return mask_cells, holdout


def filter_detections(df: pd.DataFrame, mask_cells: Set[str], raw_rows: Dict[str, int]
                      ) -> Tuple[pd.DataFrame, pd.DataFrame, Dict[str, Dict[str, int]], int]:
    """Keep nominal/high-confidence vegetation fires outside the static mask.

    Args:
        df: Gridded detections.
        mask_cells: Static / offshore cells from ``learn_static_mask``.
        raw_rows: Raw row count per sensor (first funnel stage).

    Returns:
        Tuple ``(kept, removed_by_mask, funnel, n_low_confidence)`` where funnel gives the
        record count per sensor after each filtering stage.
    """
    sensors = ("MODIS", "VIIRS")
    funnel: Dict[str, Dict[str, int]] = {
        s: {"1_raw_loaded": int(raw_rows.get(s, 0)), "2_valid_in_aoi_deduped": int((df.sensor == s).sum())}
        for s in sensors}
    kept = df[df["conf_class"].isin(KEEP_CLASSES)]
    for s in sensors:
        funnel[s]["3_conf_nominal_high"] = int((kept.sensor == s).sum())
    kept = kept[~(kept["type"].notna() & (kept["type"] != VEG_TYPE))]
    for s in sensors:
        funnel[s]["4_type_vegetation_only"] = int((kept.sensor == s).sum())
    removed = kept[kept["cell_id"].isin(mask_cells)]
    kept = kept[~kept["cell_id"].isin(mask_cells)]
    for s in sensors:
        funnel[s]["5_outside_static_mask"] = int((kept.sensor == s).sum())
    return kept, removed, funnel, int((df.conf_class == "low").sum())


def build_events(kept: pd.DataFrame) -> pd.DataFrame:
    """De-duplicate detections into fire events (1 km cell x 1 UTC day).

    Args:
        kept: Filtered detections.

    Returns:
        One row per event with lat, lon, frp (max), n_modis, n_viirs, n_detections,
        source (MODIS | VIIRS | BOTH), confidence_class and month.

    Raises:
        PipelineError: If no detection survived the filters.
    """
    if kept.empty:
        raise PipelineError("No detections left after filtering - check the AOI and the input files.")
    f = kept.assign(is_m=(kept.sensor == "MODIS").astype(int), is_v=(kept.sensor == "VIIRS").astype(int),
                    is_high=(kept.conf_class == "high").astype(int))
    ev = f.groupby(["cell_id", "date"], sort=True).agg(
        lat=("lat", "mean"), lon=("lon", "mean"), frp=("frp", "max"),
        n_modis=("is_m", "sum"), n_viirs=("is_v", "sum"), any_high=("is_high", "max")).reset_index()
    ev["n_detections"] = ev.n_modis + ev.n_viirs
    ev["source"] = np.select([(ev.n_modis > 0) & (ev.n_viirs > 0), ev.n_modis > 0], ["BOTH", "MODIS"],
                             default="VIIRS")
    ev["confidence_class"] = np.where(ev.any_high == 1, "high", "nominal")
    ev["month"] = ev["date"].dt.to_period("M")
    return ev


def calibrate_sensitivity(ev: pd.DataFrame, kept: pd.DataFrame, apply: bool
                          ) -> Tuple[pd.DataFrame, Optional[Dict[str, Any]], pd.DataFrame,
                                     Optional[pd.DataFrame]]:
    """Estimate the monthly MODIS->VIIRS sensitivity ratio ``k`` and set ``adjusted_count``.

    ``k`` is the number of merged events per MODIS-detected event in the complete months
    where both sensors operate. If ``apply`` is True, MODIS-only events before full VIIRS
    coverage get ``adjusted_count = k(calendar month)``; every other event gets 1.0.
    If the sensors do not overlap for at least 3 complete months, no calibration is done.

    Args:
        ev: Events from ``build_events``.
        kept: Filtered detections (used to find sensor coverage dates).
        apply: Whether to apply ``k`` to ``adjusted_count``.

    Returns:
        Tuple ``(events_with_adjusted_count, calibration_dict_or_None, monthly_table,
        overlap_table_or_None)``.
    """
    ev = ev.copy()
    ev["adjusted_count"] = 1.0
    mon = ev.groupby("month").agg(
        events=("cell_id", "size"),
        modis_detected=("n_modis", lambda s: int((s > 0).sum())),
        viirs_detected=("n_viirs", lambda s: int((s > 0).sum()))).reindex(
        pd.period_range(ev.month.min(), ev.month.max(), freq="M"), fill_value=0)

    v_dates = kept.loc[kept.sensor == "VIIRS", "date"]
    m_dates = kept.loc[kept.sensor == "MODIS", "date"]
    if v_dates.empty or m_dates.empty:
        logger.warning("Calibration skipped: only one sensor present; adjusted_count = 1.0")
        return ev, None, mon, None

    v_first = v_dates.min()
    common_last = min(m_dates.max(), v_dates.max())
    first_full = (v_first + pd.offsets.MonthBegin(1)) if v_first.day != 1 else v_first
    # last COMPLETE common month (a partial month would bias k)
    last_full = (common_last.to_period("M") if (common_last + pd.Timedelta(days=1)).day == 1
                 else common_last.to_period("M") - 1)
    ov_months = pd.period_range(first_full.to_period("M"), last_full, freq="M")
    if len(ov_months) < 3:
        logger.warning("Calibration skipped: sensor overlap shorter than 3 complete months")
        return ev, None, mon, None

    ov = mon.loc[ov_months].copy()
    ov["calmonth"] = ov.index.month
    ov["year"] = ov.index.year
    k_global = ov.events.sum() / max(ov.modis_detected.sum(), 1)
    slope = float(np.polyfit(ov.modis_detected, ov.events, 1)[0])
    corr = float(np.corrcoef(ov.modis_detected, ov.events)[0, 1])
    k_m = ov.groupby("calmonth").events.sum() / ov.groupby("calmonth").modis_detected.sum().replace(0, np.nan)

    rng = np.random.default_rng(RNG_SEED)
    years = ov.year.unique()
    boots = []
    for _ in range(N_BOOT):
        ys = rng.choice(years, len(years), replace=True)
        b = pd.concat([ov[ov.year == y_] for y_ in ys])
        km_b = (b.groupby("calmonth").events.sum()
                / b.groupby("calmonth").modis_detected.sum().replace(0, np.nan)).reindex(range(1, 13))
        boots.append((b.events.sum() / max(b.modis_detected.sum(), 1), km_b))
    kg_lo, kg_hi = np.percentile([b[0] for b in boots], [5, 95])
    km_arr = np.array([b[1].values for b in boots], float)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)   # calendar months with no overlap data
        km_lo, km_hi = np.nanpercentile(km_arr, 5, axis=0), np.nanpercentile(km_arr, 95, axis=0)

    cal = dict(
        overlap_from=str(ov_months[0]), overlap_to=str(ov_months[-1]), n_months=int(len(ov)),
        k_global=float(k_global), k_global_90ci=[float(kg_lo), float(kg_hi)],
        regression_slope=slope, pearson_r_monthly=corr,
        k_by_calendar_month={int(m): dict(k=_finite_or_none(k_m.get(m, np.nan)),
                                          lo=_finite_or_none(km_lo[m - 1]), hi=_finite_or_none(km_hi[m - 1]))
                             for m in range(1, 13)},
        viirs_only_share_of_viirs_era_events=float((ev[ev.date >= first_full].source == "VIIRS").mean()))

    if apply:
        pre = (ev.date < first_full) & (ev.source == "MODIS")
        kmap = ev.loc[pre, "date"].dt.month.map(lambda m: k_m.get(m, np.nan)).fillna(k_global)
        ev.loc[pre, "adjusted_count"] = kmap.values
    return ev, cal, mon, ov


def finalize_events(ev: pd.DataFrame) -> pd.DataFrame:
    """Select, round, type-cast and sort the final event table.

    Args:
        ev: Events with ``adjusted_count``.

    Returns:
        Table with exactly the ``OUTPUT_COLUMNS``, sorted by date and cell.
    """
    out = ev[OUTPUT_COLUMNS].copy()
    out["lat"] = out.lat.round(5)
    out["lon"] = out.lon.round(5)
    out["frp"] = out.frp.round(2)
    for col in ("n_modis", "n_viirs", "n_detections"):
        out[col] = out[col].astype("int16")
    out["adjusted_count"] = out.adjusted_count.astype("float32")
    return out.sort_values(["date", "cell_id"]).reset_index(drop=True)


def validate_events(out: pd.DataFrame) -> None:
    """Run the integrity checks on the harmonized table (fail loudly).

    Checks: unique cell-day, exact schema, no nulls, coordinates inside the AOI, allowed
    confidence classes and sources, consistent detection counts.

    Args:
        out: Final event table.

    Raises:
        AssertionError: If any check fails.
    """
    _check(not out.duplicated(["cell_id", "date"]).any(), "duplicate cell-day")
    _check(list(out.columns) == OUTPUT_COLUMNS, "output schema changed")
    _check(bool(out[OUTPUT_COLUMNS].notna().all().all()), "nulls")
    _check(bool(out.lat.between(AOI["lat_min"], AOI["lat_max"]).all()
                and out.lon.between(AOI["lon_min"], AOI["lon_max"]).all()), "coordinates outside AOI")
    _check(set(out.confidence_class) <= set(KEEP_CLASSES), "unexpected confidence class")
    _check(set(out.source) <= {"MODIS", "VIIRS", "BOTH"}, "unexpected source")
    _check(bool((out.n_detections == out.n_modis + out.n_viirs).all() and (out.n_detections >= 1).all()),
           "detection counts")
    _check(bool((out.source.eq("BOTH") == ((out.n_modis > 0) & (out.n_viirs > 0))).all()),
           "source/count mismatch")


def save_harmonized(out: pd.DataFrame, qa: Dict[str, Any], mon: pd.DataFrame,
                    funnel: Dict[str, Dict[str, int]], mask_cells: Set[str], output_dir: Path) -> None:
    """Write the harmonized table, QA report and QA tables.

    Args:
        out: Final event table.
        qa: QA dictionary.
        mon: Monthly event table from the calibration step.
        funnel: Record counts per sensor and stage.
        mask_cells: Static / offshore cells.
        output_dir: Destination folder.

    Raises:
        OSError: If a file cannot be written.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    out.to_csv(output_dir / "harmonized_fires.csv.gz", index=False, compression="gzip")
    written = _write_parquet_or_csv(out, output_dir / "harmonized_fires.parquet")
    logger.info("  wrote %s", written.name)

    qdir = output_dir / "qa_tables"
    qdir.mkdir(exist_ok=True)
    mon.assign(month=mon.index.astype(str)).to_csv(qdir / "monthly_events_by_detection.csv", index=False)
    pd.DataFrame(funnel).to_csv(qdir / "funnel.csv")
    pd.DataFrame({"cell_id": sorted(mask_cells)}).to_csv(qdir / "static_mask_cells.csv", index=False)
    with open(output_dir / "qa_report.json", "w", encoding="utf-8") as fh:
        json.dump(qa, fh, indent=2, default=str)


def log_harmonization_summary(qa: Dict[str, Any]) -> None:
    """Log the headline harmonization QA numbers.

    Args:
        qa: QA dictionary produced by ``run_harmonization``.
    """
    logger.info("---------------- HARMONIZATION SUMMARY ----------------")
    logger.info("raw rows      : %s", qa["raw_rows"])
    logger.info("final events  : %s %s", qa["events"], qa["events_by_source"])
    logger.info("date range    : %s", qa["date_range"])
    logger.info("mask holdout  : %s", {k: (round(v, 3) if v is not None else None)
                                       for k, v in qa["mask_holdout"].items() if k != "n_test"})
    cal = qa.get("calibration")
    if cal:
        logger.info("overlap       : %s -> %s (%d months)  r=%.3f", cal["overlap_from"], cal["overlap_to"],
                    cal["n_months"], cal["pearson_r_monthly"])
        logger.info("k_global      : %.2f (90%% CI %.2f-%.2f)  applied=%s", cal["k_global"],
                    *cal["k_global_90ci"], qa["calibration_applied"])
    logger.info("integrity     : %s", qa["integrity_checks"])


def run_harmonization(cfg: PipelineConfig) -> HarmonizationResult:
    """Execute stage A: raw FIRMS CSVs -> harmonized, de-duplicated fire events.

    Args:
        cfg: Pipeline configuration.

    Returns:
        ``HarmonizationResult`` with events, QA dictionary and data coverage dates.

    Raises:
        FileNotFoundError: If no input CSV exists.
        ValueError: If an input file is malformed.
        PipelineError: If no detection survives the filters.
        AssertionError: If an integrity check fails.
        OSError: If an output file cannot be written.
    """
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    qa: Dict[str, Any] = {"config": dict(
        AOI=AOI, GRID_M=GRID_M, UTM_ZONE=UTM_ZONE, MODIS_NOMINAL_MIN=MODIS_NOMINAL_MIN,
        MODIS_HIGH_MIN=MODIS_HIGH_MIN, MASK_MIN_NONVEG=MASK_MIN_NONVEG, MASK_MIN_SHARE=MASK_MIN_SHARE)}

    logger.info("[1/6] Loading")
    raw_all = load_firms(cfg.input_dir)
    qa["raw_rows"] = raw_all.groupby("sensor").size().to_dict()

    logger.info("[2/6] Cleaning and gridding (UTM %dN, %d m)", UTM_ZONE, GRID_M)
    clean, clean_stats = clean_detections(raw_all)
    if clean.empty:
        raise PipelineError("No valid detections inside the AOI after cleaning.")
    qa.update(clean_stats)
    gridded = grid_detections(clean)
    coverage_start = gridded["date"].min()
    coverage_end = gridded.groupby("sensor")["date"].max().min()   # conservative: both sensors

    logger.info("[3/6] Static-source / offshore mask")
    mask_cells, holdout = learn_static_mask(gridded)
    qa["mask_cells"] = len(mask_cells)
    qa["mask_holdout"] = holdout

    logger.info("[4/6] Filtering")
    kept, removed, funnel, n_low = filter_detections(gridded, mask_cells, qa["raw_rows"])
    qa["conf_class_dropped_low"] = n_low

    logger.info("[5/6] De-duplication -> fire events (1 km cell x 1 UTC day)")
    ev = build_events(kept)
    qa["events"] = int(len(ev))
    qa["events_by_source"] = ev["source"].value_counts().to_dict()
    qa["detections_per_event_mean"] = float(ev.n_detections.mean())
    qa["multi_detection_events_pct"] = float((ev.n_detections > 1).mean() * 100)

    logger.info("[6/6] Overlap diagnostics / calibration")
    ev, cal, mon, ov = calibrate_sensitivity(ev, kept, cfg.calibrate)
    qa["calibration"] = cal
    qa["calibration_applied"] = bool(cfg.calibrate and cal is not None)
    qa["funnel"] = funnel

    out = finalize_events(ev)
    validate_events(out)
    qa["date_range"] = [str(out.date.min().date()), str(out.date.max().date())]
    qa["integrity_checks"] = "passed"

    save_harmonized(out, qa, mon, funnel, mask_cells, cfg.output_dir)
    if cfg.make_plots:
        try:
            make_figures(cfg.output_dir, raw_all, kept, ev, removed, ov, cal, funnel)
        except Exception as exc:  # noqa: BLE001 - figures are optional (e.g. matplotlib missing)
            logger.warning("Figures skipped (%s: %s)", type(exc).__name__, exc)
    log_harmonization_summary(qa)
    return HarmonizationResult(out, qa, coverage_start, coverage_end)


def load_existing_harmonized(output_dir: Path) -> HarmonizationResult:
    """Load a previously written harmonized table instead of re-running stage A.

    Args:
        output_dir: Folder containing ``harmonized_fires.parquet`` or ``.csv.gz``.

    Returns:
        ``HarmonizationResult``; coverage dates are the first/last event day (which can
        under-state coverage by a few days at the end).

    Raises:
        FileNotFoundError: If neither file exists.
        PipelineError: If the table is empty or has the wrong schema.
    """
    parquet, csv_gz = output_dir / "harmonized_fires.parquet", output_dir / "harmonized_fires.csv.gz"
    if parquet.exists():
        try:
            events = pd.read_parquet(parquet)
        except ImportError:
            events = pd.read_csv(csv_gz) if csv_gz.exists() else None
            if events is None:
                raise
    elif csv_gz.exists():
        events = pd.read_csv(csv_gz)
    else:
        raise FileNotFoundError(f"No harmonized_fires.parquet / .csv.gz in '{output_dir}'. Run without --skip-harmonize.")
    events.columns = [str(c).strip().lower() for c in events.columns]
    events["date"] = pd.to_datetime(events["date"], errors="coerce")
    events = events.dropna(subset=["date"])
    if events.empty or not set(OUTPUT_COLUMNS) <= set(events.columns):
        raise PipelineError("Existing harmonized file is empty or does not match the expected schema.")
    logger.warning("Coverage taken from first/last event day (stage A skipped)")
    return HarmonizationResult(events[OUTPUT_COLUMNS], {}, events["date"].min(), events["date"].max())


# ----------------------------------------------------------------------------
# STAGE B - ANALYTICS (monthly statistics, climatology, Z-score, frontend export)
# ----------------------------------------------------------------------------
def aggregate_monthly(events: pd.DataFrame, coverage_start: pd.Timestamp,
                      coverage_end: pd.Timestamp) -> pd.DataFrame:
    """Aggregate events per (year, month) and flag months fully covered by the data.

    ``fire_count`` is the sum of ``adjusted_count`` (a series consistent across sensors);
    ``total_frp`` is the sum of the event FRP (MW; descriptive only, not comparable
    between sensors).

    Args:
        events: Harmonized events with ``date``, ``adjusted_count`` and ``frp``.
        coverage_start: First day covered by the input data.
        coverage_end: Last day covered by the input data.

    Returns:
        Table with columns year, month, fire_count, total_frp, is_complete.

    Raises:
        PipelineError: If ``events`` is empty or lacks required columns.
    """
    needed = {"date", "adjusted_count", "frp"}
    if events.empty or not needed <= set(events.columns):
        raise PipelineError(f"Analytics needs a non-empty table with columns {sorted(needed)}")
    df = events[["date", "adjusted_count", "frp"]].copy()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["frp"] = pd.to_numeric(df["frp"], errors="coerce")
    df["adjusted_count"] = pd.to_numeric(df["adjusted_count"], errors="coerce").fillna(1.0)
    df = df.dropna(subset=["date"])
    df["year"] = df["date"].dt.year
    df["month"] = df["date"].dt.month

    monthly = (df.groupby(["year", "month"])
               .agg(fire_count=("adjusted_count", "sum"), total_frp=("frp", "sum"))
               .reset_index())
    monthly["fire_count"] = monthly["fire_count"].astype(float)
    start = pd.to_datetime(dict(year=monthly.year, month=monthly.month, day=1))
    end = start + pd.offsets.MonthEnd(0)
    monthly["is_complete"] = ((start >= pd.Timestamp(coverage_start).normalize())
                              & (end <= pd.Timestamp(coverage_end).normalize()))
    return monthly


def add_climatology_and_zscore(monthly: pd.DataFrame) -> pd.DataFrame:
    """Add the historical mean / std per calendar month and the anomaly Z-score.

    The baseline uses complete months only. ``z_score = (fire_count - historical_mean) /
    historical_std``; it is null for incomplete months, when the std is 0 or when fewer
    than ``MIN_BASELINE_YEARS`` complete months exist for that calendar month.

    Args:
        monthly: Output of ``aggregate_monthly``.

    Returns:
        Copy with added columns historical_mean, historical_std, z_score.
    """
    out = monthly.copy()
    base = out[out["is_complete"]].groupby("month")["fire_count"].agg(["mean", "std", "count"])
    out["historical_mean"] = out["month"].map(base["mean"])
    out["historical_std"] = out["month"].map(base["std"])
    n_base = out["month"].map(base["count"]).fillna(0)
    z = (out["fire_count"] - out["historical_mean"]) / out["historical_std"].replace(0, np.nan)
    out["z_score"] = z.where(out["is_complete"] & (n_base >= MIN_BASELINE_YEARS))
    return out


def export_frontend(monthly: pd.DataFrame, events: pd.DataFrame, frontend_dir: Path) -> Dict[str, Path]:
    """Write ``calendar.json``, ``monthly_statistics.csv`` and the merged event parquet.

    ``calendar.json`` is a list of monthly records (indent 4, NaN written as null), the
    same layout the analytics script produced.

    Args:
        monthly: Monthly table with climatology and Z-score.
        events: Harmonized events (with extra ``year`` and ``month`` columns exported).
        frontend_dir: Destination folder (created if missing).

    Returns:
        Mapping of export name to the path actually written.

    Raises:
        OSError: If a file cannot be written.
    """
    frontend_dir.mkdir(parents=True, exist_ok=True)
    cols = ["year", "month", "fire_count", "total_frp", "historical_mean", "historical_std",
            "z_score", "is_complete"]
    table = monthly[cols].copy()

    csv_path = frontend_dir / "monthly_statistics.csv"
    table.to_csv(csv_path, index=False)

    json_path = frontend_dir / "calendar.json"
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(_to_records(table.round(4)), fh, indent=4, default=str)

    merged = events.copy()
    merged["date"] = pd.to_datetime(merged["date"])
    merged["year"] = merged["date"].dt.year
    merged["month"] = merged["date"].dt.month
    parquet_path = _write_parquet_or_csv(merged, frontend_dir / "harmonized_fires_merged.parquet")
    return {"monthly_statistics": csv_path, "calendar": json_path, "merged_events": parquet_path}


def run_analytics(result: HarmonizationResult, cfg: PipelineConfig) -> pd.DataFrame:
    """Execute stage B: monthly aggregation, climatology, Z-score and frontend export.

    Args:
        result: Output of stage A (or ``load_existing_harmonized``).
        cfg: Pipeline configuration.

    Returns:
        The monthly statistics table that was exported.

    Raises:
        PipelineError: If the harmonized table cannot be aggregated.
        OSError: If an export cannot be written.
    """
    logger.info("[B] Analytics: monthly statistics, climatology, Z-score")
    monthly = aggregate_monthly(result.events, result.coverage_start, result.coverage_end)
    monthly = add_climatology_and_zscore(monthly)
    paths = export_frontend(monthly, result.events, cfg.frontend_dir)
    scored = int(monthly["z_score"].notna().sum())
    flagged = monthly.loc[monthly["z_score"].abs() >= 2, ["year", "month", "z_score"]]
    logger.info("monthly rows  : %d (%d scored, %d incomplete)", len(monthly), scored,
                int((~monthly["is_complete"]).sum()))
    logger.info("|Z| >= 2      : %d month(s)", len(flagged))
    for name, path in paths.items():
        logger.info("  wrote %-18s %s", name, path)
    return monthly


# ----------------------------------------------------------------------------
# FIGURES (before / after, calibration)
# ----------------------------------------------------------------------------
def _complete_year_range(first_ts: Any, last_ts: Any) -> Optional[Tuple[int, int]]:
    """Return the first and last calendar year fully covered by the data.

    Example: data from 20 Jan 2012 to 10 Nov 2026 -> ``(2013, 2025)``.

    Args:
        first_ts: First timestamp of the data.
        last_ts: Last timestamp of the data.

    Returns:
        ``(first_year, last_year)`` or None if no complete year exists.
    """
    first_ts, last_ts = pd.Timestamp(first_ts), pd.Timestamp(last_ts)
    y0 = first_ts.year if (first_ts.month, first_ts.day) == (1, 1) else first_ts.year + 1
    y1 = last_ts.year if (last_ts.month, last_ts.day) == (12, 31) else last_ts.year - 1
    return (y0, y1) if y1 >= y0 else None


def make_figures(outdir: Path, raw_all: pd.DataFrame, kept: pd.DataFrame, ev: pd.DataFrame,
                 removed: pd.DataFrame, ov: Optional[pd.DataFrame], cal: Optional[Dict[str, Any]],
                 funnel: Dict[str, Dict[str, int]]) -> None:
    """Write ``before_after.png`` and (if calibration exists) ``calibration_overlap.png``.

    matplotlib is imported here so the pipeline also runs without it when plots are off.

    Args:
        outdir: Destination folder.
        raw_all: Every loaded detection (the BEFORE view).
        kept: Detections that survived the filters.
        ev: Final events (the AFTER view).
        removed: Detections dropped by the static mask.
        ov: Overlap-period monthly table, or None.
        cal: Calibration dictionary, or None.
        funnel: Record counts per sensor and stage.

    Raises:
        ImportError: If matplotlib is not installed.
        OSError: If a figure cannot be saved.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.gridspec as gs
    import matplotlib.pyplot as plt

    colors = {"MODIS": "#E07B00", "VIIRS": "#1F6FB2", "BOTH": "#2E8B57"}
    raw_all = raw_all.copy()
    raw_all["month"] = raw_all["dt_utc"].dt.tz_localize(None).dt.to_period("M")
    rm = raw_all.groupby(["month", "sensor"]).size().unstack(fill_value=0)
    for s in ("MODIS", "VIIRS"):
        if s not in rm:
            rm[s] = 0
    idx = pd.period_range(rm.index.min(), rm.index.max(), freq="M")
    rm = rm.reindex(idx, fill_value=0)
    t = idx.to_timestamp()
    v_dt = raw_all.loc[raw_all.sensor == "VIIRS", "dt_utc"]
    v_first = v_dt.min().tz_localize(None) if len(v_dt) else None

    fig = plt.figure(figsize=(15, 13))
    grid = gs.GridSpec(3, 3, figure=fig, height_ratios=[1, 1, 1.15], hspace=0.42, wspace=0.28)

    ax = fig.add_subplot(grid[0, :])
    for s in ("MODIS", "VIIRS"):
        ax.plot(t, rm[s].values, color=colors[s], lw=1.3, label=f"{s} raw detections")
    if v_first is not None:
        ax.axvline(v_first, color="gray", ls="--", lw=1)
        ax.text(v_first - pd.Timedelta(days=120), ax.get_ylim()[1] * 0.90,
                f"VIIRS starts ({v_first:%b %Y}) \u2192", color="gray", fontsize=9, ha="right")
    ax.set_title("BEFORE - raw FIRMS detections per month: different sensors, static flares, duplicates, "
                 "low confidence", loc="left", fontweight="bold", fontsize=11)
    ax.set_ylabel("detections / month")
    ax.legend(loc="upper left", frameon=False)
    ax.grid(alpha=.25)

    ax = fig.add_subplot(grid[1, :], sharex=ax)
    me = ev.groupby(["month", "source"]).size().unstack(fill_value=0).reindex(idx, fill_value=0)
    for c_ in ("MODIS", "VIIRS", "BOTH"):
        if c_ not in me:
            me[c_] = 0
    ax.stackplot(t, me["MODIS"], me["VIIRS"], me["BOTH"],
                 colors=[colors["MODIS"], colors["VIIRS"], colors["BOTH"]], alpha=.9,
                 labels=["event seen by MODIS only", "event seen by VIIRS only",
                         "event seen by both (counted once)"])
    if v_first is not None:
        ax.axvline(v_first, color="gray", ls="--", lw=1)
    ax.set_title("AFTER - harmonized fire events (1 km cell x 1 day): vegetation fires only, "
                 "nominal+high confidence, de-duplicated", loc="left", fontweight="bold", fontsize=11)
    ax.set_ylabel("events / month")
    ax.legend(loc="upper left", frameon=False)
    ax.grid(alpha=.25)

    ax = fig.add_subplot(grid[2, 0])
    yr = _complete_year_range(v_dt.min(), v_dt.max()) if len(v_dt) else None
    if yr:
        y0, y1 = yr
        n_years = y1 - y0 + 1
        rv = raw_all[(raw_all.sensor == "VIIRS") & raw_all.dt_utc.dt.year.between(y0, y1)]
        ev_v = ev[(ev.n_viirs > 0) & ev.date.dt.year.between(y0, y1)]
        before = rv.groupby(rv.dt_utc.dt.month).size() / n_years
        after = ev_v.groupby(ev_v.date.dt.month).size() / n_years
        ax.bar(np.arange(1, 13) - 0.2, before.reindex(range(1, 13), fill_value=0), 0.4,
               color="#9bb7d4", label="before (raw VIIRS)")
        ax.bar(np.arange(1, 13) + 0.2, after.reindex(range(1, 13), fill_value=0), 0.4,
               color=colors["VIIRS"], label="after (events)")
        ax.set_xticks(range(1, 13))
        ax.set_title(f"Seasonal profile {y0}-{y1}\n(mean per month)", fontsize=10, loc="left", fontweight="bold")
    else:
        ax.text(0.5, 0.5, "No complete VIIRS\ncalendar year yet", ha="center", va="center",
                transform=ax.transAxes)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_title("Seasonal profile\n(mean per month)", fontsize=10, loc="left", fontweight="bold")
    ax.set_xlabel("month")
    ax.legend(frameon=False, fontsize=8)
    ax.grid(alpha=.25, axis="y")

    ax = fig.add_subplot(grid[2, 1])
    kp = kept[kept.sensor == "VIIRS"]
    ax.scatter(kp.lon, kp.lat, s=0.3, c=colors["VIIRS"], alpha=.25, rasterized=True,
               label="kept (vegetation fires)")
    rp = removed[removed.sensor == "VIIRS"] if len(removed) else removed
    if len(rp):
        ax.scatter(rp.lon, rp.lat, s=0.6, c="#d62728", alpha=.5, rasterized=True,
                   label="removed (static/offshore cells)")
    ax.set_title("Where the static-source mask acts\n(VIIRS detections, all years)", fontsize=10,
                 loc="left", fontweight="bold")
    ax.set_xlabel("lon")
    ax.set_ylabel("lat")
    ax.set_aspect(1 / np.cos(np.radians(30.8)))
    ax.legend(frameon=True, framealpha=0.9, fontsize=8, markerscale=12, loc="lower left")

    ax = fig.add_subplot(grid[2, 2])
    stages = ["1_raw_loaded", "2_valid_in_aoi_deduped", "3_conf_nominal_high", "4_type_vegetation_only",
              "5_outside_static_mask"]
    labels = ["raw", "valid\nin AOI", "nominal\n+high", "type =\nveg.", "outside\nstatic\nmask", "events\n(cell-day)"]
    tot = [sum(funnel[s][st] for s in funnel) for st in stages] + [len(ev)]
    ax.bar(range(len(tot)), tot, color=["#999"] * 5 + ["#2E8B57"])
    for i, v in enumerate(tot):
        ax.text(i, v, f"{v:,}", ha="center", va="bottom", fontsize=8)
    ax.set_xticks(range(len(tot)))
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_title("Record funnel (MODIS + VIIRS)", fontsize=10, loc="left", fontweight="bold")
    ax.set_ylim(0, max(tot) * 1.12)
    ax.grid(alpha=.25, axis="y")
    fig.savefig(outdir / "before_after.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    if cal is None or ov is None:
        return
    fig, axs = plt.subplots(1, 3, figsize=(15, 4.6), gridspec_kw=dict(wspace=0.3))
    ax = axs[0]
    ax.scatter(ov.modis_detected, ov.events, c=ov.calmonth, cmap="twilight", s=22)
    xx = np.linspace(0, ov.modis_detected.max(), 50)
    ax.plot(xx, cal["k_global"] * xx, "k--", lw=1, label=f"k = {cal['k_global']:.2f}")
    ax.set_xlabel("events detected by MODIS (month)")
    ax.set_ylabel("all merged events (month)")
    ax.set_title(f"Overlap {cal['overlap_from']} to {cal['overlap_to']}\nr = {cal['pearson_r_monthly']:.2f}",
                 loc="left", fontsize=10, fontweight="bold")
    ax.legend(frameon=False)
    ax.grid(alpha=.25)

    ax = axs[1]
    ks = cal["k_by_calendar_month"]
    mm = np.arange(1, 13)
    kv = np.array([np.nan if ks[m]["k"] is None else ks[m]["k"] for m in mm])
    lo = np.array([np.nan if ks[m]["lo"] is None else ks[m]["lo"] for m in mm])
    hi = np.array([np.nan if ks[m]["hi"] is None else ks[m]["hi"] for m in mm])
    ax.errorbar(mm, kv, yerr=[kv - lo, hi - kv], fmt="o", color="#1F6FB2", capsize=3)
    ax.axhline(cal["k_global"], color="k", ls="--", lw=1)
    ax.set_xticks(mm)
    ax.set_xlabel("calendar month")
    ax.set_ylabel("k = merged events / MODIS events")
    ax.set_title("Sensitivity ratio by month (90% bootstrap CI)", loc="left", fontsize=10, fontweight="bold")
    ax.grid(alpha=.25)

    ax = axs[2]
    ann = ov.groupby("year")[["events", "modis_detected"]].sum()
    ax.plot(ann.index, ann.events / ann.modis_detected, "o-", color="#2E8B57")
    ax.set_xlabel("year")
    ax.set_ylabel("annual k")
    ax.set_title("Is k stable over time?", loc="left", fontsize=10, fontweight="bold")
    ax.grid(alpha=.25)
    fig.savefig(outdir / "calibration_overlap.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


# ----------------------------------------------------------------------------
# ORCHESTRATION + CLI
# ----------------------------------------------------------------------------
def run_pipeline(cfg: PipelineConfig) -> Tuple[HarmonizationResult, pd.DataFrame]:
    """Run the full pipeline: stage A (harmonization) then stage B (analytics).

    Args:
        cfg: Pipeline configuration.

    Returns:
        Tuple ``(harmonization_result, monthly_statistics)``.

    Raises:
        FileNotFoundError: If required input files are missing.
        ValueError: If an input file is malformed.
        PipelineError: If a stage produces no usable data.
        AssertionError: If a harmonization integrity check fails.
        OSError: If an output cannot be written.
    """
    started = time.time()
    logger.info("=" * 60)
    logger.info("PyroLens pipeline started  (input=%s, output=%s)", cfg.input_dir, cfg.output_dir)
    logger.info("=" * 60)
    result = load_existing_harmonized(cfg.output_dir) if cfg.skip_harmonize else run_harmonization(cfg)
    monthly = run_analytics(result, cfg)
    logger.info("Pipeline finished in %.1f s", time.time() - started)
    return result, monthly


def build_arg_parser() -> argparse.ArgumentParser:
    """Create the command-line argument parser.

    Returns:
        The configured ``ArgumentParser``.
    """
    ap = argparse.ArgumentParser(description="PyroLens (offline): FIRMS MODIS+VIIRS harmonization and anomaly export.")
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT_DIR,
                    help=f"folder with the FIRMS CSVs (default {DEFAULT_INPUT_DIR})")
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR,
                    help=f"output folder (default {DEFAULT_OUTPUT_DIR})")
    ap.add_argument("--frontend-dir", type=Path, default=None,
                    help="folder for calendar.json etc. (default <output>/frontend)")
    ap.add_argument("--no-calibrate", action="store_true", help="adjusted_count = 1 everywhere")
    ap.add_argument("--no-plots", action="store_true", help="skip the PNG figures")
    ap.add_argument("--skip-harmonize", action="store_true",
                    help="reuse the harmonized file already in --output and run only the analytics stage")
    ap.add_argument("--log-level", default="INFO", help="DEBUG, INFO, WARNING or ERROR")
    return ap


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Command-line entry point.

    Args:
        argv: Argument list (defaults to ``sys.argv[1:]``).

    Returns:
        Process exit code: 0 on success, 1 on a controlled failure.
    """
    args = build_arg_parser().parse_args(argv)
    configure_logging(args.log_level)
    cfg = PipelineConfig(
        input_dir=args.input, output_dir=args.output, calibrate=not args.no_calibrate,
        make_plots=not args.no_plots, skip_harmonize=args.skip_harmonize,
        frontend_dir=args.frontend_dir)
    try:
        run_pipeline(cfg)
    except (FileNotFoundError, ValueError, PipelineError, AssertionError, OSError) as exc:
        logger.error("Pipeline failed: %s: %s", type(exc).__name__, exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

