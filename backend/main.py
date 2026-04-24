"""
FairLens v12 — Universal CSV Support: Dynamic Column Detection
FastAPI + scikit-learn + Google Gemini

v11 retained (already-fair guard, is_mitigated flag, pipeline state, etc.)

v12 NEW — any-CSV support:
  §C1  PROTECTED_ATTRS: auto-detect from ["sex","gender","race","age","ethnicity"]
  §C2  TARGET_COLS: auto-detect from ["income","hired","approved","label","outcome","target"]
  §C3  /detect-columns endpoint: reads CSV, returns candidates + auto-selected defaults
  §C4  /analyze accepts optional protected_col + target_col form fields;
       falls back to auto-detection if omitted (backward-compatible)
  §C5  preprocess_dynamic(): replaces hardcoded "sex"/"income" encoding
       with column-agnostic logic — binary encode any 2-value column,
       normalise any multi-value column via sorted LabelEncoder
  §C6  _masks_dynamic(): group masks built from the actual protected column values
       (group_a = majority/reference; group_b = minority/protected)
  §C7  compute_metrics_dynamic(): same SPD/DI math, column-agnostic labels
       (male_rate → group_a_rate, female_rate → group_b_rate)
  §C8  Validation: if neither protected nor target can be found, returns
       {"error": "Dataset not suitable for fairness analysis", "columns": [...]}
       with HTTP 422 and a clear message
"""

app_version = "12.0.0"

import os, io, json, hashlib, warnings as _warnings

# Load .env file so GEMINI_API_KEY can be set there instead of
# exporting it in the shell every time.
try:
    from dotenv import load_dotenv
    load_dotenv()          # reads .env in the same directory as main.py
except ImportError:
    pass                   # python-dotenv not installed — fall back to os.environ
_warnings.filterwarnings("ignore")

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

import pandas as pd
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score

# §D1 — Global numpy legacy RNG lock.
# Locks the legacy np.random global state used by any third-party code that
# calls np.random.shuffle / np.random.choice without an explicit Generator.
# This does NOT affect code using np.random.default_rng(seed) — those are
# already deterministic. Belt-and-suspenders for complete reproducibility.
np.random.seed(42)

# ── Gemini (optional) ─────────────────────────────────────────────────────────
try:
    from google import genai as _genai
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    _gemini_client = _genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None
except Exception:
    _gemini_client = None

# ── In-memory fair dataset store ──────────────────────────────────────────────
_fair_df: pd.DataFrame | None = None

# §GUARD: Last is_mitigated value — used by /download-fixed to distinguish
# "not run yet" (None) from "already fair" (False) from "mitigated" (True)
_last_is_mitigated: bool | None = None

# §D3 — Result cache: MD5(csv_bytes) -> complete JSON result dict
# Guarantees identical inputs produce identical outputs with zero recomputation.
_result_cache: dict[str, dict] = {}

# =============================================================================
app = FastAPI(title="FairLens API v12", version="12.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

# ── Constants ─────────────────────────────────────────────────────────────────
# §B1 — Three-zone SPD safety margin (prevents flip-flopping at boundary)
SPD_SAFE        = 0.04   # |SPD| <= this → SAFE zone (clear, stable)
SPD_BORDERLINE  = 0.06   # |SPD| <= this → BORDERLINE zone (caution, monitor)
# above SPD_BORDERLINE → NOT SAFE zone

SPD_THRESHOLD = 0.05   # kept for backward compat (threshold search, early-stop)
DI_LOW        = 0.80   # DI >= this (EEOC 4/5ths rule)
DI_HIGH       = 1.25   # DI <= this (reverse-bias ceiling)
MIN_ACCURACY  = 0.70   # accuracy >= this
MAX_SEL_RATE  = 0.95   # degenerate solution guard
RANDOM_STATE  = 42     # single seed for all randomness

# §S3 — Convergence control
CONVERGENCE_DELTA    = 0.02
# §S4 — Stability test tolerance
STABILITY_TOLERANCE  = 0.01
# §S2 — Already-balanced dataset threshold
BALANCE_THRESHOLD    = 0.05
# §S6 — Overcorrection detection
OVERCORRECTION_MIN   = 0.02

# §B3 — Threshold cache: {dataset_hash -> best_female_threshold (float)}
# Once computed, the threshold is never recomputed for the same dataset.
_threshold_cache: dict[str, float] = {}

# =============================================================================
# §VALIDATION — Metric bounds guard (raised before any output is built)
# =============================================================================

def validate_metrics(spd: float, di: float, label: str = "") -> None:
    """
    §FIX-3: Hard assertion layer — raise ValueError if computed metrics are
    out of physically possible ranges. Catches inverted comparisons or
    NaN/Inf that would produce contradictory outputs.
    """
    tag = f"[{label}] " if label else ""
    if not (-1.0 <= spd <= 1.0):
        raise ValueError(f"{tag}SPD={spd:.4f} is outside valid range [-1, 1]. "
                         "Check selection rate computation.")
    if not (0.0 <= di <= 2.0):
        raise ValueError(f"{tag}DI={di:.4f} is outside valid range [0, 2]. "
                         "Check selection rate computation (division by zero?).")


def debug_fairness(spd: float, di: float, accuracy: float,
                   is_fair: bool, label: str = "") -> None:
    """
    §FIX-6: Always print a structured debug line so every decision is traceable
    in the server log without extra tooling.

    Format:
        [FairLens DEBUG][label] SPD=X.XXXX DI=X.XXXX ACC=XX.X%
            abs(SPD)<=0.05: T/F | DI>=0.80: T/F | ACC>=70%: T/F
            → fair=True/False  (all conditions met / FAILED: <which ones>)
    """
    cond_spd = abs(spd) <= SPD_THRESHOLD
    cond_di  = di       >= DI_LOW
    cond_acc = accuracy >= MIN_ACCURACY

    failed = []
    if not cond_spd: failed.append(f"abs(SPD)={abs(spd):.4f} > {SPD_THRESHOLD}")
    if not cond_di:  failed.append(f"DI={di:.4f} < {DI_LOW}")
    if not cond_acc: failed.append(f"ACC={accuracy:.4f} < {MIN_ACCURACY}")

    outcome = "all conditions met" if is_fair else f"FAILED: {'; '.join(failed)}"
    tag     = f"[{label}]" if label else ""

    print(
        f"[FairLens DEBUG]{tag} "
        f"SPD={spd:.4f}  DI={di:.4f}  ACC={accuracy*100:.1f}%\n"
        f"    abs(SPD)<={SPD_THRESHOLD}: {cond_spd} | "
        f"DI>={DI_LOW}: {cond_di} | "
        f"ACC>={MIN_ACCURACY*100:.0f}%: {cond_acc}\n"
        f"    → fair={is_fair}  ({outcome})",
        flush=True,
    )


PROXY_EXPLANATIONS = {
    "occupation":     "Occupation is historically gendered — executive roles skew male, service roles skew female.",
    "marital_status": "Marital status correlates with gender in historical labour data.",
    "hours_per_week": "Working hours correlate with caregiving burden, disproportionately borne by women.",
    "workclass":      "Employment sector distribution shows significant gender skew in historical data.",
    "capital_gain":   "Capital gains reflect wealth accumulation shaped by historical gender pay gaps.",
    "education_num":  "Educational attainment encoding may reflect past gender gaps in higher education access.",
    "relationship":   "Relationship role (husband/wife) directly encodes gender through social structure.",
}

# §C1 — Protected attribute candidates (checked in priority order)
PROTECTED_ATTR_CANDIDATES = ["sex", "gender", "race", "ethnicity", "age"]

# §C2 — Target / outcome column candidates (checked in priority order)
TARGET_COL_CANDIDATES = ["income", "hired", "approved", "label", "outcome", "target", "result"]

# §C6 — For each protected attribute, which values map to group_a (reference)
# and group_b (protected/minority). Keys are lower-cased column values.
# group_a = the historically advantaged group (SPD computed as group_b - group_a)
_GROUP_A_VALUES = {
    "sex":       {"male", "m", "1"},
    "gender":    {"male", "m", "man", "1"},
    "race":      {"white", "caucasian", "1"},
    "ethnicity": {"white", "caucasian", "non-hispanic", "1"},
    "age":       set(),   # age is continuous — handled specially
}
_GROUP_B_VALUES = {
    "sex":       {"female", "f", "0", "woman", "women"},
    "gender":    {"female", "f", "woman", "0"},
    "race":      {"black", "african american", "hispanic", "asian", "0"},
    "ethnicity": {"black", "hispanic", "asian", "0"},
    "age":       set(),
}


# =============================================================================
# SECTION 6 — DATA VALIDATION
# =============================================================================

def validate_dataframe(df: pd.DataFrame,
                       protected_col: str | None = None,
                       target_col: str | None = None) -> None:
    """
    §C8: Dynamic validation — checks resolved columns, not hardcoded 'sex'/'income'.
    When protected_col/target_col are not provided, auto-detects them.
    Raises HTTPException(422) with a clear message on failure.

    §V1  Same-column guard: protected_col must not equal target_col.
    §V2  Single-class guard: target column must encode to at least 2 distinct values.
    §V3  Minimum row count: dataset must have >= 50 rows.
    """
    if len(df) < 50:
        raise HTTPException(422, f"Dataset too small ({len(df)} rows). Need >= 50 records.")

    # resolve_columns raises 422 with a clear message if columns can't be found
    p_col, t_col = resolve_columns(df, protected_col, target_col)

    # §V1 — Same-column guard: the two roles must be different columns.
    # Checked here (after resolution) so normalised names are compared, not raw inputs.
    if p_col == t_col:
        raise HTTPException(422,
            f"Protected attribute and target must be different columns. "
            f"Both were resolved to '{p_col}'. "
            "Select a different column for each role.")

    # Verify the protected column has at least 2 distinct values
    unique_prot = df[p_col].dropna().astype(str).str.strip().unique()
    if len(unique_prot) < 2:
        raise HTTPException(422,
            f"Protected attribute column '{p_col}' must have at least 2 distinct values. "
            f"Found only: {list(unique_prot)[:5]}. "
            "This dataset cannot be used for fairness analysis.")

    # §V2 — Single-class guard: target must encode to 2 distinct binary values.
    # Use the same _encode_target logic the pipeline uses so the check matches reality.
    encoded_tgt = _encode_target(df[t_col])
    unique_encoded = set(encoded_tgt)
    if len(unique_encoded) < 2:
        raw_vals = df[t_col].dropna().astype(str).str.strip().unique().tolist()
        raise HTTPException(422,
            f"Target column '{t_col}' must contain at least 2 classes (e.g. 0/1, yes/no, >50K/<=50K). "
            f"After encoding, only class {unique_encoded} was found. "
            f"Raw values in your data: {raw_vals[:8]}. "
            "Please upload a dataset with a binary outcome column such as: "
            "hired (yes/no), approved (1/0), income (>50K/<=50K).")


def read_pipeline_state(df: pd.DataFrame) -> str:
    """
    Read the embedded _fairlens_state column from a previously exported
    corrected dataset.  Returns "RAW" if the column is absent.

    States: "RAW" | "MITIGATED" | "STABLE"

    Used by run_analysis to detect re-uploaded corrected datasets and
    prevent re-mitigation without relying solely on MD5 (which changes
    when the CSV is saved/reloaded by a spreadsheet app).
    """
    if "_fairlens_state" not in df.columns:
        return "RAW"
    states = df["_fairlens_state"].dropna().unique()
    if len(states) == 0:
        return "RAW"
    state = str(states[0]).strip().upper()
    if state in ("MITIGATED", "STABLE"):
        return state
    return "RAW"


# =============================================================================
# §C3/C4/C5/C6/C7/C8 — DYNAMIC COLUMN DETECTION & ENCODING
# =============================================================================

def detect_columns(df: pd.DataFrame) -> dict:
    """
    §C3/C8: Scan df.columns for known protected attributes and target columns.
    Returns a detection report used by /detect-columns and as a fallback
    inside /analyze when explicit columns are not provided.

    Return shape:
    {
      "protected_candidates": ["sex", "gender"],     # found in df
      "target_candidates":    ["income", "hired"],   # found in df
      "auto_protected":       "sex",                 # first match or None
      "auto_target":          "income",              # first match or None
      "all_columns":          [...],
      "suitable":             True/False,
    }
    """
    cols_lower = {c.lower().strip(): c for c in df.columns}   # lower → original

    prot_found = [cols_lower[p] for p in PROTECTED_ATTR_CANDIDATES if p in cols_lower]
    tgt_found  = [cols_lower[t] for t in TARGET_COL_CANDIDATES   if t in cols_lower]

    auto_prot = prot_found[0] if prot_found else None
    auto_tgt  = tgt_found[0]  if tgt_found  else None

    return {
        "protected_candidates": prot_found,
        "target_candidates":    tgt_found,
        "auto_protected":       auto_prot,
        "auto_target":          auto_tgt,
        "all_columns":          list(df.columns),
        "suitable":             bool(auto_prot and auto_tgt),
    }


def resolve_columns(df: pd.DataFrame,
                    protected_col: str | None,
                    target_col: str | None) -> tuple[str, str]:
    """
    §C4: Resolve which protected and target columns to use.
    If explicitly provided (from the form), validate they exist.
    Otherwise auto-detect from df.
    Raises HTTPException(422) with a clear message if neither can be found.

    §V1 — Same-column guard is applied in validate_dataframe (after resolution),
    not here, so the normalised names are compared.
    """
    detection = detect_columns(df)

    # Normalise provided names to match actual df columns (case-insensitive)
    col_map = {c.lower().strip(): c for c in df.columns}

    if protected_col:
        key = protected_col.lower().strip()
        if key not in col_map:
            raise HTTPException(422,
                f"Protected attribute column '{protected_col}' not found. "
                f"Available columns: {list(df.columns)}")
        p_col = col_map[key]
    else:
        p_col = detection["auto_protected"]

    if target_col:
        key = target_col.lower().strip()
        if key not in col_map:
            raise HTTPException(422,
                f"Target column '{target_col}' not found. "
                f"Available columns: {list(df.columns)}")
        t_col = col_map[key]
    else:
        t_col = detection["auto_target"]

    if not p_col or not t_col:
        missing = []
        if not p_col:
            missing.append(
                f"protected attribute — checked for: {PROTECTED_ATTR_CANDIDATES}. "
                "Rename your protected column to one of these, or pass 'protected_col' manually."
            )
        if not t_col:
            missing.append(
                f"target / outcome column — checked for: {TARGET_COL_CANDIDATES}. "
                "Please select a binary outcome column such as: hired, approved, income. "
                "Or pass 'target_col' manually."
            )
        raise HTTPException(422,
            f"Dataset not suitable for fairness analysis. "
            f"Could not find: {' AND '.join(missing)}. "
            f"Your columns are: {list(df.columns)}.")

    return p_col, t_col


def _encode_target(series: pd.Series) -> np.ndarray:
    """
    §C5: Binary-encode the target column.
    Priority map for positive outcome (1):
      income:  >50K, >50k., 1, yes
      hired:   1, yes, true, hired
      generic: 1, yes, true, positive, approved, accept, selected, granted
    Anything else → 0.
    If the column is already numeric 0/1, pass through directly.
    """
    POSITIVE_STRINGS = {
        ">50k", ">50k.", "1", "yes", "true", "hired", "approved",
        "accept", "accepted", "positive", "selected", "granted", "1.0",
    }
    s = series.astype(str).str.strip().str.lower()
    return s.isin(POSITIVE_STRINGS).astype(int).values


def _resolve_groups(series: pd.Series, col_name: str) -> tuple[set, set]:
    """
    §C6: For any protected attribute, determine which unique values map to
    group_a (reference/advantaged) and group_b (protected/minority).

    Strategy:
    1. Check _GROUP_A_VALUES / _GROUP_B_VALUES lookup for known columns.
    2. For unknown columns with exactly 2 unique values: the more frequent
       value becomes group_a (reference), the less frequent becomes group_b.
    3. For unknown columns with >2 values: group_a = most frequent,
       group_b = all others combined (allows multi-value protected attributes).
    """
    key = col_name.lower().strip()
    unique_vals = [str(v).strip().lower() for v in series.dropna().unique()]

    if key in _GROUP_A_VALUES:
        a_vals = _GROUP_A_VALUES[key]
        b_vals = _GROUP_B_VALUES[key]
        # Only keep values that actually appear in the data
        a_found = {v for v in unique_vals if v in a_vals}
        b_found = {v for v in unique_vals if v in b_vals}
        if a_found and b_found:
            return a_found, b_found

    # Frequency-based fallback
    freq = series.astype(str).str.strip().str.lower().value_counts()
    if len(freq) == 0:
        raise ValueError(f"Protected attribute column '{col_name}' is empty.")
    if len(freq) == 1:
        raise ValueError(
            f"Protected attribute column '{col_name}' has only one unique value "
            f"('{freq.index[0]}'). Cannot compute fairness metrics.")

    # Most frequent = group_a, rest = group_b
    group_a = {freq.index[0]}
    group_b = set(freq.index[1:])
    return group_a, group_b


def preprocess_dynamic(df: pd.DataFrame, protected_col: str, target_col: str):
    """
    §C5: Column-agnostic preprocessing.
    - Encodes target_col to binary 0/1
    - Preserves protected_col as strings for mask computation
    - Sorts by all columns (determinism)
    - LabelEncodes remaining object columns
    Returns (X, y, protected_series, feature_cols, group_a_vals, group_b_vals)
    """
    df = df.copy()
    df[protected_col] = df[protected_col].astype(str).str.strip()
    df[target_col]    = df[target_col].astype(str).str.strip()

    # §D2 — sort for determinism (sort on string values before encoding)
    df = df.sort_values(by=df.columns.tolist()).reset_index(drop=True)

    # Resolve group membership
    group_a_vals, group_b_vals = _resolve_groups(df[protected_col], protected_col)

    # Encode target
    y = _encode_target(df[target_col])
    protected_series = df[protected_col].copy()

    # Build feature matrix: drop target, protected, and known non-predictive cols
    always_drop = {"_fairlens_state", "fnlwgt", "native_country"}
    drop_cols = {target_col, protected_col} | always_drop
    feature_cols = [c for c in df.columns if c not in drop_cols]

    X = df[feature_cols].copy()
    for col in X.select_dtypes(include="object").columns:
        le = LabelEncoder()
        le.fit(sorted(X[col].astype(str).unique()))
        X[col] = le.transform(X[col].astype(str))

    X = X.fillna(X.median(numeric_only=True))
    return X, y, protected_series, feature_cols, group_a_vals, group_b_vals


def _masks_dynamic(protected: pd.Series,
                   group_a_vals: set,
                   group_b_vals: set) -> tuple[np.ndarray, np.ndarray]:
    """§C6: Build group_a / group_b boolean masks from actual column values."""
    lower = protected.astype(str).str.strip().str.lower()
    mask_a = lower.isin(group_a_vals).values
    mask_b = lower.isin(group_b_vals).values
    return mask_a, mask_b


def compute_metrics_dynamic(y_pred: np.ndarray, y_true: np.ndarray,
                             protected: pd.Series,
                             group_a_vals: set, group_b_vals: set,
                             group_a_label: str = "group_a",
                             group_b_label: str = "group_b") -> dict:
    """
    §C7: Column-agnostic fairness metrics.
    Identical math to compute_metrics; labels are parametric.
    SPD = group_b_rate - group_a_rate  (negative = group_b disadvantaged)
    DI  = group_b_rate / group_a_rate
    Also surfaces male_rate / female_rate aliases for backward compatibility.
    """
    mm, fm = _masks_dynamic(protected, group_a_vals, group_b_vals)
    n_a = int(mm.sum()); n_b = int(fm.sum())
    sel_a = float(y_pred[mm].mean()) if n_a > 0 else 0.0
    sel_b = float(y_pred[fm].mean()) if n_b > 0 else 0.0

    spd = sel_b - sel_a
    di  = sel_b / sel_a if sel_a > 0 else 0.0
    acc = float(accuracy_score(y_true, y_pred))

    bias_flag = (abs(spd) > SPD_THRESHOLD) or (di < DI_LOW) or (di > DI_HIGH)

    return {
        # Dynamic labels
        f"{group_a_label}_rate": round(sel_a, 3),
        f"{group_b_label}_rate": round(sel_b, 3),
        # Backward-compat aliases (frontend always reads these)
        "male_rate":         round(sel_a, 3),
        "female_rate":       round(sel_b, 3),
        "spd":               round(spd,   3),
        "di":                round(di,    3),
        "accuracy":          round(acc,   3),
        "spd_zone":          spd_zone(spd),
        "bias_flag":         bool(bias_flag),
        "n_male":            n_a,
        "n_female":          n_b,
        f"n_{group_a_label}": n_a,
        f"n_{group_b_label}": n_b,
        "n_selected_male":   int(y_pred[mm].sum()),
        "n_selected_female": int(y_pred[fm].sum()),
        # Column metadata so the frontend can render dynamic labels
        "group_a_label": group_a_label,
        "group_b_label": group_b_label,
    }


# =============================================================================
# PREPROCESSING
# =============================================================================

def preprocess(df: pd.DataFrame):
    """
    §D2: Sort dataset by ALL columns before any encoding or split.
    This eliminates row-order variance: the same rows in any permutation
    produce an identical sorted frame, identical train/test split, and
    identical model weights.

    §6 encoding: sex -> Male=1/Female=0 (preserved as strings for metric masks),
    income -> >50K=1/else=0.
    §3: sorted LabelEncoder categories -> deterministic mapping.
    """
    df = df.copy()
    df["sex"]    = df["sex"].astype(str).str.strip()
    df["income"] = df["income"].astype(str).str.strip()

    # §D2 — Sort by all columns then reset index so row ordering is canonical.
    # Must happen BEFORE income/sex encoding so sort keys are string-comparable.
    df = df.sort_values(by=df.columns.tolist()).reset_index(drop=True)

    # Encode income
    df["income"] = df["income"].map(
        lambda v: 1 if v in (">50K", ">50K.", "1", "yes", "YES") else 0)

    sex_series = df["sex"].copy()

    drop_cols  = {"income", "sex", "fnlwgt", "native_country", "race",
                  "relationship", "education"}
    feature_cols = [c for c in df.columns if c not in drop_cols]

    X = df[feature_cols].copy()
    y = df["income"].values

    # §3: sorted categories -> identical mapping every run
    for col in X.select_dtypes(include="object").columns:
        le = LabelEncoder()
        le.fit(sorted(X[col].astype(str).unique()))
        X[col] = le.transform(X[col].astype(str))

    X = X.fillna(X.median(numeric_only=True))
    return X, y, sex_series, feature_cols


# =============================================================================
# §B1 — SPD ZONE CLASSIFIER
# =============================================================================

def spd_zone(spd: float) -> str:
    """
    §B1: Classify |SPD| into one of three stable zones.
    Using SPD_SAFE=0.04 and SPD_BORDERLINE=0.06 instead of a single 0.05
    threshold eliminates flip-flopping when |SPD| hovers near the boundary.

    Returns: "SAFE" | "BORDERLINE" | "NOT SAFE"
    """
    abs_spd = abs(spd)
    if abs_spd <= SPD_SAFE:
        return "SAFE"
    if abs_spd <= SPD_BORDERLINE:
        return "BORDERLINE"
    return "NOT SAFE"


# =============================================================================
# SECTION 1 — CORRECT FAIRNESS METRICS
# =============================================================================

def _masks(sex: pd.Series):
    male_mask   = sex.isin(["Male", "male"]) | (sex.astype(str) == "1")
    female_mask = sex.isin(["Female", "female"]) | (sex.astype(str) == "0")
    return male_mask.values, female_mask.values


def compute_metrics(y_pred: np.ndarray, y_true: np.ndarray,
                    sex: pd.Series) -> dict:
    """
    §B2: All floating-point metrics rounded to 3 decimal places.
         Reduces last-digit noise that caused apparent run-to-run variance.
    §B1: spd_zone added to every metrics snapshot.
    §1:  DI ideal = 1.0. bias_flag fires when DI < 0.80 OR DI > 1.25 OR |SPD| > SPD_THRESHOLD.
    """
    mm, fm = _masks(sex)
    n_m = int(mm.sum()); n_f = int(fm.sum())
    sel_m = float(y_pred[mm].mean()) if n_m > 0 else 0.0
    sel_f = float(y_pred[fm].mean()) if n_f > 0 else 0.0

    spd = sel_f - sel_m
    di  = sel_f / sel_m if sel_m > 0 else 0.0
    acc = float(accuracy_score(y_true, y_pred))

    # §1: bias in BOTH directions
    bias_flag = (abs(spd) > SPD_THRESHOLD) or (di < DI_LOW) or (di > DI_HIGH)

    # §B2: round to 3dp (was 4dp — last digit was noise)
    return {
        "male_rate":         round(sel_m, 3),
        "female_rate":       round(sel_f, 3),
        "spd":               round(spd,   3),
        "di":                round(di,    3),
        "accuracy":          round(acc,   3),
        "spd_zone":          spd_zone(spd),      # §B1
        "bias_flag":         bool(bias_flag),
        "n_male":            n_m,
        "n_female":          n_f,
        "n_selected_male":   int(y_pred[mm].sum()),
        "n_selected_female": int(y_pred[fm].sum()),
    }


def fairness_label_fn(spd: float, di: float, acc: float) -> str:
    """
    §B4: Three-zone fairness label.
      FAIR       — |SPD| <= 0.04 AND DI in [0.80, 1.25] AND acc >= 70%
      BORDERLINE — |SPD| <= 0.06 AND DI in [0.80, 1.25] AND acc >= 70%
                   (passes DI/accuracy but SPD is in the caution zone)
      BIASED     — any other case

    §B1: Uses SPD_SAFE/SPD_BORDERLINE constants, not the raw 0.05 threshold,
    to prevent flip-flopping when |SPD| oscillates around the boundary.
    §B2: Input spd already rounded to 3dp by compute_metrics.
    """
    di_ok  = DI_LOW <= di <= DI_HIGH
    acc_ok = acc >= MIN_ACCURACY
    zone   = spd_zone(spd)

    if zone == "SAFE" and di_ok and acc_ok:
        return "FAIR"
    if zone == "BORDERLINE" and di_ok and acc_ok:
        return "BORDERLINE"
    return "BIASED"


# =============================================================================
# SECTION 2 — DEPLOYMENT DECISION
# =============================================================================

def deployment_decision(spd: float, di: float, acc: float,
                        mitigation_status: str = "") -> dict:
    """
    §B4: Three-zone deployment decision — mirrors fairness_label_fn zones.
      SAFE TO DEPLOY      — |SPD| <= 0.04 AND DI in [0.80,1.25] AND acc >= 70%
      DEPLOY WITH CAUTION — |SPD| <= 0.06 AND DI in [0.80,1.25] AND acc >= 70%
                            (SPD in borderline zone — deploy with active monitoring)
      DO NOT DEPLOY       — any other case, OR mitigation_status == DEGRADED

    §B1: Using zone-based logic eliminates the hard 0.05 cliff that caused
    SAFE↔NOT SAFE flip-flopping when |SPD| hovered around 0.05.
    """
    is_degraded = mitigation_status.upper() == "DEGRADED"
    di_ok  = DI_LOW <= di <= DI_HIGH
    acc_ok = acc >= MIN_ACCURACY
    zone   = spd_zone(spd)

    if is_degraded:
        return {"deployment": "DO NOT DEPLOY", "risk": "HIGH"}

    if zone == "SAFE" and di_ok and acc_ok:
        return {"deployment": "CONDITIONALLY SAFE — Pending business validation", "risk": "LOW"}
    if zone == "BORDERLINE" and di_ok and acc_ok:
        return {"deployment": "DEPLOY WITH CAUTION", "risk": "MEDIUM"}
    return   {"deployment": "DO NOT DEPLOY",         "risk": "HIGH"}


# =============================================================================
# SECTION 1 — IMPROVEMENT COMPARISON (correct DI distance formula)
# =============================================================================

def compare_metrics(before: dict, after: dict) -> dict:
    """
    §B2: Format strings use 3dp throughout.
    §B4: Improvement label reflects BORDERLINE zone when applicable.
    §1 exact formulas:
      spd_improvement = |before_spd| - |after_spd|           (positive = better)
      di_improvement  = |1 - before_di| - |1 - after_di|    (positive = better)

    IMPROVED  -> both > 0
    DEGRADED  -> both < 0
    PARTIAL   -> mixed
    """
    spd_imp = abs(before["spd"]) - abs(after["spd"])
    di_imp  = abs(1.0 - before["di"]) - abs(1.0 - after["di"])

    spd_b = abs(before["spd"])
    raw_pct = (spd_imp / spd_b * 100) if spd_b > 0 else 0.0
    improvement_pct = round(max(raw_pct, 0.0), 1)

    after_zone = spd_zone(after["spd"])

    if spd_imp > 0 and di_imp > 0:
        status = "IMPROVED"
        # §B4: distinguish BORDERLINE improvement from full SAFE
        if after_zone == "SAFE":
            label = "MITIGATION SUCCEEDED — Bias reduced within defined fairness thresholds"
        else:
            label = "MITIGATION IMPROVED — Bias reduced. SPD in borderline zone. Deploy with active monitoring."
        detail = (
            f"|SPD| {abs(before['spd']):.3f} -> {abs(after['spd']):.3f} "
            f"(zone: {after_zone}); "
            f"DI distance from 1.0: {abs(1-before['di']):.3f} -> {abs(1-after['di']):.3f}."
        )
    elif spd_imp < 0 and di_imp < 0:
        status = "DEGRADED"
        improvement_pct = 0.0
        label  = "DEGRADATION — BOTH METRICS WORSENED AFTER MITIGATION"
        detail = (
            f"|SPD| {abs(before['spd']):.3f} -> {abs(after['spd']):.3f} (up, worse); "
            f"DI distance from 1.0: {abs(1-before['di']):.3f} -> {abs(1-after['di']):.3f} (up, worse). "
            "Do not deploy. Investigate mitigation strategy."
        )
    else:
        status = "PARTIAL"
        label  = "PARTIAL IMPROVEMENT — Some bias reduction achieved. Fairness thresholds not yet met. Do not deploy."
        detail = (
            f"SPD improvement: {spd_imp:+.3f} ({'better' if spd_imp > 0 else 'worse'}); "
            f"DI improvement: {di_imp:+.3f} ({'better' if di_imp > 0 else 'worse'}). "
            "Full fairness thresholds not met."
        )

    return {
        "status":          status,
        "improvement_pct": improvement_pct,
        "verdict_label":   label,
        "verdict_detail":  detail,
        "spd_improvement": round(spd_imp, 3),
        "di_improvement":  round(di_imp,  3),
        "after_spd_zone":  after_zone,           # §B4: expose zone in verdict
    }


# =============================================================================
# SECTION 8 — WARNINGS SYSTEM
# =============================================================================

def build_warnings(m: dict, stage_name: str) -> list:
    """§B1/§B2/§B4: Warnings with 3dp values and BORDERLINE zone advisory."""
    w = []
    if m["accuracy"] < MIN_ACCURACY:
        w.append(f"{stage_name}: accuracy {m['accuracy']:.1%} < {MIN_ACCURACY:.0%} — model usefulness compromised.")
    zone = spd_zone(m["spd"])
    if zone == "NOT SAFE":
        w.append(f"{stage_name}: |SPD| = {abs(m['spd']):.3f} > {SPD_BORDERLINE} — fairness threshold not met.")
    elif zone == "BORDERLINE":
        w.append(
            f"{stage_name}: |SPD| = {abs(m['spd']):.3f} is in the BORDERLINE zone "
            f"({SPD_SAFE} < |SPD| <= {SPD_BORDERLINE}). "
            "Deploy only with active monitoring and quarterly re-evaluation."
        )
    if m["di"] < DI_LOW:
        w.append(f"{stage_name}: DI = {m['di']:.3f} < {DI_LOW} — disparate impact violation (women under-selected).")
    if m["di"] > DI_HIGH:
        w.append(f"{stage_name}: DI = {m['di']:.3f} > {DI_HIGH} — disparate impact violation (reverse bias: women over-selected).")
    return w


# =============================================================================
# SECTION 3 — DETERMINISTIC MODEL TRAINING
# =============================================================================

def train_model(X_tr, y_tr, X_te, y_te, sex_te, metrics_fn=None):
    """§3: All seeds fixed at RANDOM_STATE. Returns (y_pred, metrics, scaler, model).
    metrics_fn: optional callable(y_pred, y_true, sex) — defaults to compute_metrics.
    """
    sc    = StandardScaler()
    model = LogisticRegression(max_iter=1000, random_state=RANDOM_STATE)
    model.fit(sc.fit_transform(X_tr), y_tr)
    y_pred = model.predict(sc.transform(X_te))
    fn = metrics_fn if metrics_fn is not None else compute_metrics
    m  = fn(y_pred, y_te, sex_te)
    return y_pred, m, sc, model


# =============================================================================
# SECTION 4 — 4-STAGE MITIGATION PIPELINE
# =============================================================================

def stage1_threshold(model, sc, X_te, y_te, sex_te, csv_hash: str = "",
                     metrics_fn=None):
    """
    Stage 1: Per-group threshold optimisation.
    §B3: If csv_hash is provided and a threshold has already been computed for
         this dataset, the cached value is reused — the search is never run twice.
         This locks the threshold per dataset and prevents any run-to-run variance
         from floating-point non-determinism in the search loop.
    §3:  Otherwise: deterministic linspace grid (no randomness).
    §1:  Objective minimises |SPD| + |1-DI| (composite fairness distance to ideal).
    """
    # §B3: return cached threshold immediately if available
    if csv_hash and csv_hash in _threshold_cache:
        cached_t = _threshold_cache[csv_hash]
        proba  = model.predict_proba(sc.transform(X_te))[:, 1]
        mm, fm = _masks(sex_te)
        y_out  = np.zeros(len(proba), dtype=int)
        y_out[mm] = (proba[mm] >= 0.5).astype(int)
        y_out[fm] = (proba[fm] >= cached_t).astype(int)
        fn = metrics_fn if metrics_fn is not None else compute_metrics
        return y_out, fn(y_out, y_te, sex_te), cached_t

    proba = model.predict_proba(sc.transform(X_te))[:, 1]
    mm, fm = _masks(sex_te)

    y_base = np.zeros(len(proba), dtype=int)
    y_base[mm] = (proba[mm] >= 0.5).astype(int)

    f_proba = proba[fm]
    p5  = max(float(np.percentile(f_proba,  5)), 0.01)
    p95 = min(float(np.percentile(f_proba, 95)), 0.99)

    # §3: deterministic grid (no randomness)
    grid = np.unique(np.clip(
        np.concatenate([np.linspace(p5, p95, 100), np.linspace(0.01, 0.99, 50)]),
        0.01, 0.99
    ))

    best_t, best_score = 0.5, float("inf")
    for t in grid:
        y_try = y_base.copy()
        y_try[fm] = (f_proba >= t).astype(int)

        sel_m = y_try[mm].mean()
        sel_f = y_try[fm].mean() if fm.sum() > 0 else 0.0
        if sel_m > MAX_SEL_RATE or sel_f > MAX_SEL_RATE: continue
        if sel_m < 0.02 or sel_f < 0.02: continue
        if accuracy_score(y_te, y_try) < MIN_ACCURACY: continue

        # §1: minimise both |SPD| and distance of DI from 1
        di    = sel_f / sel_m if sel_m > 0 else 0.0
        score = abs(sel_f - sel_m) + abs(1.0 - di)
        if score < best_score:
            best_score = score
            best_t     = t

    # §B3: store in threshold cache
    if csv_hash:
        _threshold_cache[csv_hash] = best_t

    y_out = y_base.copy()
    y_out[fm] = (f_proba >= best_t).astype(int)
    fn = metrics_fn if metrics_fn is not None else compute_metrics
    return y_out, fn(y_out, y_te, sex_te), round(float(best_t), 3)


def stage2_resample(X_tr, y_tr, sex_tr):
    """
    Stage 2: Stratified (sex x income) oversampling.
    §3: fixed rng seed=42.
    """
    df = X_tr.copy()
    df["_sex"]    = sex_tr.values
    df["_income"] = y_tr

    groups = df.groupby(["_sex", "_income"])
    target = int(groups.size().max())

    rng   = np.random.default_rng(RANDOM_STATE)   # §3
    parts = []
    for (_, __), grp in groups:
        n = target - len(grp)
        if n > 0:
            parts.append(grp)
            parts.append(df.loc[rng.choice(grp.index, size=n, replace=True)])
        else:
            parts.append(grp)

    df_res  = (pd.concat(parts, ignore_index=True)
               .sample(frac=1, random_state=RANDOM_STATE))  # §3
    sex_res = df_res["_sex"].reset_index(drop=True)
    y_res   = df_res["_income"].values
    X_res   = df_res.drop(columns=["_sex", "_income"]).reset_index(drop=True)
    return X_res, y_res, sex_res


def fairness_score(m: dict) -> float:
    """§4: Composite fairness score — lower is better (closer to SPD=0, DI=1)."""
    return abs(m["spd"]) + abs(1.0 - m["di"])


def pick_best_stage(candidates: list) -> dict:
    """
    §4: Fairness-first, accuracy-second.
    Among stages with acc >= MIN_ACCURACY, pick lowest fairness_score.
    If none meet the floor, pick the highest accuracy (least-bad fallback).
    """
    valid = [s for s in candidates if s["metrics"]["accuracy"] >= MIN_ACCURACY]
    pool  = valid if valid else candidates
    return min(pool, key=lambda s: (
        fairness_score(s["metrics"]),
        -s["metrics"]["accuracy"]     # tie-break: higher accuracy wins
    ))


# =============================================================================
# PIPELINE STATE TRACKING
# =============================================================================
# States: "RAW" → "MITIGATED" → "STABLE"
# A dataset is STABLE when it already meets fairness thresholds.
# Once STABLE, further mitigation is disabled.

def classify_pipeline_state(spd: float, di: float, accuracy: float) -> str:
    """
    §FIX-7: Pipeline state follows fairness outcome:
      STABLE    — all three fairness conditions met (fair, no further mitigation needed)
      RAW       — never been through mitigation (initial upload)
      FAILED    — mitigation ran but thresholds were NOT met (used by run_analysis)

    Note: MITIGATED is assigned by run_analysis only when mitigation actually ran,
    regardless of whether it succeeded. Callers use the return value of this
    function only for the baseline-already-fair path.
    """
    if is_already_fair(spd, di, accuracy, _label="classify_pipeline_state"):
        return "STABLE"
    return "RAW"


# =============================================================================
# FAIR DATASET BUILDER  (fixed: balanced labels, not just balanced rows)
# =============================================================================

def build_fair_dataset(df_original: pd.DataFrame, sex_series: pd.Series,
                       protected_col: str = "sex",
                       target_col: str = "income",
                       pipeline_state: str = "MITIGATED") -> pd.DataFrame:
    """
    Build a corrected dataset that:
      1. Balances gender representation (equal male/female counts).
      2. Balances the LABEL distribution within each gender group so the
         corrected CSV trains a model with a different decision boundary —
         not the same biased one as before.
      3. Embeds pipeline_state as a metadata comment in a dedicated column
         so re-uploads can be fingerprinted beyond raw MD5.

    Root-cause fix for the infinite loop:
      The old version oversampled (sex × income) groups to match the MAX count.
      This kept the label ratio identical to the original biased data:
      e.g. if females had 10% positive labels, the corrected set still had ~10%.
      The retrained model would learn the same pattern → still biased → loop.

      This version oversamples each (sex × income) group to the MEAN count of
      the positive-label groups, then ensures equal male/female TOTAL counts.
      The result: positive-label rates per gender converge toward equality,
      which is the actual label distribution change needed to break the loop.
    """
    df = df_original.copy()

    # Normalise target column to int 0/1
    df[target_col] = _encode_target(df[target_col])

    df["_prot"] = (sex_series.values if len(sex_series) == len(df)
                   else df[protected_col].astype(str).str.strip())

    # ── Step 1: compute target counts ────────────────────────────────────────
    groups      = df.groupby(["_prot", target_col])
    group_sizes = groups.size()
    target      = int(group_sizes.mean().round())

    # ── Step 2: oversample each group to target ───────────────────────────────
    parts = []
    rng   = np.random.default_rng(RANDOM_STATE)
    for (prot_val, tgt_val), grp in groups:
        n_needed = target - len(grp)
        if n_needed > 0:
            extra_idx = rng.choice(grp.index, size=n_needed, replace=True)
            parts.append(pd.concat([grp, df.loc[extra_idx]], ignore_index=True))
        else:
            parts.append(grp.sample(n=target, random_state=RANDOM_STATE)
                         if len(grp) > target else grp)

    fair_df = (pd.concat(parts, ignore_index=True)
               .sample(frac=1, random_state=RANDOM_STATE)
               .reset_index(drop=True)
               .drop(columns=["_prot"], errors="ignore"))

    # ── Step 3: validate label diversity is preserved ─────────────────────────
    label_counts = fair_df[target_col].value_counts()
    if len(label_counts) < 2:
        raise ValueError(
            f"build_fair_dataset: corrected dataset has only one value in '{target_col}'. "
            "Cannot train a meaningful model from this data.")

    # ── Step 4: embed pipeline state ─────────────────────────────────────────
    fair_df["_fairlens_state"] = pipeline_state

    # ── Step 5: convert target back to readable strings ───────────────────────
    # Only applies if target was income (>50K / <=50K); otherwise leave numeric
    if target_col == "income":
        fair_df[target_col] = fair_df[target_col].map({1: ">50K", 0: "<=50K"})

    return fair_df


# =============================================================================
# GEMINI EXPLANATION
# =============================================================================

def call_gemini(before: dict, after: dict, dataset_info: dict,
                proxies: list, status: str) -> dict:
    fallback = _rule_based_explanation(before, after, dataset_info, proxies, status)
    if not _gemini_client:
        fallback["source"] = "rule_based"
        return fallback

    n_f   = dataset_info.get("n_female", 0)
    n_tot = dataset_info.get("n_male", 0) + n_f
    f_pct = round(n_f / max(n_tot, 1) * 100, 1)
    p_str = ", ".join(proxies) if proxies else "none detected"

    prompt = f"""You are an expert AI fairness auditor reviewing a hiring ML model.

DATASET: {dataset_info.get('total_rows')} records | Female: {f_pct}% ({n_f})

BASELINE: Male {before['male_rate']*100:.1f}% | Female {before['female_rate']*100:.1f}%
SPD={before['spd']:.4f}  DI={before['di']:.4f}  Bias={before['bias_flag']}

AFTER MITIGATION: Male {after['male_rate']*100:.1f}% | Female {after['female_rate']*100:.1f}%
SPD={after['spd']:.4f}  DI={after['di']:.4f}  Status={status}

PROXY FEATURES: {p_str}

Note: DI ideal = 1.0. Both DI < 0.80 (under-selection) and DI > 1.25 (over-selection) are bias.
Note: legal_risk and ethical_risk must reflect the POST-MITIGATION state (after section), not the baseline.
If status is IMPROVED and post-mitigation SPD and DI are within thresholds, risk levels should be LOW or MEDIUM.

Respond ONLY with valid JSON, no markdown:
{{
  "explanation": "2-3 sentences explaining why bias existed in the baseline model, citing specific numbers from the BASELINE section above.",
  "legal_risk": "HIGH or MEDIUM or LOW — assessed against POST-MITIGATION metrics",
  "ethical_risk": "HIGH or MEDIUM or LOW — assessed against POST-MITIGATION metrics"
}}"""

    try:
        resp   = _gemini_client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
        raw    = resp.text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"): raw = raw[4:]
        parsed = json.loads(raw.strip())
        for k in ("legal_risk", "ethical_risk"):
            if parsed.get(k, "").upper() not in ("HIGH", "MEDIUM", "LOW"):
                parsed[k] = fallback[k]
            else:
                parsed[k] = parsed[k].upper()
        parsed["source"] = "gemini"
        return parsed
    except Exception as e:
        fallback["source"]       = "rule_based"
        fallback["gemini_error"] = str(e)
        return fallback


def _rule_based_explanation(before: dict, after: dict, dataset_info: dict,
                             proxies: list, status: str) -> dict:
    spd   = before["spd"]; di = before["di"]
    gap   = abs(before["male_rate"] - before["female_rate"]) * 100
    n_f   = dataset_info.get("n_female", 0)
    n_tot = dataset_info.get("n_male", 0) + n_f
    f_pct = round(n_f / max(n_tot, 1) * 100, 1)
    p_str = f" Features {', '.join(proxies[:2])} act as indirect gender proxies." if proxies else ""

    explanation = (
        f"The model selects {before['male_rate']*100:.1f}% of males vs "
        f"{before['female_rate']*100:.1f}% of females — a {gap:.1f}pp gap "
        f"(SPD={spd:.4f}, DI={di:.4f}). "
        f"Only {f_pct}% of training records are female.{p_str}"
    )
    # §1: risk uses distance from 1 for DI
    di_dist = abs(1.0 - di)
    legal   = "HIGH" if di_dist > 0.20 else ("MEDIUM" if di_dist > 0.10 else "LOW")
    ethical = "HIGH" if abs(spd) > 0.10 else ("MEDIUM" if abs(spd) > 0.05 else "LOW")
    return {"explanation": explanation, "legal_risk": legal, "ethical_risk": ethical}


# =============================================================================
# §S1 — EARLY-STOP: ALREADY FAIR DETECTION
# =============================================================================

def is_already_fair(spd: float, di: float, accuracy: float = 1.0,
                    _label: str = "") -> bool:
    """
    §F1 / §FIX-1: Spec-exact already-fair condition — ALL three must pass:
      abs(SPD) <= 0.05  (uses SPD_THRESHOLD, not the tighter SPD_SAFE)
      DI       >= 0.80
      accuracy >= 0.70

    §FIX-2: Inverted-comparison guard — conditions stated in the correct
    direction. All callers must use only this function, never inline checks.

    §FIX-3: Validates metric bounds before evaluating.
    §FIX-6: Emits a structured debug line on every call.

    When True:
      - DO NOT generate a new dataset
      - DO NOT apply any mitigation
    """
    # §FIX-3: Validate bounds first — raises ValueError on impossible values
    validate_metrics(spd, di, label=_label or "is_already_fair")

    # §FIX-1: Correct direction — ALL conditions must be simultaneously satisfied.
    # DO NOT invert: abs(SPD) > 0.05 would mean BIASED, not fair.
    fair = (
        abs(spd)  <= SPD_THRESHOLD   # correct: <= means within safe limit
        and di    >= DI_LOW           # correct: >= means above EEOC floor
        and accuracy >= MIN_ACCURACY  # correct: >= means model is useful
    )

    # §FIX-6: Always log so contradictions are traceable
    debug_fairness(spd, di, accuracy, fair, label=_label or "is_already_fair")

    return fair


def already_fair_response(m_s0: dict, dataset_info: dict,
                           proxies: list,
                           stability_warnings: list) -> dict:
    """
    §F1: When baseline already satisfies abs(SPD)<=0.05 AND DI>=0.80 AND acc>=70%:
      - DO NOT call build_fair_dataset
      - DO NOT apply any mitigation stage
      - Return message: "Dataset already fair"
    §F2: is_mitigated = False (no mitigation was applied)

    §FIX-3: Validates metrics before building output.
    §FIX-4: Consistency guard — if fairness_label_fn returns BIASED here,
    raise an error rather than emit contradictory output.
    """
    spd = m_s0["spd"]; di = m_s0["di"]; acc = m_s0["accuracy"]

    # §FIX-3: Hard validation — must pass before building any response
    validate_metrics(spd, di, label="already_fair_response")

    # §FIX-4: Consistency guard — this function must ONLY be called when the
    # dataset is genuinely fair. If somehow it is reached with a biased dataset,
    # catch it here before emitting contradictory output.
    base_label = fairness_label_fn(spd, di, acc)
    base_dec   = deployment_decision(spd, di, acc)

    if base_label == "BIASED":
        # This should never happen if callers respect the gate, but if it does,
        # we must not silently produce "FAIR" + "DO NOT DEPLOY" contradiction.
        raise ValueError(
            f"already_fair_response called with BIASED metrics: "
            f"SPD={spd:.4f}  DI={di:.4f}  ACC={acc:.4f}. "
            "Caller must check is_already_fair() before invoking this function."
        )

    # §FIX-6: Debug log
    debug_fairness(spd, di, acc, True, label="already_fair_response")

    verdict_detail = (
        f"abs(SPD) = {abs(spd):.3f} <= {SPD_THRESHOLD} \u2713  |  "
        f"DI = {di:.3f} >= {DI_LOW} \u2713  |  "
        f"accuracy = {acc:.3f} >= {MIN_ACCURACY} \u2713  "
        "— all three fairness conditions satisfied. No mitigation required."
    )

    gemini_out    = call_gemini(m_s0, m_s0, dataset_info, proxies, "ALREADY FAIR")
    verdict_label = "Dataset already fair"     # §F1: exact required message

    all_warnings = build_warnings(m_s0, "Baseline") + stability_warnings

    return {
        # §F1 required keys
        "status":        "ALREADY FAIR",
        "message":       "Dataset already fair",   # §F1: literal message
        "is_mitigated":  False,                    # §F2: no mitigation applied
        "is_fair_after": True,                     # consistent key: baseline was already fair

        "deployment":    base_dec["deployment"],
        "best_stage":    "Baseline (already fair — mitigation skipped)",
        "warnings":      all_warnings,
        "download_url":  None,   # §F1: no corrected dataset generated
        "audit_note": (
            "Dataset already satisfies all three fairness conditions "
            "(|SPD| ≤ 0.05, DI ≥ 0.80, accuracy ≥ 70%). "
            "No mitigation was applied. No corrected dataset was generated. "
            "The model is eligible for deployment subject to standard operational review."
        ),

        # Pipeline meta
        "pipeline_meta": {
            "early_stop":          True,   # §F1: pipeline stopped here
            "resampling_skipped":  True,
            "convergence_stopped": False,
            "stages_run":          1,
        },

        "before": {
            **m_s0,
            "fairness_label":    base_label,
            "deployment_status": base_dec["deployment"],
            "risk_level":        base_dec["risk"],
        },

        # after == before: nothing was changed
        "after": {
            **m_s0,
            "fairness_label":    base_label,
            "deployment_status": base_dec["deployment"],
            "risk_level":        base_dec["risk"],
            "female_threshold":  None,
        },

        "after_preprocessing": {**m_s0, "fairness_label": base_label},

        # §F1: improvement = 0 — do NOT show a reduction number
        "improvement":        0.0,
        "mitigation_status":  "already_fair",
        "mitigation_verdict": {
            "outcome":         "ALREADY FAIR",
            "verdict_label":   verdict_label,
            "verdict_detail":  verdict_detail,
            "improvement_pct": 0.0,
            "spd_improved":    False,
            "di_improved":     False,
        },

        "all_stages": [
            {"stage": "Baseline", "metrics": m_s0,
             "fairness_label": base_label, "warnings": all_warnings},
        ],

        "dataset_info":   dataset_info,
        "proxy_features": [{"name": p, "explanation": PROXY_EXPLANATIONS[p]} for p in proxies],

        "impact_assessment": _build_impact_assessment(m_s0, m_s0, "ALREADY FAIR"),

        # §F1: no dataset generated
        "fair_dataset_available": False,
        "fair_dataset_info":      {},

        "explanation": gemini_out.get("explanation", ""),
        "risk": {
            "legal_risk":     gemini_out.get("legal_risk",  "LOW"),
            "ethical_risk":   gemini_out.get("ethical_risk","LOW"),
            "recommendation": base_dec["deployment"],
            "risk_level":     base_dec["risk"],
            "source":         gemini_out.get("source", "rule_based"),
        },
    }


# =============================================================================
# §S2 — ALREADY-BALANCED DATASET DETECTION
# =============================================================================

def is_already_balanced(sex_tr: pd.Series, y_tr: np.ndarray) -> bool:
    """
    §S2: Returns True when the training set already has near-equal group counts
    AND balanced label distributions per group — resampling would be a no-op.

    Criteria:
      1. |n_male - n_female| / n_total < BALANCE_THRESHOLD (5% gender balance)
      2. Positive-label rate within each gender is within 10pp of each other
    """
    mm = sex_tr.isin(["Male", "male"]).values
    fm = ~mm
    n_total = len(sex_tr)
    if n_total == 0:
        return False

    n_m = mm.sum()
    n_f = fm.sum()
    gender_imbalance = abs(n_m - n_f) / n_total

    if gender_imbalance >= BALANCE_THRESHOLD:
        return False

    # Check label balance within each group
    if n_m > 0 and n_f > 0:
        pos_rate_m = float(y_tr[mm].mean())
        pos_rate_f = float(y_tr[fm].mean())
        label_imbalance = abs(pos_rate_m - pos_rate_f)
        if label_imbalance > 0.10:
            return False

    return True


# =============================================================================
# §S3 — CONVERGENCE CONTROL
# =============================================================================

def check_convergence(stage_scores: list[float], stage_name: str) -> tuple[bool, str]:
    """
    §S3: Compare the last two fairness scores in stage_scores.
    Fairness score = abs(SPD) + abs(1-DI) — lower is better.

    If the improvement (reduction in score) between the previous and current stage
    is less than CONVERGENCE_DELTA, the pipeline has plateaued — stop.

    Returns (should_stop: bool, reason: str).
    """
    if len(stage_scores) < 2:
        return False, ""

    prev_score = stage_scores[-2]
    curr_score = stage_scores[-1]
    delta = prev_score - curr_score   # positive = improvement

    if delta < CONVERGENCE_DELTA:
        reason = (
            f"{stage_name}: improvement delta {delta:.4f} < {CONVERGENCE_DELTA} threshold — "
            "pipeline has plateaued, stopping to avoid overcorrection."
        )
        return True, reason

    return False, ""


# =============================================================================
# §S4 — STABILITY TEST
# =============================================================================

def _metrics_fingerprint(m: dict) -> tuple:
    """Return a tuple of the key metric values for comparison."""
    return (
        round(m["spd"],      4),
        round(m["di"],       4),
        round(m["accuracy"], 4),
        round(m["male_rate"],   4),
        round(m["female_rate"], 4),
    )


def stability_test(df: pd.DataFrame,
                   protected_col: str | None = None,
                   target_col: str | None = None) -> list[str]:
    """§S4: Run baseline twice, compare — uses dynamic columns if provided."""
    warnings_out = []
    try:
        r1 = _quick_baseline(df, protected_col, target_col)
        r2 = _quick_baseline(df, protected_col, target_col)
        diffs = {
            "SPD":      abs(r1["spd"]      - r2["spd"]),
            "DI":       abs(r1["di"]       - r2["di"]),
            "accuracy": abs(r1["accuracy"] - r2["accuracy"]),
        }
        unstable = {k: v for k, v in diffs.items() if v > STABILITY_TOLERANCE}
        if unstable:
            diff_str = ", ".join(f"{k} diff={v:.4f}" for k, v in unstable.items())
            warnings_out.append(
                f"⚠ Model is unstable — results vary across runs ({diff_str}). "
                "Check for unseeded random operations."
            )
    except Exception as e:
        warnings_out.append(f"Stability test failed (non-critical): {e}")
    return warnings_out


def _quick_baseline(df: pd.DataFrame,
                    protected_col: str | None = None,
                    target_col: str | None = None) -> dict:
    """§S4 helper: lightweight baseline-only run — uses dynamic columns."""
    p_col, t_col = resolve_columns(df.copy(), protected_col, target_col)
    X, y, sex, _, g_a, g_b = preprocess_dynamic(df.copy(), p_col, t_col)
    g_a_lbl = sorted(g_a)[0] if g_a else "a"
    g_b_lbl = sorted(g_b)[0] if g_b else "b"
    X_tr, X_te, y_tr, y_te, _, sex_te = train_test_split(
        X, y, sex, test_size=0.3, random_state=RANDOM_STATE, stratify=y)
    sex_te = sex_te.reset_index(drop=True)
    def _m(yp, yt, s):
        return compute_metrics_dynamic(yp, yt, s, g_a, g_b, g_a_lbl, g_b_lbl)
    _, m, _, _ = train_model(X_tr, y_tr, X_te, y_te, sex_te, metrics_fn=_m)
    return m


# =============================================================================
# §S6 — OVERCORRECTION DETECTION
# =============================================================================

def check_overcorrection(spd_before: float, spd_after: float) -> str | None:
    """
    §S6: Warn if the SPD sign flipped (direction of bias reversed) AND
    the post-mitigation |SPD| is still meaningfully large (> OVERCORRECTION_MIN).

    A sign flip from -0.20 to +0.03 is fine (tiny overcorrection, still within fair range).
    A sign flip from -0.20 to +0.15 is a problem — bias has been reversed, not eliminated.
    """
    sign_flipped = (spd_before < 0 and spd_after > 0) or (spd_before > 0 and spd_after < 0)
    if sign_flipped and abs(spd_after) > OVERCORRECTION_MIN:
        direction = "positive (women now over-selected)" if spd_after > 0 else "negative (women now under-selected)"
        return (
            f"⚠ Possible overcorrection — bias direction flipped significantly. "
            f"SPD went from {spd_before:.4f} to {spd_after:.4f} ({direction}). "
            "Review mitigation intensity."
        )
    return None


# =============================================================================
# §F2 — STATUS MESSAGE HELPER
# =============================================================================

def _status_message(status: str, improvement_pct: float) -> str:
    """
    §F2: Human-readable message for every pipeline outcome.
    Kept separate so it is easy to localise or customise.
    """
    messages = {
        "IMPROVED":     "Bias reduced within defined fairness thresholds after mitigation. "
                        "Mitigation changed selection distribution — review business impact before deployment.",
        "PARTIAL":      "Bias partially reduced. Fairness thresholds not fully met. "
                        "Further remediation required before deployment.",
        "DEGRADED":     "Mitigation worsened fairness metrics. Do not deploy. Investigate mitigation strategy.",
        "ALREADY FAIR": "Dataset already fair",   # §F1 literal
    }
    return messages.get(status, f"Mitigation status: {status}.")


# =============================================================================
# §D3/D4 — MD5 RESULT CACHE
# =============================================================================

def dataset_hash(csv_bytes: bytes) -> str:
    """
    §D3: Compute a stable MD5 fingerprint of the raw CSV bytes.
    Identical file content -> identical hash -> cached result returned.
    Different content (even one byte) -> different hash -> fresh analysis.
    """
    return hashlib.md5(csv_bytes).hexdigest()


# =============================================================================
# CORE PIPELINE (v9)
# =============================================================================


# =============================================================================
# RISK CONSISTENCY GUARD
# =============================================================================

_RISK_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
_RISK_NAME  = {0: "LOW", 1: "MEDIUM", 2: "HIGH"}

def _build_consistent_risk(gemini_out: dict, decision: dict,
                            before: dict, after: dict) -> dict:
    """
    Guarantee that legal_risk and ethical_risk are never HIGHER than what the
    deployment decision implies.

    Rules:
      deployment risk = LOW    → both legal and ethical must be ≤ MEDIUM
      deployment risk = MEDIUM → both may be up to HIGH (already consistent)
      deployment risk = HIGH   → no cap (anything is consistent)

    Additionally compute post-mitigation risk levels from actual post metrics,
    so the risk panel reflects the current model state, not the baseline.

    Returns the full risk dict with an audit trail of any cap applied.
    """
    dep_risk   = decision["risk"]          # "LOW" | "MEDIUM" | "HIGH"
    dep_level  = _RISK_ORDER[dep_risk]

    raw_legal   = gemini_out.get("legal_risk",   "HIGH").upper()
    raw_ethical = gemini_out.get("ethical_risk",  "HIGH").upper()

    if raw_legal   not in _RISK_ORDER: raw_legal   = "HIGH"
    if raw_ethical not in _RISK_ORDER: raw_ethical = "HIGH"

    # Compute post-mitigation risk from actual metrics (not baseline)
    after_spd  = after.get("spd",      0.0)
    after_di   = after.get("di",       1.0)
    after_acc  = after.get("accuracy", 1.0)

    di_dist   = abs(1.0 - after_di)
    post_legal   = "HIGH" if di_dist > 0.20 else ("MEDIUM" if di_dist > 0.10 else "LOW")
    post_ethical = "HIGH" if abs(after_spd) > 0.10 else ("MEDIUM" if abs(after_spd) > 0.05 else "LOW")

    # Use post-metric levels (derived from actual after-metrics) as the authoritative source.
    # Gemini sees baseline metrics in the prompt — its risk assessment reflects pre-fix state.
    # The post-metric derivation reflects the corrected model, so it takes priority.
    legal_lvl   = post_legal
    ethical_lvl = post_ethical

    # Apply the deployment-consistency cap
    cap = None
    if dep_level == _RISK_ORDER["LOW"]:
        cap_ceil = _RISK_ORDER["MEDIUM"]
        if _RISK_ORDER[legal_lvl]   > cap_ceil:
            legal_lvl = "MEDIUM"; cap = "capped to MEDIUM (deployment=LOW)"
        if _RISK_ORDER[ethical_lvl] > cap_ceil:
            ethical_lvl = "MEDIUM"; cap = cap or "capped to MEDIUM (deployment=LOW)"

    return {
        "legal_risk":     legal_lvl,
        "ethical_risk":   ethical_lvl,
        "recommendation": decision["deployment"],
        "risk_level":     dep_risk,
        "source":         gemini_out.get("source", "rule_based"),
        # Audit trail — exposed in JSON so the cap is transparent
        "_risk_cap_applied": cap,
        "_raw_legal_risk":   raw_legal,
        "_raw_ethical_risk": raw_ethical,
    }

def _shift_severity(delta_abs: float) -> str:
    """Classify selection rate shift: >20pp=HIGH, >10pp=MODERATE, else LOW."""
    if delta_abs > 0.20: return "HIGH"
    if delta_abs > 0.10: return "MODERATE"
    return "LOW"


def _build_impact_assessment(before: dict, after: dict, status: str) -> dict:
    """Standardised impact_assessment with per-group shift severity."""
    m_delta = round(after["male_rate"]   - before["male_rate"],   3)
    f_delta = round(after["female_rate"] - before["female_rate"], 3)
    male_sev   = _shift_severity(abs(m_delta))
    female_sev = _shift_severity(abs(f_delta))
    sev_rank   = {"LOW": 0, "MODERATE": 1, "HIGH": 2}
    overall    = max([male_sev, female_sev], key=lambda s: sev_rank[s])
    needs_val  = status in ("IMPROVED", "PARTIAL")
    if status == "ALREADY FAIR":
        note = ("No selection rate change - baseline already satisfies fairness thresholds. "
                "Standard deployment review applies.")
    elif overall == "HIGH":
        note = ("Selection Rate Shift Severity: HIGH. "
                "One or both groups shifted > 20 percentage points after mitigation. "
                "Formal legal and compliance review required before production deployment.")
    elif overall == "MODERATE":
        note = ("Selection Rate Shift Severity: MODERATE. "
                "Selection rates shifted 10-20 percentage points. "
                "Validate business impact against operational baselines before deployment.")
    else:
        note = ("Selection Rate Shift Severity: LOW. "
                "Changes within acceptable operational variance (<= 10pp). "
                "Standard monitoring applies post-deployment.")
    return {
        "selection_rate_shift": {
            "male_before":     before["male_rate"],
            "male_after":      after["male_rate"],
            "female_before":   before["female_rate"],
            "female_after":    after["female_rate"],
            "male_delta":      m_delta,
            "female_delta":    f_delta,
            "male_severity":   male_sev,
            "female_severity": female_sev,
        },
        "overall_shift_severity":       overall,
        "requires_business_validation": needs_val,
        "review_note":                  note,
    }


def _build_audit_note(status: str, impact: dict) -> str:
    """Severity-aware audit note for every mitigated response."""
    sev = impact.get("overall_shift_severity", "LOW")
    if status == "IMPROVED":
        clause = {
            "HIGH":     "Selection Rate Shift Severity is HIGH (> 20pp). Formal legal and compliance review required before production deployment.",
            "MODERATE": "Selection Rate Shift Severity is MODERATE (10-20pp). Validate business impact before deployment.",
            "LOW":      "Selection Rate Shift Severity is LOW (<= 10pp). Standard post-deployment monitoring applies.",
        }[sev]
        return (f"Bias reduced within defined fairness thresholds. {clause} "
                "Consult legal and compliance teams and document mitigation rationale before rollout.")
    if status == "PARTIAL":
        return ("Fairness thresholds not fully met. Do not deploy without further remediation. "
                "Selection rate changes recorded for audit purposes.")
    if status == "DEGRADED":
        return ("Mitigation degraded fairness metrics. Do not deploy. "
                "Root-cause investigation required.")
    return "Mitigation status requires manual review before deployment."


def run_analysis(df: pd.DataFrame, csv_hash: str = "",
                 protected_col: str | None = None,
                 target_col: str | None = None) -> dict:
    global _fair_df, _result_cache, _last_is_mitigated

    df_raw = df.copy()

    # ── §S0: Read embedded pipeline state BEFORE preprocessing ───────────────
    prior_state = read_pipeline_state(df)

    # Drop the metadata column before any ML processing
    df = df.drop(columns=["_fairlens_state"], errors="ignore")
    df_raw = df_raw.drop(columns=["_fairlens_state"], errors="ignore")

    # §C4: Resolve which columns to use
    p_col, t_col = resolve_columns(df, protected_col, target_col)

    # §C5: Dynamic preprocessing
    X, y, sex, feature_cols, group_a_vals, group_b_vals = preprocess_dynamic(
        df, p_col, t_col)

    # Derive readable group labels from actual values in the data
    group_a_label = sorted(group_a_vals)[0] if group_a_vals else f"{p_col}_a"
    group_b_label = sorted(group_b_vals)[0] if group_b_vals else f"{p_col}_b"

    # §C7: Metrics closure — all pipeline stages call this instead of compute_metrics
    def _metrics(y_pred, y_true, sex_series):
        return compute_metrics_dynamic(
            y_pred, y_true, sex_series,
            group_a_vals, group_b_vals,
            group_a_label, group_b_label)

    # §S4: Stability test — uses dynamic columns
    stability_warnings = stability_test(df_raw, protected_col=p_col, target_col=t_col)

    # §S5: fixed split — identical every call
    X_tr, X_te, y_tr, y_te, sex_tr, sex_te = train_test_split(
        X, y, sex, test_size=0.3, random_state=RANDOM_STATE, stratify=y)
    sex_te = sex_te.reset_index(drop=True)
    sex_tr = sex_tr.reset_index(drop=True)

    # ── Stage 0: Baseline ─────────────────────────────────────────────────────
    y_s0, m_s0, sc0, model0 = train_model(X_tr, y_tr, X_te, y_te, sex_te,
                                           metrics_fn=_metrics)
    w_s0 = build_warnings(m_s0, "Baseline")

    # ── Dataset info (needed by early-stop path) ──────────────────────────────
    n_male   = int(m_s0["n_male"])
    n_female = int(m_s0["n_female"])
    dataset_info = {
        "total_rows":      int(len(df)),
        "n_male":          n_male,
        "n_female":        n_female,
        "positive_rate":   round(float(y.mean()), 4),
        "feature_columns": feature_cols,
        "test_size":       int(len(y_te)),
        "pipeline_state":  prior_state,
        # §C4: surface the resolved column names so the frontend can render labels
        "col_config": {
            "protected_col":  p_col,
            "target_col":     t_col,
            "group_a_label":  group_a_label,
            "group_b_label":  group_b_label,
        },
    }
    proxies = [f for f in PROXY_EXPLANATIONS if f in feature_cols]

    # ── §CONVERGENCE: Already-fair / already-stable check ─────────────────────
    # Gate 1: Metrics CURRENTLY meet thresholds (regardless of upload history)
    already_fair_by_metrics = is_already_fair(
        m_s0["spd"], m_s0["di"], m_s0["accuracy"], _label="Baseline")

    # Gate 2: Dataset was previously corrected (embedded state column says so)
    already_processed = prior_state in ("MITIGATED", "STABLE")

    # §FIX-5: Only trigger the "already processed" shortcut when BOTH of these
    # are true simultaneously:
    #   (a) the embedded state marks the dataset as previously corrected, AND
    #   (b) the current metrics actually pass fairness thresholds.
    # If the corrected dataset is STILL biased (e.g. bias re-appeared, or the
    # original export was wrong), we must NOT label it FAIR/STABLE — we must
    # continue through the full mitigation pipeline.
    if already_fair_by_metrics:
        # §FIX-4 Consistency guard: metrics are fair → label MUST be FAIR/STABLE,
        # deployment MUST NOT be "DO NOT DEPLOY".
        effective_state = "STABLE"
        _fair_df           = None
        _last_is_mitigated = False
        dataset_info["pipeline_state"] = effective_state

        result = already_fair_response(m_s0, dataset_info, proxies, stability_warnings)

        if already_processed:
            # Previously processed AND still fair — ideal re-upload path
            result["message"]            = "Dataset already processed"
            result["pipeline_state_note"] = effective_state
        # else: fresh dataset that happens to already be fair — message already
        # set to "Dataset already fair" by already_fair_response.

        if csv_hash:
            _result_cache[csv_hash] = result
        return result

    if already_processed and not already_fair_by_metrics:
        # §FIX-5: Previously processed dataset is STILL biased.
        # DO NOT short-circuit — fall through to full mitigation pipeline.
        # Log a warning so the operator knows mitigation needs to re-run.
        print(
            f"[FairLens WARN] Re-uploaded dataset (state={prior_state}) "
            f"is STILL BIASED: SPD={m_s0['spd']:.4f}  DI={m_s0['di']:.4f}. "
            "Proceeding with full mitigation pipeline.",
            flush=True,
        )

    # ── Track fairness scores for §S3 convergence control ────────────────────
    baseline_fs      = fairness_score(m_s0)
    stage_scores     = [baseline_fs]
    convergence_warnings: list[str] = []
    active_candidates = []

    # ── Stage 1: Threshold optimisation on baseline model ─────────────────────
    y_s1, m_s1, t_s1 = stage1_threshold(model0, sc0, X_te, y_te, sex_te,
                                         csv_hash, metrics_fn=_metrics)
    w_s1 = build_warnings(m_s1, "Stage 1 (Threshold)")
    stage_scores.append(fairness_score(m_s1))
    active_candidates.append({
        "stage": "Stage 1 (Threshold)", "metrics": m_s1,
        "y_pred": y_s1, "threshold": t_s1, "warnings": w_s1
    })

    # §S3: Check convergence after Stage 1
    should_stop, conv_reason = check_convergence(stage_scores, "Stage 1")
    if should_stop:
        convergence_warnings.append(conv_reason)

    # ── Stage 2: Skip-check — §S2 ─────────────────────────────────────────────
    skip_resampling = is_already_balanced(sex_tr, y_tr)
    skip_reason: str | None = None

    if skip_resampling:
        skip_reason = (
            "Dataset gender balance within 5% and label distributions similar — "
            "resampling skipped to prevent unnecessary model drift."
        )
        m_s3  = m_s0;  w_s3  = w_s0;  y_s3  = y_s0
        m_s3t = m_s1;  w_s3t = w_s1;  y_s3t = y_s1
        t_s3t = t_s1
        sc3 = sc0; model3 = model0
    else:
        # ── Stage 2: Dataset rebalancing ──────────────────────────────────────
        X_res, y_res, sex_res = stage2_resample(X_tr, y_tr, sex_tr)

        # ── Stage 3: Retrain on balanced data ─────────────────────────────────
        y_s3, m_s3, sc3, model3 = train_model(X_res, y_res, X_te, y_te, sex_te,
                                               metrics_fn=_metrics)
        w_s3 = build_warnings(m_s3, "Stage 3 (Retrain)")
        stage_scores.append(fairness_score(m_s3))

        if not should_stop:
            stop3, reason3 = check_convergence(stage_scores, "Stage 3")
            if stop3:
                should_stop = True
                convergence_warnings.append(reason3)

        active_candidates.append({
            "stage": "Stage 3 (Retrain)", "metrics": m_s3,
            "y_pred": y_s3, "threshold": None, "warnings": w_s3
        })

        # Stage 3+1: threshold on retrained model
        y_s3t, m_s3t, t_s3t = stage1_threshold(model3, sc3, X_te, y_te, sex_te,
                                                csv_hash, metrics_fn=_metrics)
        w_s3t = build_warnings(m_s3t, "Stage 3+Threshold")
        stage_scores.append(fairness_score(m_s3t))

        if not should_stop:
            stop3t, reason3t = check_convergence(stage_scores, "Stage 3+Threshold")
            if stop3t:
                should_stop = True
                convergence_warnings.append(reason3t)

    active_candidates.append({
        "stage": "Stage 3+1 (Retrain+Threshold)", "metrics": m_s3t,
        "y_pred": y_s3t, "threshold": t_s3t, "warnings": w_s3t
    })

    # ── §S4: Pick best stage ──────────────────────────────────────────────────
    best   = pick_best_stage(active_candidates)
    best_m = best["metrics"]

    # ── Compare baseline vs best ──────────────────────────────────────────────
    comparison = compare_metrics(m_s0, best_m)
    status     = comparison["status"]   # "IMPROVED" | "PARTIAL" | "DEGRADED"

    # ── §S6: Overcorrection detection ─────────────────────────────────────────
    overcorrection_warning = check_overcorrection(m_s0["spd"], best_m["spd"])

    # ── §S8: Collect all warnings ─────────────────────────────────────────────
    all_warnings: list[str] = []
    all_warnings += stability_warnings
    all_warnings += list(w_s0)
    all_warnings += convergence_warnings
    if skip_reason:
        all_warnings.append(skip_reason)
    if overcorrection_warning:
        all_warnings.append(overcorrection_warning)
    if status == "DEGRADED":
        all_warnings.append(
            "Mitigation ineffective — all fairness metrics worsened. Do not deploy.")
    elif best_m["bias_flag"]:
        all_warnings.append(
            "Mitigation ineffective — bias persists after all strategies.")

    # ── Deployment decision ───────────────────────────────────────────────────
    decision   = deployment_decision(best_m["spd"], best_m["di"], best_m["accuracy"], status)
    base_dec   = deployment_decision(m_s0["spd"],   m_s0["di"],   m_s0["accuracy"])
    best_label = fairness_label_fn(best_m["spd"], best_m["di"], best_m["accuracy"])
    base_label = fairness_label_fn(m_s0["spd"],   m_s0["di"],   m_s0["accuracy"])

    # §FIX-6: Debug log for post-mitigation state
    _post_is_fair = is_already_fair(
        best_m["spd"], best_m["di"], best_m["accuracy"], _label="Post-Mitigation")

    # §FIX-4 + §FIX-7: Consistency guard — label and deployment must agree.
    # If is_fair → label MUST be FAIR/BORDERLINE, deployment MUST NOT be "DO NOT DEPLOY".
    # If NOT is_fair → label MUST be BIASED/BORDERLINE, deployment MUST NOT be "SAFE".
    if _post_is_fair and best_label == "BIASED":
        # This should never happen. Log loudly and override.
        print(
            f"[FairLens ERROR] Consistency violation: is_fair=True but label=BIASED "
            f"(SPD={best_m['spd']:.4f} DI={best_m['di']:.4f}). Overriding label to FAIR.",
            flush=True,
        )
        best_label = "FAIR"
    if not _post_is_fair and best_label == "FAIR" and decision["deployment"] == "DO NOT DEPLOY":
        print(
            f"[FairLens ERROR] Consistency violation: is_fair=False but label=FAIR "
            f"(SPD={best_m['spd']:.4f} DI={best_m['di']:.4f}). Overriding label to BIASED.",
            flush=True,
        )
        best_label = "BIASED"

    # §FIX-7: pipeline_state for the corrected CSV:
    #   STABLE   — post-mitigation metrics meet all thresholds
    #   FAILED   — mitigation ran but thresholds NOT met (replaces old "MITIGATED"
    #              which was ambiguous — a dataset could be "MITIGATED" yet still BIASED)
    #   MITIGATED — kept for backward-compat only when status is IMPROVED and
    #              the post model is in the BORDERLINE zone (not fully STABLE)
    if _post_is_fair:
        post_pipeline_state = "STABLE"
    elif status in ("PARTIAL", "DEGRADED"):
        post_pipeline_state = "FAILED"
    else:
        post_pipeline_state = "MITIGATED"

    if _post_is_fair:
        _fair_df       = None
        fair_available = False
        fair_info      = {}
    else:
        try:
            _fair_df       = build_fair_dataset(df_raw, sex,
                                                protected_col=p_col,
                                                target_col=t_col,
                                                pipeline_state=post_pipeline_state)
            fair_available = True
            fair_info      = {"rows": int(len(_fair_df)), "columns": list(_fair_df.columns)}
        except Exception as e:
            _fair_df       = None
            fair_available = False
            fair_info      = {}
            all_warnings.append(f"Fair dataset generation failed: {e}")

    # ── Gemini ────────────────────────────────────────────────────────────────
    gemini_out = call_gemini(m_s0, best_m, dataset_info, proxies, status)

    # ── Structured response ───────────────────────────────────────────────────
    all_stage_list = [
        {"stage": "Baseline", "metrics": m_s0,
         "fairness_label": base_label, "warnings": list(w_s0)},
        {"stage": "Stage 1 (Threshold)", "metrics": m_s1,
         "fairness_label": fairness_label_fn(m_s1["spd"], m_s1["di"], m_s1["accuracy"]),
         "threshold": t_s1, "warnings": list(w_s1)},
    ]
    if not skip_resampling:
        all_stage_list.append({
            "stage": "Stage 3 (Retrain)", "metrics": m_s3,
            "fairness_label": fairness_label_fn(m_s3["spd"], m_s3["di"], m_s3["accuracy"]),
            "warnings": list(w_s3),
        })
    all_stage_list.append({
        "stage": "Stage 3+1 (Retrain+Threshold)", "metrics": m_s3t,
        "fairness_label": fairness_label_fn(m_s3t["spd"], m_s3t["di"], m_s3t["accuracy"]),
        "threshold": t_s3t, "warnings": list(w_s3t),
    })

    result = {
        "status":        status,
        "message":       _status_message(status, comparison["improvement_pct"]),
        "is_mitigated":  True,
        "is_fair_after": _post_is_fair,
        "deployment":    decision["deployment"],
        "best_stage":    best["stage"],
        "warnings":      all_warnings,
        "download_url":  "/download/fair-dataset",

        "audit_note": _build_audit_note(status, _build_impact_assessment(m_s0, best_m, status)),

        "pipeline_meta": {
            "early_stop":          False,
            "resampling_skipped":  skip_resampling,
            "convergence_stopped": should_stop,
            "stages_run":          len(all_stage_list),
            "pipeline_state":      post_pipeline_state,
        },

        "before": {
            **m_s0,
            "fairness_label":    base_label,
            "deployment_status": base_dec["deployment"],
            "risk_level":        base_dec["risk"],
        },

        "after": {
            **best_m,
            "fairness_label":    best_label,
            "deployment_status": decision["deployment"],
            "risk_level":        decision["risk"],
            "female_threshold":  best.get("threshold"),
        },

        "after_preprocessing": {
            **m_s3,
            "fairness_label": fairness_label_fn(m_s3["spd"], m_s3["di"], m_s3["accuracy"]),
        },

        "improvement":        comparison["improvement_pct"],
        "mitigation_status":  status.lower(),
        "mitigation_verdict": {
            "outcome":         status,
            "verdict_label":   comparison["verdict_label"],
            "verdict_detail":  comparison["verdict_detail"],
            "improvement_pct": comparison["improvement_pct"],
            "spd_improved":    comparison["spd_improvement"] > 0,
            "di_improved":     comparison["di_improvement"]  > 0,
        },

        "all_stages":    all_stage_list,
        "dataset_info":  dataset_info,
        "proxy_features": [{"name": p, "explanation": PROXY_EXPLANATIONS[p]} for p in proxies],

        "impact_assessment": _build_impact_assessment(m_s0, best_m, status),

        "fair_dataset_available": fair_available,
        "fair_dataset_info":      fair_info,

        "explanation": gemini_out.get("explanation", ""),
        "risk": _build_consistent_risk(gemini_out, decision, m_s0, best_m),
    }

    _last_is_mitigated = True

    if csv_hash:
        _result_cache[csv_hash] = result

    return result


# =============================================================================
# ENDPOINTS
# =============================================================================

@app.get("/health")
def health():
    return {
        "status":            "ok",
        "version":           "12.0.0",
        "gemini_configured": bool(_gemini_client),
        "fair_csv_ready":    _fair_df is not None,
        "last_is_mitigated": _last_is_mitigated,
        "cache_entries":     len(_result_cache),
        "threshold_cache_entries": len(_threshold_cache),
        "thresholds": {
            "spd_safe":       SPD_SAFE,        # §B1
            "spd_borderline": SPD_BORDERLINE,  # §B1
            "di_low":         DI_LOW,
            "di_high":        DI_HIGH,
            "min_accuracy":   MIN_ACCURACY,
        },
        "zones": {
            "SAFE":       f"|SPD| <= {SPD_SAFE}",
            "BORDERLINE": f"{SPD_SAFE} < |SPD| <= {SPD_BORDERLINE}",
            "NOT SAFE":   f"|SPD| > {SPD_BORDERLINE}",
        },
        "stability": {
            "convergence_delta":   CONVERGENCE_DELTA,
            "stability_tolerance": STABILITY_TOLERANCE,
            "balance_threshold":   BALANCE_THRESHOLD,
            "overcorrection_min":  OVERCORRECTION_MIN,
        },
    }


@app.post("/detect-columns")
async def detect_columns_endpoint(file: UploadFile = File(...)):
    """
    §C3: Pre-flight endpoint — reads the CSV and returns detected column candidates.
    The frontend calls this immediately after file selection to populate dropdowns.
    No ML is run; only column names and value distributions are inspected.

    Returns:
    {
      "protected_candidates": ["sex", "gender"],
      "target_candidates":    ["income", "hired"],
      "auto_protected":       "sex",
      "auto_target":          "income",
      "all_columns":          [...],
      "suitable":             true,
      "column_previews":      { "income": { "values": [...], "class_count": 2, "is_binary": true }, ... },
      "warnings":             []
    }
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Only CSV files are accepted.")
    try:
        contents = await file.read()
        df = pd.read_csv(io.BytesIO(contents))
    except Exception as e:
        raise HTTPException(400, f"Could not parse CSV: {e}")

    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    result = detect_columns(df)

    # §V4 — Build per-column preview (value distribution + binary check).
    # Done for ALL columns so the UI can show live feedback when the user changes
    # the dropdown selection, not just for auto-detected candidates.
    column_previews: dict[str, dict] = {}
    for col in df.columns:
        raw_vals = df[col].dropna().astype(str).str.strip()
        val_counts = raw_vals.value_counts()
        top_vals = val_counts.head(8).to_dict()
        n_unique = int(val_counts.shape[0])

        # Check if this column encodes to a binary target
        encoded = _encode_target(df[col])
        n_classes = len(set(encoded))
        is_binary = n_classes == 2

        column_previews[col] = {
            "unique_count":  n_unique,
            "top_values":    top_vals,       # {value: count}
            "class_count":   n_classes,      # after encoding: 1 or 2
            "is_binary":     is_binary,      # True only if encoding yields exactly 2 classes
            "total_rows":    int(len(df[col].dropna())),
        }

    # §V2 — Pre-check: warn if the auto-detected target is single-class after encoding.
    warnings: list[str] = []
    auto_tgt = result.get("auto_target")
    if auto_tgt and auto_tgt in column_previews:
        prev = column_previews[auto_tgt]
        if not prev["is_binary"]:
            warnings.append(
                f"Auto-detected target column '{auto_tgt}' encodes to only "
                f"{prev['class_count']} class(es). A binary outcome is required. "
                "Please select a different target column."
            )

    # §V1 — Warn if auto-detected columns are the same.
    auto_prot = result.get("auto_protected")
    if auto_prot and auto_tgt and auto_prot == auto_tgt:
        warnings.append(
            f"Auto-detected protected attribute and target are both '{auto_prot}'. "
            "They must be different columns. Please select them manually."
        )

    result["column_previews"] = column_previews
    result["warnings"]        = warnings

    if not result["suitable"]:
        # §C8: return 422 with clear message when dataset is not suitable
        missing = []
        if not result["auto_protected"]:
            missing.append(
                f"protected attribute (checked: {PROTECTED_ATTR_CANDIDATES}). "
                "Rename your column or select manually."
            )
        if not result["auto_target"]:
            missing.append(
                f"target column (checked: {TARGET_COL_CANDIDATES}). "
                "Select a binary outcome column such as: hired, approved, income."
            )
        return JSONResponse(
            status_code=422,
            content={
                **result,
                "error": "Dataset not suitable for fairness analysis",
                "missing": missing,
                "suggestion": (
                    "This dataset cannot be analysed automatically. "
                    "Use the dropdowns to manually select a protected attribute "
                    "and a binary outcome column. If no binary outcome column exists, "
                    "please upload a dataset that includes one."
                ),
            }
        )

    return JSONResponse(content=result)


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    protected_col: str | None = Form(default=None),
    target_col:    str | None = Form(default=None),
):
    """
    §C4: Accepts optional protected_col and target_col form fields.
    If omitted, auto-detects from known column name lists.
    Backward-compatible: existing calls without these fields continue to work.
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Only CSV files are accepted.")

    try:
        contents = await file.read()
        df = pd.read_csv(io.BytesIO(contents))
    except Exception as e:
        raise HTTPException(400, f"Could not parse CSV: {e}")

    h = dataset_hash(contents)
    if h in _result_cache:
        cached = _result_cache[h]
        return JSONResponse(content={**cached, "_cache_hit": True, "_data_hash": h})

    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    # §C8: Dynamic validation — uses resolved columns
    validate_dataframe(df, protected_col=protected_col, target_col=target_col)

    try:
        result = run_analysis(df, csv_hash=h,
                              protected_col=protected_col,
                              target_col=target_col)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Analysis failed: {e}")

    return JSONResponse(content={**result, "_cache_hit": False, "_data_hash": h})


@app.get("/download/fair-dataset")
@app.get("/download-fixed")           # backward-compat alias
def download_fair_dataset():
    """
    §F1: Returns the corrected CSV only when mitigation was applied AND
    the post-mitigation model was still biased (dataset was worth correcting).

    Returns 409 if:
      - Last analysis returned status == "ALREADY FAIR" (is_mitigated=False)
      - Post-mitigation model achieved fairness (is_fair_after=True, no CSV generated)

    Returns 404 if /analyze has not been called yet.
    §5: StreamingResponse from in-memory buffer — never HTML, never a temp file.
    """
    if _last_is_mitigated is None:
        raise HTTPException(
            404,
            detail="No analysis has been run yet. Run POST /analyze first."
        )
    if _last_is_mitigated is False:
        raise HTTPException(
            409,
            detail=(
                "Dataset already meets fairness thresholds. "
                "No further correction applied. "
                "(is_mitigated=false — the original data is already fair)"
            )
        )
    if _fair_df is None:
        raise HTTPException(
            409,
            detail=(
                "No corrected dataset available. "
                "The model achieved fairness after mitigation — "
                "no corrected dataset was generated (is_fair_after=true). "
                "The mitigated model itself is the deliverable."
            )
        )

    # §5: pandas -> StringIO buffer -> StreamingResponse
    buf = io.StringIO()
    _fair_df.to_csv(buf, index=False)
    csv_text = buf.getvalue()

    # Sanity assertion — will raise 500 if something went catastrophically wrong
    if csv_text.strip().startswith("<"):
        raise HTTPException(500, "Internal error: CSV buffer contains HTML. Contact support.")

    n_rows = len(csv_text.splitlines()) - 1
    print(f"[FairLens /download] Serving CSV: {len(csv_text):,} chars, {n_rows} data rows")

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={
            "Content-Disposition":    'attachment; filename="fairlens_corrected_dataset.csv"',
            "Cache-Control":          "no-cache, no-store, must-revalidate",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.delete("/cache")
def clear_cache():
    """§D4 + §B3: Clear both the result cache and the threshold cache."""
    rc = len(_result_cache)
    tc = len(_threshold_cache)
    _result_cache.clear()
    _threshold_cache.clear()
    return {
        "cleared_results":    rc,
        "cleared_thresholds": tc,
        "message": f"Cleared {rc} result(s) and {tc} threshold(s).",
    }


@app.get("/sample-csv")
def sample_csv_info():
    return {
        "required_columns": ["sex", "income"],
        "sex_values":        ["Male", "Female"],
        "income_values":     [">50K", "<=50K"],
        "optional_columns":  list(PROXY_EXPLANATIONS.keys()),
        "min_rows":          50,
        "fairness_thresholds": {
            "|SPD| <=": SPD_THRESHOLD,
            "DI range":  [DI_LOW, DI_HIGH],
            "accuracy >=": MIN_ACCURACY,
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
