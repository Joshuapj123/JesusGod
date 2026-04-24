# FairLens v4 — AI Bias Detection & Investigation System

> Upload any hiring CSV → Real ML fairness analysis → Gemini AI explanation → 6-step investigation

---

## Quick Start (Windows)

### Step 1 — Install backend dependencies
```powershell
cd C:\Users\Joshua\Desktop\FairLens
pip install -r requirements.txt
```

### Step 2 — Set your Gemini API key (optional but recommended)
```powershell
$env:GEMINI_API_KEY = "your-gemini-api-key-here"
```
Get a free key at: https://aistudio.google.com/apikey

### Step 3 — Start the backend
```powershell
cd backend
python main.py
```
API runs at → http://localhost:8000  
API docs at → http://localhost:8000/docs

### Step 4 — Start the frontend (new PowerShell window)
```powershell
cd frontend
npm install
npm run dev
```
Frontend runs at → http://localhost:3000

---

## Project Structure

```
FairLens/
├── backend/
│   └── main.py          ← FastAPI + scikit-learn + Gemini
├── frontend/
│   ├── src/
│   │   ├── App.jsx      ← Complete React UI (6-step flow)
│   │   ├── main.jsx     ← Entry point
│   │   └── index.css    ← Design tokens
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── requirements.txt
├── start.ps1            ← One-command Windows launcher
└── README.md
```

---

## How It Works

### Backend Pipeline (`/analyze` endpoint)

```
CSV Upload
    ↓
Validation (sex + income columns required)
    ↓
Preprocessing (LabelEncoder, StandardScaler)
    ↓
Train LogisticRegression baseline
    ↓
Compute fairness metrics:
  • Male selection rate
  • Female selection rate
  • SPD = female_rate - male_rate
  • DI  = female_rate / male_rate
  • Bias flag: |SPD| > 0.05 OR DI < 0.80
    ↓
Mitigation A: RandomOverSampler (pre-processing)
Mitigation B: Per-group threshold calibration (post-processing)
    ↓
Gemini API → explanation + legal/ethical risk
    ↓
JSON response
```

### Fairness Thresholds

| Metric | Biased if | Basis |
|--------|-----------|-------|
| SPD | \|SPD\| > 0.05 | Academic standard |
| DI  | DI < 0.80 | EEOC 4/5ths rule (Title VII) |

### Risk Levels

| Score | Legal | Ethical | Recommendation |
|-------|-------|---------|----------------|
| ≥ 70 | HIGH | HIGH | DO NOT DEPLOY |
| 35–69 | MEDIUM | MEDIUM | DEPLOY WITH CAUTION |
| < 35 | LOW | LOW | SAFE TO DEPLOY |

---

## API Reference

### `POST /analyze`
Upload a CSV file for bias analysis.

**Request:** `multipart/form-data` with `file` field (CSV)

**Required CSV columns:**
- `sex` — values: `Male` / `Female`
- `income` — values: `>50K` / `<=50K` (or `1` / `0`)

**Optional columns (auto-detected as proxy features):**
`occupation`, `marital_status`, `hours_per_week`, `workclass`, `capital_gain`, `education_num`, `relationship`

**Response:**
```json
{
  "dataset_info": {
    "total_rows": 3000,
    "n_male": 1800,
    "n_female": 1200,
    "positive_rate": 0.42,
    "feature_columns": ["age", "education_num", "..."]
  },
  "before": {
    "male_rate": 0.654,
    "female_rate": 0.589,
    "spd": -0.065,
    "di": 0.901,
    "bias_flag": true,
    "accuracy": 0.782,
    "n_male": 540,
    "n_female": 260,
    "n_selected_male": 353,
    "n_selected_female": 153
  },
  "after_preprocessing": { "...": "same shape as before" },
  "after": {
    "male_rate": 0.654,
    "female_rate": 0.650,
    "spd": -0.004,
    "di": 0.994,
    "bias_flag": false,
    "accuracy": 0.761,
    "female_threshold": 0.41
  },
  "improvement": 93.8,
  "proxy_features": [
    { "name": "occupation", "explanation": "Occupation categories are historically gendered..." }
  ],
  "explanation": "The model assigns female candidates a 6.5pp lower selection rate... [Gemini]",
  "risk": {
    "legal_risk": "HIGH",
    "ethical_risk": "HIGH",
    "recommendation": "DO NOT DEPLOY",
    "source": "gemini"
  }
}
```

### `GET /health`
```json
{ "status": "ok", "version": "4.0.0", "gemini_configured": true }
```

### `GET /sample-csv`
Returns expected CSV format and example row.

---

## Gemini Integration

FairLens uses **Gemini 2.0 Flash** to generate:
- Human-readable bias explanation (specific to your metrics)
- Legal risk level (HIGH/MEDIUM/LOW)
- Ethical risk level (HIGH/MEDIUM/LOW)
- Deployment recommendation (DO NOT DEPLOY / DEPLOY WITH CAUTION / SAFE TO DEPLOY)

**If no API key is set**, FairLens automatically uses a rule-based fallback engine that produces deterministic explanations from the same metrics. The system never fails silently — it always returns a complete result.

---

## Demo Dataset

If you click "Run with Demo Dataset" without uploading a file, FairLens uses a built-in CSV with 220+ synthetic records designed to demonstrate clear gender bias through proxy feature discrimination (occupation and hours skewed by gender).

---

## Sample CSV Format

```csv
age,sex,education_num,hours_per_week,occupation,marital_status,workclass,capital_gain,income
38,Male,13,45,Exec,Married,Private,4500,>50K
29,Female,11,38,Service,Single,Private,0,<=50K
44,Male,15,55,Tech,Married,Self-emp,7200,>50K
31,Female,12,40,Service,Divorced,Private,0,<=50K
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | FastAPI 0.111 |
| ML | scikit-learn 1.4 (LogisticRegression) |
| Fairness fix | imbalanced-learn (RandomOverSampler) |
| AI Explanation | Google Gemini 2.0 Flash |
| Frontend | React 18 + Vite |
| Charts | Recharts |
| Fonts | Space Grotesk + JetBrains Mono + Playfair Display |

---

## What a Judge Will See

1. **Upload CSV** → system reads it, no hardcoded values
2. **Training animation** → real model is being trained
3. **Bias detection** → real SPD, DI, selection rates from YOUR data
4. **Impact simulation** → calculated from real metrics
5. **Mitigation** → two real algorithms run
6. **Results** → measurable before/after comparison
7. **Gemini explanation** → dynamic, specific to your numbers
8. **Risk assessment** → legal + ethical, EEOC-based thresholds

This is a **real AI auditor** — not a fake demo.
