from pathlib import Path
import pandas as pd
import numpy as np

print("PyroLens Analytics Started!")

# Create project folders if they don't exist
Path("data").mkdir(exist_ok=True)
Path("output").mkdir(exist_ok=True)

# Check whether Ibrahim's real dataset is available
file_path = Path("data/harmonized_fires.parquet")
using_real_data = file_path.exists()

if using_real_data:
    df = pd.read_parquet(file_path)
    print("Real project dataset loaded.")
    print("Rows and columns:", df.shape)

else:
    print("Real dataset not received yet.")
    print("Creating SAMPLE data for testing only...")

    np.random.seed(42)

    records = []

    # Generate sample fire detections for 2022-2025
    for year in range(2022, 2026):
        for month in range(1, 13):

            # More sample detections in autumn
            number_of_fires = 20
            if month in [9, 10, 11]:
                number_of_fires = 45

            for _ in range(number_of_fires):
                day = np.random.randint(1, 29)  # days 1..28

                records.append({
                    "date": pd.Timestamp(year, month, day),
                    "lat": np.random.uniform(29.5, 31.5),
                    "lon": np.random.uniform(29.5, 32.5),
                    "source": np.random.choice(["MODIS", "VIIRS"]),
                    "frp": round(np.random.uniform(1, 50), 2),
                    "confidence_class": np.random.choice(
                        ["low", "nominal", "high"]
                    ),
                    "adjusted_count": 1
                })

    df = pd.DataFrame(records)

# Make sure the required columns exist
required_columns = ["date", "frp", "adjusted_count"]
missing = [c for c in required_columns if c not in df.columns]
if missing:
    raise ValueError(
        f"Missing columns: {missing}. Available columns: {list(df.columns)}"
    )

# Make sure the date column is a date
df["date"] = pd.to_datetime(df["date"])

# Extract year and month
df["year"] = df["date"].dt.year
df["month"] = df["date"].dt.month

# Calculate monthly fire statistics
monthly = (
    df.groupby(["year", "month"])
    .agg(
        fire_count=("adjusted_count", "sum"),
        total_frp=("frp", "sum")
    )
    .reset_index()
)

# Calculate historical average and standard deviation
monthly["historical_mean"] = (
    monthly.groupby("month")["fire_count"]
    .transform("mean")
)

monthly["historical_std"] = (
    monthly.groupby("month")["fire_count"]
    .transform("std")
)

# Calculate anomaly Z-score
monthly["z_score"] = (
    (monthly["fire_count"] - monthly["historical_mean"])
    / monthly["historical_std"].replace(0, np.nan)
)

# Save results (file names depend on real/sample data)
suffix = "real" if using_real_data else "sample"

monthly.to_csv(
    f"output/monthly_statistics_{suffix}.csv",
    index=False
)

monthly.to_json(
    f"output/calendar_{suffix}.json",
    orient="records",
    date_format="iso",
    indent=4
)

print("\nMonthly statistics:")
print(monthly.head(12))

print(f"\nResults saved in the output folder ({suffix}).")
if not using_real_data:
    print("IMPORTANT: These are sample results, not real NASA findings.")

# -------------------------------------------------------------
# Convert the real parquet dataset to JSON
# -------------------------------------------------------------
parquet_path = Path("data/harmonized_fires.parquet")
json_path = Path("output/harmonized_fires.json")

if parquet_path.exists():
    df_real = pd.read_parquet(parquet_path)

    df_real.to_json(
        json_path,
        orient="records",    # each row = one object in a list
        date_format="iso",   # dates like 2024-10-05T00:00:00.000
        force_ascii=False,
        indent=4             # remove indent=4 if the file is very large
    )

    print("\nParquet converted to JSON:", json_path)
    print(df_real.head())
else:
    print("\nParquet file not found, JSON conversion skipped:",
          parquet_path.resolve())
