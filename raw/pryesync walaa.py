from pathlib import Path   # مكتبة pathlib (جاهزة مع بايثون)
import pandas as pd        # مكتبة pandas
import numpy as np         # مكتبة numpy

print("=" * 50)
print("PyreSync Analytics Started!")
print("=" * 50)

# 1. Create project folders
DATA_DIR = Path(r"C:\Users\Tech Market\OneDrive\Desktop\PyroLens\public\data")
OUTPUT_DIR = Path(r"C:\Users\Tech Market\OneDrive\Desktop\New folder (2)\output")

DATA_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# 2. Find ALL parquet files inside data/ (any name)
parquet_files = sorted(DATA_DIR.glob("*.parquet"))

if not parquet_files:
    raise FileNotFoundError(
        "No parquet files found! Put your Parquet files inside data/."
    )

print("\nFiles found:")
for f in parquet_files:
    print(" -", f.name)

# 3. Read all datasets
datasets = []

for file_path in parquet_files:

    print(f"\nLoading: {file_path.name}")

    data = pd.read_parquet(file_path)

    # Normalize column names
    data.columns = [str(col).strip().lower() for col in data.columns]

    print("Dataset shape:", data.shape)
    print("Columns:", data.columns.tolist())

    # Skip files that don't have the required columns
    if "date" not in data.columns or "frp" not in data.columns:
        print(f"WARNING: {file_path.name} skipped (needs 'date' and 'frp' columns)")
        continue

    data["dataset_source"] = file_path.name
    datasets.append(data)

if not datasets:
    raise ValueError("No valid datasets (with 'date' and 'frp' columns) were loaded.")

# 4. Combine datasets
df = pd.concat(datasets, ignore_index=True, sort=False)
print("\nCombined dataset shape:", df.shape)

# 5. Prepare data types
df["date"] = pd.to_datetime(df["date"], errors="coerce")
df["frp"] = pd.to_numeric(df["frp"], errors="coerce")

# If adjusted_count does not exist, count each detection as 1
if "adjusted_count" not in df.columns:
    df["adjusted_count"] = 1

df["adjusted_count"] = pd.to_numeric(
    df["adjusted_count"], errors="coerce"
).fillna(1)

# 6. Remove invalid dates
df = df.dropna(subset=["date"]).copy()

# 7. Remove duplicate records
#    (ignore dataset_source so overlap between files is detected)
before = len(df)

cols_for_dedup = [c for c in df.columns if c != "dataset_source"]
df = df.drop_duplicates(subset=cols_for_dedup, keep="first")

after = len(df)
print("\nDuplicate records removed:", before - after)

# 8. Extract year and month
df["year"] = df["date"].dt.year
df["month"] = df["date"].dt.month

# 9. Monthly fire statistics
monthly = (
    df.groupby(["year", "month"])
    .agg(
        fire_count=("adjusted_count", "sum"),
        total_frp=("frp", "sum")
    )
    .reset_index()
)

# 10. Historical mean / std per month
monthly["historical_mean"] = monthly.groupby("month")["fire_count"].transform("mean")
monthly["historical_std"] = monthly.groupby("month")["fire_count"].transform("std")

# 11. Anomaly Z-score
monthly["z_score"] = (
    (monthly["fire_count"] - monthly["historical_mean"])
    / monthly["historical_std"].replace(0, np.nan)
)

# 12. Save outputs
df.to_parquet(OUTPUT_DIR / "harmonized_fires_merged.parquet", index=False)
monthly.to_csv(OUTPUT_DIR / "monthly_statistics.csv", index=False)
monthly.to_json(
    OUTPUT_DIR / "calendar.json",
    orient="records",
    date_format="iso",
    indent=4
)

# 13. Final results
print("\n" + "=" * 50)
print("PYRESYNC ANALYTICS COMPLETED")
print("=" * 50)

print("\nDatasets loaded:", len(datasets))
print("Rows per source:")
print(df["dataset_source"].value_counts().to_string())
print("Final dataset shape:", df.shape)
print("Monthly statistics shape:", monthly.shape)

print("\nMonthly statistics:")
print(monthly.head(12).to_string(index=False))

print("\nFiles saved successfully:")
print("- output/harmonized_fires_merged.parquet")
print("- output/monthly_statistics.csv")
print("- output/calendar.json")
print("=" * 50)