import { useState, useCallback, useRef, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceLine, Cell
} from 'recharts'

const API = ''   // same origin via Vite proxy

// ─── Design tokens as JS ─────────────────────────────────────────────────────
const C = {
  red: '#ff3d5a', amber: '#ffb347', green: '#00e5a0',
  blue: '#4facfe', purple: '#a78bfa', muted: '#5a5a8a',
  text: '#ddddf0', edge: '#252540', surface: '#121220', lift: '#1a1a2e',
}
const riskColor = (level) =>
  ({ HIGH: C.red, MEDIUM: C.amber, LOW: C.green, CRITICAL: C.red }[level] ?? C.muted)

const recColor = (rec) =>
  rec?.includes('NOT') ? C.red : rec?.includes('CAUTION') ? C.amber : C.green

// ─── Column detection helpers ─────────────────────────────────────────────────
// Labels shown in the UI for known protected attributes
const PROTECTED_LABELS = {
  sex: 'Sex / Gender', gender: 'Gender', race: 'Race',
  ethnicity: 'Ethnicity', age: 'Age',
}
const TARGET_LABELS = {
  income: 'Income (>50K)', hired: 'Hired', approved: 'Approved',
  label: 'Label', outcome: 'Outcome', target: 'Target', result: 'Result',
}

// ─── Column Picker component ──────────────────────────────────────────────────
const ColumnPicker = ({ detection, colConfig, onChange }) => {
  if (!detection) return null
  const { protected_candidates, target_candidates, all_columns,
          column_previews = {}, warnings: detectionWarnings = [] } = detection

  // §V1 — Same-column guard: block if both selects point to the same column
  const sameColumn = (
    colConfig.protected_col &&
    colConfig.target_col &&
    colConfig.protected_col === colConfig.target_col
  )

  // §V2 — Binary check for the currently selected target column
  const targetPreview = colConfig.target_col ? column_previews[colConfig.target_col] : null
  const targetIsBinary = targetPreview ? targetPreview.is_binary : true  // assume ok if no preview yet
  const targetNotBinary = targetPreview && !targetPreview.is_binary

  // §V2 — Binary check for selected protected column
  const protPreview = colConfig.protected_col ? column_previews[colConfig.protected_col] : null
  const protTooFewValues = protPreview && protPreview.unique_count < 2

  const selectStyle = (hasError) => ({
    width: '100%', padding: '10px 12px',
    background: C.lift,
    border: `1px solid ${hasError ? C.red : C.edge}`,
    color: C.text, fontFamily: 'var(--ff-mono)', fontSize: 12,
    cursor: 'pointer', outline: 'none', borderRadius: 2,
    transition: 'border-color 0.2s',
  })
  const labelStyle = {
    fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted,
    letterSpacing: 2, marginBottom: 6, textTransform: 'uppercase',
  }

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.edge}`,
      padding: 20, marginBottom: 20,
    }}>
      <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.amber,
        letterSpacing: 2, marginBottom: 16 }}>
        🔧 COLUMN CONFIGURATION
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 14 }}>
        {/* Protected attribute */}
        <div>
          <div style={labelStyle}>Protected Attribute</div>
          <select
            value={colConfig.protected_col || ''}
            onChange={e => onChange({ ...colConfig, protected_col: e.target.value })}
            style={selectStyle(sameColumn || protTooFewValues)}
          >
            <option value="">— Select column —</option>
            {protected_candidates.length > 0 && (
              <optgroup label="Detected">
                {protected_candidates.map(c => (
                  <option key={c} value={c}>{PROTECTED_LABELS[c] ?? c} ({c})</option>
                ))}
              </optgroup>
            )}
            <optgroup label="All columns">
              {all_columns
                .filter(c => !protected_candidates.includes(c))
                .map(c => <option key={c} value={c}>{c}</option>)}
            </optgroup>
          </select>
          {/* Protected attribute error states */}
          {protTooFewValues && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.red, marginTop: 5, lineHeight: 1.5 }}>
              ✗ Column '{colConfig.protected_col}' has only {protPreview.unique_count} unique value — need at least 2 groups to compare.
            </div>
          )}
          {!protTooFewValues && protPreview && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, marginTop: 5, lineHeight: 1.5 }}>
              {protPreview.unique_count} unique values · {protPreview.total_rows} records
            </div>
          )}
          {!colConfig.protected_col && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, marginTop: 5, lineHeight: 1.5 }}>
              The column whose values define the groups to compare (e.g. sex, race).
            </div>
          )}
        </div>

        {/* Target / outcome */}
        <div>
          <div style={labelStyle}>Target / Outcome Column</div>
          <select
            value={colConfig.target_col || ''}
            onChange={e => onChange({ ...colConfig, target_col: e.target.value })}
            style={selectStyle(sameColumn || targetNotBinary)}
          >
            <option value="">— Select column —</option>
            {target_candidates.length > 0 && (
              <optgroup label="Detected">
                {target_candidates.map(c => (
                  <option key={c} value={c}>{TARGET_LABELS[c] ?? c} ({c})</option>
                ))}
              </optgroup>
            )}
            <optgroup label="All columns">
              {all_columns
                .filter(c => !target_candidates.includes(c))
                .map(c => <option key={c} value={c}>{c}</option>)}
            </optgroup>
          </select>
          {/* Target column error / preview states */}
          {targetNotBinary && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.red, marginTop: 5, lineHeight: 1.5 }}>
              ✗ Target column must contain at least 2 classes (e.g. 0/1, yes/no).
              After encoding, only {targetPreview.class_count} class found.
              {targetPreview.unique_count <= 8 && (
                <span> Values: {Object.keys(targetPreview.top_values).join(', ')}</span>
              )}
            </div>
          )}
          {!targetNotBinary && targetPreview && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.green, marginTop: 5, lineHeight: 1.5 }}>
              ✓ Binary column · {targetPreview.unique_count} unique values · {targetPreview.total_rows} records
            </div>
          )}
          {!colConfig.target_col && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, marginTop: 5, lineHeight: 1.5 }}>
              The column the model predicts (e.g. income, hired). Binary outcome required.
            </div>
          )}
        </div>
      </div>

      {/* §V1 — Same-column error */}
      {sameColumn && (
        <div style={{
          padding: '10px 14px', marginBottom: 10,
          background: `${C.red}12`, border: `1px solid ${C.red}40`,
          fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.red,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          ✗ Protected attribute and target must be different columns.
          Both are set to <strong style={{ color: C.amber }}>{colConfig.protected_col}</strong> — please select a different column for each role.
        </div>
      )}

      {/* Detection warnings from backend */}
      {detectionWarnings.map((w, i) => (
        <div key={i} style={{
          padding: '10px 14px', marginBottom: 10,
          background: `${C.amber}10`, border: `1px solid ${C.amber}40`,
          fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.amber,
        }}>
          ⚠ {w}
        </div>
      ))}

      {/* §V4 — Live confirmation / summary when both columns are valid */}
      {colConfig.protected_col && colConfig.target_col && !sameColumn && !targetNotBinary && !protTooFewValues && (
        <div style={{
          padding: '10px 14px',
          background: `${C.green}08`, border: `1px solid ${C.green}25`,
          fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.green,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span>✓</span>
          Analysing bias in{' '}
          <strong style={{ color: C.amber }}>{colConfig.target_col}</strong> predictions
          {' '}across{' '}
          <strong style={{ color: C.amber }}>{colConfig.protected_col}</strong> groups
          {targetPreview && (
            <span style={{ marginLeft: 'auto', color: C.muted }}>
              {targetPreview.total_rows} rows · binary ✓
            </span>
          )}
        </div>
      )}

      {/* §FIX-6 — Dataset not suitable warning */}
      {detection.suitable === false && (
        <div style={{
          marginTop: 14, padding: '14px 18px',
          background: `${C.amber}10`, border: `1px solid ${C.amber}40`,
          fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.amber, lineHeight: 1.7,
        }}>
          ⚠ No known protected or target columns detected automatically.
          <br />
          Please select them manually from the dropdowns above.
          If this dataset has no binary outcome column,{' '}
          <span style={{ color: C.text }}>it cannot be used for fairness analysis</span>.
        </div>
      )}
    </div>
  )
}

// ─── Utility components ───────────────────────────────────────────────────────
const Mono = ({ children, style = {} }) => (
  <span style={{ fontFamily: 'var(--ff-mono)', ...style }}>{children}</span>
)

const Tag = ({ label, color }) => (
  <span style={{
    fontFamily: 'var(--ff-mono)', fontSize: 10, letterSpacing: 2,
    padding: '2px 8px', borderRadius: 2,
    background: `${color}20`, border: `1px solid ${color}50`, color,
    textTransform: 'uppercase',
  }}>{label}</span>
)

const Pill = ({ value, good, bad, neutral }) => {
  const color = value === good ? C.green : value === bad ? C.red : C.amber
  return (
    <span style={{
      fontFamily: 'var(--ff-mono)', fontSize: 11, fontWeight: 700,
      letterSpacing: 1, padding: '3px 10px',
      background: `${color}18`, border: `1px solid ${color}40`, color,
      borderRadius: 3, textTransform: 'uppercase',
    }}>{value}</span>
  )
}

const Card = ({ children, style = {}, glow }) => (
  <div style={{
    background: C.surface, border: `1px solid ${C.edge}`,
    padding: 24, position: 'relative', overflow: 'hidden',
    boxShadow: glow ? `0 0 30px ${glow}18` : 'none',
    ...style,
  }}>{children}</div>
)

const SectionTitle = ({ step, title, sub }) => (
  <div style={{ marginBottom: 28 }}>
    <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, letterSpacing: 4, color: C.muted, marginBottom: 8 }}>
      STEP {String(step).padStart(2,'0')}
    </div>
    <h2 style={{ fontFamily: 'var(--ff-serif)', fontSize: 28, color: C.text, marginBottom: 6, lineHeight: 1.2 }}>
      {title}
    </h2>
    {sub && <p style={{ color: C.muted, fontSize: 13, fontWeight: 300 }}>{sub}</p>}
  </div>
)

const GaugeBar = ({ value, max = 100, color, label, animated }) => {
  const [w, setW] = useState(0)
  useEffect(() => {
    if (animated) setTimeout(() => setW(Math.min((value / max) * 100, 100)), 100)
    else setW(Math.min((value / max) * 100, 100))
  }, [value, animated])
  return (
    <div>
      {label && <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, marginBottom: 4, letterSpacing: 1 }}>{label}</div>}
      <div style={{ height: 6, background: C.edge, position: 'relative', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${w}%`, background: color,
          transition: 'width 1.2s cubic-bezier(0.22,1,0.36,1)',
          boxShadow: `0 0 8px ${color}`,
        }} />
      </div>
    </div>
  )
}

// ─── Custom Tooltip for Recharts ───────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0d0d1a', border: `1px solid ${C.edge}`, padding: '10px 14px' }}>
      <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontFamily: 'var(--ff-mono)', fontSize: 12, color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? (p.value > 1 ? p.value.toFixed(1) + '%' : p.value.toFixed(4)) : p.value}
        </div>
      ))}
    </div>
  )
}

// ─── Step Progress Bar ─────────────────────────────────────────────────────────
const StepNav = ({ current, total = 6, onStep, canNavigate }) => (
  <div style={{
    position: 'sticky', top: 0, zIndex: 100,
    background: 'rgba(7,7,15,0.95)', backdropFilter: 'blur(12px)',
    borderBottom: `1px solid ${C.edge}`, padding: '0 24px',
    display: 'flex', gap: 0,
  }}>
    {Array.from({ length: total }, (_, i) => {
      const n = i + 1
      const active = n === current
      const done   = n < current
      return (
        <button key={n} onClick={() => canNavigate && onStep(n)}
          style={{
            flex: 1, padding: '12px 8px', background: 'transparent',
            border: 'none', borderBottom: `2px solid ${active ? C.amber : done ? C.green : 'transparent'}`,
            cursor: canNavigate ? 'pointer' : 'default',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            opacity: (active || done) ? 1 : 0.35, transition: 'all 0.2s',
          }}>
          <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, letterSpacing: 1, color: active ? C.amber : done ? C.green : C.muted }}>
            {String(n).padStart(2,'0')}
          </span>
          <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.text, letterSpacing: 0.5 }}>
            {['Dataset','Training','Bias Found','Impact','Mitigation','Results'][i]}
          </span>
        </button>
      )
    })}
  </div>
)

// ─── STEP 1: Upload ───────────────────────────────────────────────────────────
const StepUpload = ({ file, onFile, onRun, loading, error,
                      detection, colConfig, onColConfig }) => {
  const inputRef = useRef()
  const [drag, setDrag] = useState(false)

  const handleDrop = useCallback(e => {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f?.name.endsWith('.csv')) onFile(f)
  }, [onFile])

  const sameCol = colConfig.protected_col && colConfig.target_col &&
                  colConfig.protected_col === colConfig.target_col
  const targetPrev = detection?.column_previews?.[colConfig.target_col]
  const targetBad  = targetPrev && !targetPrev.is_binary
  const protPrev   = detection?.column_previews?.[colConfig.protected_col]
  const protBad    = protPrev && protPrev.unique_count < 2

  // §V1+V2+V5: run is blocked when:
  //   - still loading
  //   - a file is selected but columns aren't chosen yet
  //   - same column selected for both roles
  //   - target column is not binary
  //   - protected attribute has < 2 unique values
  const colsValid = !file || (
    colConfig.protected_col && colConfig.target_col &&
    !sameCol && !targetBad && !protBad
  )
  const canRun = !loading && colsValid

  const btnLabel = loading
    ? 'ANALYZING…'
    : sameCol
      ? 'SAME COLUMN SELECTED — CHOOSE DIFFERENT COLUMNS'
      : targetBad
        ? 'TARGET IS NOT BINARY — SELECT A DIFFERENT OUTCOME COLUMN'
        : protBad
          ? 'PROTECTED ATTRIBUTE HAS < 2 VALUES — SELECT A DIFFERENT COLUMN'
          : file && !(colConfig.protected_col && colConfig.target_col)
            ? 'SELECT COLUMNS ABOVE TO CONTINUE'
            : file
              ? 'REVEAL HIDDEN BIAS →'
              : 'RUN WITH DEMO DATASET →'

  return (
    <div>
      <SectionTitle step={1} title="Upload any dataset." sub="Drop any CSV — FairLens automatically detects protected attributes and outcome columns, or you can select them manually." />

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current.click()}
        style={{
          border: `2px dashed ${drag ? C.amber : file ? C.green : C.edge}`,
          background: drag ? `${C.amber}08` : file ? `${C.green}06` : C.surface,
          padding: '48px 32px', textAlign: 'center', cursor: 'pointer',
          transition: 'all 0.2s', marginBottom: 20,
        }}>
        <input ref={inputRef} type="file" accept=".csv" style={{ display:'none' }}
          onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
        <div style={{ fontSize: 32, marginBottom: 12 }}>{file ? '✅' : '📂'}</div>
        {file ? (
          <>
            <div style={{ fontFamily: 'var(--ff-mono)', color: C.green, fontSize: 13, marginBottom: 4 }}>
              {file.name}
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>{(file.size / 1024).toFixed(1)} KB — click to replace</div>
          </>
        ) : (
          <>
            <div style={{ color: C.text, fontSize: 14, marginBottom: 4, fontWeight: 500 }}>Drop any CSV file here or click to browse</div>
            <div style={{ color: C.muted, fontSize: 12 }}>
              Supported: datasets with <Mono style={{ color: C.amber }}>sex, gender, race, ethnicity</Mono> ×{' '}
              <Mono style={{ color: C.amber }}>income, hired, approved, label…</Mono>
            </div>
          </>
        )}
      </div>

      {/* Column picker — shown after file is selected and detection runs */}
      {file && (
        <ColumnPicker
          detection={detection}
          colConfig={colConfig}
          onChange={onColConfig}
        />
      )}

      {/* Expected format hint */}
      {!file && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 12 }}>EXAMPLE FORMAT (any of these work)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { col: 'sex / gender', ex: 'Male, Female' },
              { col: 'race / ethnicity', ex: 'White, Black, Hispanic…' },
              { col: 'income / hired / approved', ex: '>50K / <=50K  or  1 / 0  or  yes / no' },
            ].map(r => (
              <div key={r.col} style={{ display: 'flex', gap: 16, fontFamily: 'var(--ff-mono)', fontSize: 11 }}>
                <span style={{ color: C.amber, minWidth: 160 }}>{r.col}</span>
                <span style={{ color: C.muted }}>{r.ex}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {error && (
        <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}40`, padding: '14px 18px', marginBottom: 20, color: C.red, fontFamily: 'var(--ff-mono)', fontSize: 12 }}>
          ⚠ {error}
        </div>
      )}

      <button onClick={onRun} disabled={!canRun}
        style={{
          width: '100%', padding: '16px 0',
          background: !canRun ? C.edge : C.amber, color: !canRun ? C.muted : '#000',
          border: 'none', cursor: !canRun ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 14,
          letterSpacing: 2, transition: 'all 0.2s',
          clipPath: 'polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))',
        }}>
        {loading ? 'ANALYZING…'
          : sameCol ? 'SAME COLUMN SELECTED — CHOOSE DIFFERENT COLUMNS'
          : targetBad ? 'TARGET NOT BINARY — SELECT DIFFERENT OUTCOME COLUMN'
          : protBad ? 'PROTECTED ATTRIBUTE HAS < 2 VALUES'
          : file && !(colConfig.protected_col && colConfig.target_col)
            ? 'SELECT COLUMNS ABOVE TO CONTINUE'
            : file ? 'REVEAL HIDDEN BIAS →'
            : 'RUN WITH DEMO DATASET →'}
      </button>
    </div>
  )
}

// ─── STEP 2: Training animation ───────────────────────────────────────────────
const StepTraining = ({ progress }) => {
  const logs = [
    'Loading dataset into pandas DataFrame…',
    'Detecting protected attributes and outcome columns…',
    'Encoding categorical variables (LabelEncoder)…',
    'Splitting train/test sets 70/30 (stratified)…',
    'Fitting StandardScaler on training data…',
    'Training LogisticRegression (max_iter=1000)…',
    'Model converged. Computing predictions…',
    '⚠ Running FairLens fairness audit…',
  ]
  const visibleLogs = logs.slice(0, Math.max(1, Math.ceil(progress / 13)))

  return (
    <div>
      <SectionTitle step={2} title="Training model on historical data…" sub="A logistic regression classifier learns patterns from your dataset — including patterns we never intended to teach it." />

      <Card style={{ textAlign: 'center', padding: '48px 32px', marginBottom: 20 }}>
        {/* Pulse ring */}
        <div style={{ position: 'relative', width: 80, height: 80, margin: '0 auto 28px' }}>
          {[0,1].map(i => (
            <div key={i} style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              border: `2px solid ${C.amber}`,
              animation: `pulse 2s ease-out ${i}s infinite`,
            }} />
          ))}
          <div style={{
            position: 'absolute', inset: '50%', transform: 'translate(-50%,-50%)',
            width: 32, height: 32, borderRadius: '50%', background: C.amber,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          }}>🧠</div>
        </div>

        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted, marginBottom: 6, letterSpacing: 1 }}>MODEL CONVERGENCE</div>
        <div style={{ fontFamily: 'var(--ff-sans)', fontSize: 22, fontWeight: 700, color: C.amber, marginBottom: 24 }}>
          {Math.round(progress)}%
        </div>

        <div style={{ height: 4, background: C.edge, overflow: 'hidden', marginBottom: 24 }}>
          <div style={{
            height: '100%', width: `${progress}%`, background: `linear-gradient(90deg, ${C.amber}, #ff8800)`,
            transition: 'width 0.4s ease', boxShadow: `0 0 8px ${C.amber}`,
          }} />
        </div>
      </Card>

      {/* Training log */}
      <Card>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 12 }}>TRAINING LOG</div>
        <div style={{ maxHeight: 160, overflow: 'hidden' }}>
          {visibleLogs.map((log, i) => (
            <div key={i} style={{
              fontFamily: 'var(--ff-mono)', fontSize: 11, lineHeight: 2,
              color: i === visibleLogs.length - 1 ? (log.includes('⚠') ? C.amber : C.green) : C.muted,
              opacity: i === visibleLogs.length - 1 ? 1 : 0.6,
            }}>
              › {log}
            </div>
          ))}
        </div>
      </Card>

      <style>{`@keyframes pulse { 0% { transform: scale(1); opacity:1 } 100% { transform: scale(2.2); opacity:0 } }`}</style>
    </div>
  )
}

// ─── STEP 3: Bias Detection ───────────────────────────────────────────────────
const StepBiasDetection = ({ data }) => {
  const { before, proxy_features = [], explanation, risk } = data
  const cfg = data.dataset_info?.col_config || {}
  const groupA = cfg.group_a_label || 'Male'
  const groupB = cfg.group_b_label || 'Female'
  const protectedCol = cfg.protected_col || 'sex'

  const isAlreadyFair = data.status === 'ALREADY FAIR'
    || data.status === 'ALREADY PROCESSED'
    || data.is_mitigated === false

  const gap = Math.abs((before.male_rate - before.female_rate) * 100)

  const barData = [
    { name: groupA, rate: before.male_rate * 100, fill: C.blue },
    { name: groupB, rate: before.female_rate * 100, fill: isAlreadyFair ? C.green : C.red },
  ]

  return (
    <div>
      <SectionTitle
        step={3}
        title={isAlreadyFair ? 'Dataset already meets fairness thresholds.' : 'Bias detected. This is serious.'}
        sub={isAlreadyFair
          ? 'No bias was found. This dataset satisfies all fairness conditions.'
          : 'FairLens has audited the model predictions across gender groups. The results are alarming.'}
      />

      {/* Alarm banner — only when actually biased */}
      {!isAlreadyFair && (
        <div style={{
          border: `2px solid ${C.red}`, background: `${C.red}08`, padding: '20px 24px',
          display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28,
          animation: 'alarmPulse 1.5s ease-in-out infinite',
        }}>
          <span style={{ fontSize: 28, animation: 'shake 0.5s ease-in-out infinite alternate' }}>⚠️</span>
          <div>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 16, color: C.red, letterSpacing: 1 }}>
              SIGNIFICANT {protectedCol.toUpperCase()} BIAS DETECTED
            </div>
            <div style={{ color: '#ff8080', fontSize: 13, marginTop: 2 }}>
              This model systematically discriminates against {groupB} by {gap.toFixed(1)} percentage points.
            </div>
          </div>
        </div>
      )}

      {/* Already-fair confirmation banner */}
      {isAlreadyFair && (
        <div style={{
          border: `2px solid ${C.green}`, background: `${C.green}07`,
          padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28,
        }}>
          <span style={{ fontSize: 28 }}>✅</span>
          <div>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 15, color: C.green, letterSpacing: 1, marginBottom: 4 }}>
              {data.status === 'ALREADY PROCESSED'
                ? 'DATASET ALREADY PROCESSED — NO FURTHER MITIGATION NEEDED'
                : 'DATASET ALREADY FAIR — ALL THRESHOLDS MET'}
            </div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: `${C.green}90` }}>
              abs(SPD) = {Math.abs(before.spd).toFixed(3)} ≤ 0.05 · DI = {before.di.toFixed(3)} ≥ 0.80 · Accuracy = {(before.accuracy * 100).toFixed(1)}% ≥ 70%
            </div>
          </div>
        </div>
      )}

      {/* Big metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, marginBottom: 28, background: C.edge }}>
        {[
          { label: `${groupA} Selected`, val: `${(before.male_rate*100).toFixed(1)}%`, color: C.blue, sub: `${before.n_selected_male} of ${before.n_male}` },
          { label: `${groupB} Selected`, val: `${(before.female_rate*100).toFixed(1)}%`, color: isAlreadyFair ? C.green : C.red,
            sub: isAlreadyFair ? `${before.n_selected_female} of ${before.n_female}` : `${before.n_selected_female} of ${before.n_female} — severely low` },
          { label: 'Bias Score', val: isAlreadyFair ? 'LOW ✓' : 'HIGH ⚠',
            color: isAlreadyFair ? C.green : C.amber, sub: `SPD ${before.spd.toFixed(4)} · DI ${before.di.toFixed(4)}` },
        ].map(m => (
          <div key={m.label} style={{ background: C.surface, padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>{m.label}</div>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 38, color: m.color, lineHeight: 1, marginBottom: 8,
              textShadow: `0 0 30px ${m.color}60` }}>{m.val}</div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted }}>{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Gender bar comparison */}
      <Card style={{ marginBottom: 28 }}>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 16 }}>SELECTION RATE COMPARISON</div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={barData} barCategoryGap="40%">
            <XAxis dataKey="name" tick={{ fontFamily: 'var(--ff-mono)', fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontFamily: 'var(--ff-mono)', fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="rate" radius={[2,2,0,0]} label={{ position: 'top', fontFamily: 'var(--ff-mono)', fontSize: 12, fill: C.text, formatter: v => `${v.toFixed(1)}%` }}>
              {barData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Fairness metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
        {[
          { label: 'Statistical Parity Diff.', val: before.spd.toFixed(4), good: '≥ −0.05', bad: !isAlreadyFair && before.spd < -0.05, note: 'Negative = women disadvantaged' },
          { label: 'Disparate Impact', val: before.di.toFixed(4), good: '≥ 0.80 (EEOC)', bad: !isAlreadyFair && before.di < 0.80, note: 'Below 0.80 = legal violation' },
        ].map(m => (
          <Card key={m.label} glow={m.bad ? C.red : null}>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 8 }}>{m.label}</div>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 28, color: m.bad ? C.red : C.green, marginBottom: 4 }}>{m.val}</div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: m.bad ? `${C.red}90` : C.muted }}>{m.note}</div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, marginTop: 6 }}>Fair range: {m.good}</div>
          </Card>
        ))}
      </div>

      {/* Proxy features */}
      {proxy_features.length > 0 && (
        <Card style={{ marginBottom: 28 }}>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.purple, letterSpacing: 2, marginBottom: 14 }}>
            🔗 {proxy_features.length} PROXY DISCRIMINATION FEATURES DETECTED
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {proxy_features.map(p => (
              <div key={p.name} style={{
                background: `${C.purple}10`, border: `1px solid ${C.purple}30`,
                padding: '6px 12px', fontSize: 12,
              }}>
                <Mono style={{ color: C.purple, marginRight: 6 }}>{p.name}</Mono>
                <span style={{ color: C.muted }}>{p.explanation}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* AI Explanation */}
      {explanation && <AIExplanationCard explanation={explanation} />}

      {/* Risk panel */}
      {risk && <RiskPanel risk={risk} before={before} />}

      <style>{`
        @keyframes alarmPulse { 0%,100% { border-color: ${C.red}; box-shadow: none } 50% { border-color: #ff6b6b; box-shadow: 0 0 24px ${C.red}30 } }
        @keyframes shake { from { transform: rotate(-4deg) } to { transform: rotate(4deg) } }
      `}</style>
    </div>
  )
}

// ─── STEP 4: Impact simulation ────────────────────────────────────────────────
const StepImpact = ({ data }) => {
  const { before } = data
  const cfg    = data.dataset_info?.col_config || {}
  const groupA = cfg.group_a_label || 'Male'
  const groupB = cfg.group_b_label || 'Female'
  const N = 1000
  const aHired     = Math.round(before.male_rate   * N * 0.6)
  const bHired     = Math.round(before.female_rate * N * 0.4)
  const bRejected  = Math.round((1 - before.female_rate) * N * 0.4)
  const aOther     = N - aHired - bHired - bRejected

  const people = [
    ...Array(aHired).fill('ms'),
    ...Array(Math.max(0,aOther)).fill('mn'),
    ...Array(bHired).fill('fs'),
    ...Array(bRejected).fill('fr'),
  ].sort(() => Math.random() - 0.5)

  const colorMap = { ms: C.blue, mn: '#252540', fs: C.purple, fr: C.red }

  return (
    <div>
      <SectionTitle step={4} title="What this means for real people." sub="These aren't statistics. Each square is a real person's career opportunity, decided by a machine that learned the wrong lesson." />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, marginBottom: 28, background: C.edge }}>
        {[
          { n: aHired,    label: `${groupA} hired`,                  color: C.blue   },
          { n: bHired,    label: `${groupB} hired`,                  color: C.purple },
          { n: bRejected, label: `${groupB} unfairly rejected`,       color: C.red    },
        ].map(m => (
          <div key={m.label} style={{ background: C.surface, padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 44, color: m.color, lineHeight: 1, marginBottom: 6, textShadow: `0 0 24px ${m.color}50` }}>
              {m.n}
            </div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 1, textTransform: 'uppercase' }}>{m.label}</div>
          </div>
        ))}
      </div>

      {/* People grid */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.amber, letterSpacing: 2, marginBottom: 16 }}>
          APPLICANT SIMULATION — OUT OF {N.toLocaleString()} CANDIDATES
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 14 }}>
          {people.map((type, i) => (
            <div key={i} style={{
              width: 10, height: 16, borderRadius: '4px 4px 0 0',
              background: colorMap[type], opacity: type === 'mn' ? 0.3 : 0.85,
              transition: `opacity ${0.3 + i * 0.001}s`,
            }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {[
            [`${groupA} hired`, C.blue],
            [`${groupB} hired`, C.purple],
            [`${groupB} unfairly rejected`, C.red],
          ].map(([l,c]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />{l}
            </div>
          ))}
        </div>
      </Card>

      <div style={{ borderLeft: `3px solid ${C.red}`, background: `${C.red}06`, padding: '18px 24px' }}>
        <div style={{ fontStyle: 'italic', color: C.text, lineHeight: 1.8, marginBottom: 6 }}>
          "For every 1,000 applicants processed by this model, approximately{' '}
          <strong style={{ color: C.red }}>{bRejected} qualified {groupB}</strong> are denied
          opportunities they deserve — not because of ability, but because the algorithm learned from a biased past."
        </div>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted }}>— FairLens Bias Analysis Report</div>
      </div>
    </div>
  )
}


// ─── Mitigation Warnings ──────────────────────────────────────────────────────
const MitigationWarnings = ({ warnings = [], valid }) => {
  if (!warnings.length) return null
  return (
    <div style={{ marginTop: 20 }}>
      {warnings.map((w, i) => {
        const isDegraded  = w.includes('degraded model performance')
        const isDegenerate = w.includes('degenerate predictions')
        const isUncloseable = w.includes('too large for post-hoc')
        const color = isDegraded || isDegenerate ? C.red : C.amber
        const icon  = isDegraded || isDegenerate ? '🚫' : '⚠️'
        return (
          <div key={i} style={{
            background: `${color}10`, border: `1px solid ${color}40`,
            padding: '14px 18px', marginBottom: 10,
            display: 'flex', gap: 12, alignItems: 'flex-start',
          }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color, lineHeight: 1.7 }}>{w}</div>
          </div>
        )
      })}
      {valid && (
        <div style={{
          background: `${C.green}08`, border: `1px solid ${C.green}30`,
          padding: '10px 16px', fontFamily: 'var(--ff-mono)', fontSize: 11,
          color: C.green, display: 'flex', gap: 10, alignItems: 'center',
        }}>
          <span>✅</span> Mitigation applied within accuracy constraints. Results are meaningful.
        </div>
      )}
    </div>
  )
}


// ─── Download Fair Dataset Button ─────────────────────────────────────────────
const DownloadButton = ({ available, datasetInfo }) => {
  const [downloading, setDownloading] = useState(false)
  const [done, setDone]               = useState(false)
  const [err,  setErr]                = useState(null)

  const handleDownload = async () => {
    setDownloading(true); setErr(null); setDone(false)
    try {
      // Use absolute backend URL — never rely on Vite proxy for file downloads
      // because the proxy may return the React HTML shell instead of the CSV.
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/download-fixed`, {
        method: 'GET',
        headers: { 'Accept': 'text/csv' },
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: 'Download failed' }))
        throw new Error(e.detail || `Server error ${res.status}`)
      }
      // Verify we actually got CSV, not HTML
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('text/html')) {
        throw new Error('Server returned HTML instead of CSV. Check backend is running on port 8000.')
      }
      const blob = await res.blob()
      if (blob.size === 0) throw new Error('Downloaded file is empty.')
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = 'fairlens_corrected_dataset.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDone(true)
      setTimeout(() => setDone(false), 3000)
    } catch (e) {
      setErr(e.message)
    } finally {
      setDownloading(false)
    }
  }

  if (!available) return null

  return (
    <div style={{
      background: `${C.green}08`, border: `1px solid ${C.green}30`,
      padding: '20px 24px', marginTop: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span style={{ fontSize: 20 }}>📦</span>
        <div>
          <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 14, color: C.green, letterSpacing: 0.5 }}>
            Fair Dataset Ready
          </div>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 1, marginTop: 2 }}>
            BIAS-CORRECTED · GENDER-BALANCED · LABEL DIVERSITY PRESERVED
          </div>
        </div>
      </div>

      {/* Dataset stats */}
      {datasetInfo && (
        <div style={{
          display: 'flex', gap: 24, flexWrap: 'wrap',
          fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted,
          marginBottom: 16, paddingBottom: 14,
          borderBottom: `1px solid ${C.edge}`,
        }}>
          <span>Rows: <strong style={{ color: C.green }}>{datasetInfo.rows?.toLocaleString()}</strong></span>
          <span>Columns: <strong style={{ color: C.green }}>{datasetInfo.columns?.length}</strong></span>
          <span>Resampling: <strong style={{ color: C.green }}>Stratified (sex × income)</strong></span>
          <span>Label diversity: <strong style={{ color: C.green }}>✓ Maintained</strong></span>
        </div>
      )}

      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 16 }}>
        The corrected dataset was built by stratified oversampling across all four (sex × income) groups,
        ensuring equal representation without removing data or collapsing label diversity.
        Use it to retrain a fairer baseline model.
      </div>

      {err && (
        <div style={{ background: `${C.red}12`, border: `1px solid ${C.red}40`, padding: '10px 14px',
          fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.red, marginBottom: 12 }}>
          ⚠ {err}
        </div>
      )}

      <button onClick={handleDownload} disabled={downloading}
        style={{
          background: done ? C.green : downloading ? C.edge : 'transparent',
          color:      done ? '#000'  : downloading ? C.muted  : C.green,
          border: `2px solid ${done ? C.green : downloading ? C.edge : C.green}`,
          fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 13,
          letterSpacing: 1.5, padding: '12px 28px',
          cursor: downloading ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          transition: 'all 0.2s',
          clipPath: 'polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))',
        }}>
        {downloading ? '⏳ PREPARING…' : done ? '✅ DOWNLOADED!' : '⬇ DOWNLOAD FAIR DATASET'}
      </button>
    </div>
  )
}

// ─── Mitigation Status Badge ──────────────────────────────────────────────────
const MitigationStatusBadge = ({ status, improvement }) => {
  if (!status || status === 'ok') return null
  const configs = {
    degenerate:         { color: C.red,   icon: '🚫', label: 'DEGENERATE SOLUTION' },
    accuracy_degraded:  { color: C.amber, icon: '⚠️',  label: 'ACCURACY DEGRADED'  },
    no_valid_threshold: { color: C.amber, icon: '⚠️',  label: 'PARTIAL FIX ONLY'   },
  }
  const cfg = configs[status] || { color: C.muted, icon: 'ℹ️', label: status.toUpperCase() }
  return (
    <div style={{
      background: `${cfg.color}10`, border: `1px solid ${cfg.color}40`,
      padding: '10px 16px', display: 'flex', gap: 10, alignItems: 'center',
      fontFamily: 'var(--ff-mono)', fontSize: 11, color: cfg.color,
      marginBottom: 16,
    }}>
      <span>{cfg.icon}</span>
      <span>{cfg.label}</span>
      {improvement > 0 && (
        <span style={{ marginLeft: 'auto', color: C.green }}>↓ {improvement}% bias reduction</span>
      )}
    </div>
  )
}


// ─── Already Fair Result (shown instead of StepResults when status=ALREADY FAIR)
const AlreadyFairResult = ({ data }) => {
  const { before, dataset_info, explanation, risk } = data
  const isAlreadyProcessed = data.status === 'ALREADY PROCESSED'
  const pipelineState      = data.pipeline_meta?.pipeline_state
                          || data.dataset_info?.pipeline_state
                          || (isAlreadyProcessed ? 'MITIGATED' : 'STABLE')
  const cfg    = data.dataset_info?.col_config || {}
  const groupA = cfg.group_a_label || 'Group A'
  const groupB = cfg.group_b_label || 'Group B'

  const metrics = [
    { key: 'male_rate',  label: `${groupA} Sel. Rate`, fmt: v => `${(v*100).toFixed(1)}%` },
    { key: 'female_rate',label: `${groupB} Sel. Rate`, fmt: v => `${(v*100).toFixed(1)}%` },
    { key: 'spd',        label: 'SPD',                 fmt: v => v.toFixed(4)             },
    { key: 'di',         label: 'Disparate Impact',    fmt: v => v.toFixed(4)             },
    { key: 'accuracy',   label: 'Model Accuracy',      fmt: v => `${(v*100).toFixed(1)}%` },
  ]

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, letterSpacing: 4, color: C.muted, marginBottom: 8 }}>
          STEP 06
        </div>
        <h2 style={{ fontFamily: 'var(--ff-serif)', fontSize: 28, color: C.text, marginBottom: 6, lineHeight: 1.2 }}>
          {isAlreadyProcessed
            ? 'Dataset already processed. No further corrections applied.'
            : 'Dataset already meets fairness thresholds.'}
        </h2>
        <p style={{ color: C.muted, fontSize: 13, fontWeight: 300 }}>
          No mitigation was applied. No corrected dataset was generated.
        </p>
      </div>

      {/* Pipeline state badge */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        fontFamily: 'var(--ff-mono)', fontSize: 10, letterSpacing: 2,
        padding: '4px 12px', marginBottom: 20,
        background: `${C.green}15`, border: `1px solid ${C.green}40`, color: C.green,
      }}>
        <span>●</span> PIPELINE STATE: {pipelineState}
      </div>

      {/* Green confirmation banner */}
      <div style={{
        border: `2px solid ${C.green}`, background: `${C.green}07`,
        padding: '20px 24px', display: 'flex', alignItems: 'flex-start',
        gap: 16, marginBottom: 20, position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.03,
          backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 6px, white 6px, white 7px)' }} />
        <span style={{ fontSize: 28, flexShrink: 0 }}>✅</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.green, letterSpacing: 1, marginBottom: 6 }}>
            {isAlreadyProcessed
              ? 'Dataset already processed — further mitigation disabled.'
              : 'Dataset already meets fairness thresholds. No further correction applied.'}
          </div>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: `${C.green}90`, lineHeight: 1.7 }}>
            {data.mitigation_verdict?.verdict_detail || (
              `abs(SPD) = ${Math.abs(before.spd).toFixed(3)} ≤ 0.05 · DI = ${before.di.toFixed(3)} ≥ 0.80 · Accuracy = ${(before.accuracy*100).toFixed(1)}% ≥ 70%`
            )}
          </div>
        </div>
      </div>

      {/* §STABLE WARNING: shown when re-uploading a corrected dataset */}
      {isAlreadyProcessed && (
        <div style={{
          background: `${C.amber}10`, border: `1px solid ${C.amber}40`,
          padding: '14px 18px', marginBottom: 20,
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.amber, lineHeight: 1.7 }}>
            Further mitigation may degrade model. No additional fixes applied.
            <br />
            This dataset was previously exported by FairLens (state: {pipelineState}).
            Re-applying mitigation to an already-corrected dataset creates an infinite correction loop
            and typically worsens both accuracy and fairness.
          </div>
        </div>
      )}

      {/* Metrics card */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.green, letterSpacing: 2, marginBottom: 16 }}>
          FAIRNESS METRICS — ALREADY WITHIN THRESHOLDS
        </div>
        {metrics.map(m => (
          <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between',
            padding: '9px 0', borderBottom: `1px solid ${C.edge}` }}>
            <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>{m.label}</span>
            <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 12, fontWeight: 700, color: C.green }}>
              {m.fmt(before[m.key])}
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0',
          borderBottom: `1px solid ${C.edge}` }}>
          <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>Fairness Label</span>
          <Pill value={before.fairness_label ?? 'FAIR'} good="FAIR" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0' }}>
          <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>Deployment Status</span>
          <Pill value={before.deployment_status ?? 'CONDITIONALLY SAFE — Pending business validation'} good="CONDITIONALLY SAFE — Pending business validation" bad="DO NOT DEPLOY" />
        </div>
      </Card>

      {/* Threshold confirmation badges */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, marginBottom: 24, background: C.edge }}>
        {[
          { label: '|SPD|', val: Math.abs(before.spd).toFixed(3), threshold: '≤ 0.05', pass: Math.abs(before.spd) <= 0.05 },
          { label: 'Disparate Impact', val: before.di.toFixed(3), threshold: '≥ 0.80', pass: before.di >= 0.80 },
          { label: 'Accuracy', val: `${(before.accuracy*100).toFixed(1)}%`, threshold: '≥ 70%', pass: before.accuracy >= 0.70 },
        ].map(t => (
          <div key={t.label} style={{ background: C.surface, padding: '24px 18px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 8,
              textTransform: 'uppercase' }}>{t.label}</div>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 28,
              color: t.pass ? C.green : C.amber, marginBottom: 6 }}>{t.val}</div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: `${t.pass ? C.green : C.amber}80` }}>
              {t.threshold} {t.pass ? '✓' : '—'}
            </div>
          </div>
        ))}
      </div>

      {/* §F1: No download button, no improvement %, no bias reduction */}
      <div style={{
        background: `${C.green}06`, border: `1px solid ${C.green}25`,
        padding: '16px 20px', marginBottom: 24,
        fontFamily: 'var(--ff-mono)', fontSize: 11, color: `${C.green}90`, lineHeight: 1.7,
      }}>
        ℹ No corrected dataset was generated — the original data already satisfies
        all three fairness conditions. The model is safe to deploy as-is.
      </div>

      {/* AI explanation (Gemini) */}
      {explanation && <AIExplanationCard explanation={explanation} />}

      {/* Risk panel — will show LOW / CONDITIONALLY SAFE */}
      {data.risk && <RiskPanel risk={data.risk} before={before} />}
    </div>
  )
}

// ─── STEP 5: Mitigation ────────────────────────────────────────────────────────
const StepMitigation = ({ data, mitigating, mitigationPhase }) => {
  const phases = [
    { key: 0, label: 'STRATEGY 01 · PRE-PROCESSING', title: 'Data Resampling', desc: 'Stratified oversampling balances all four (sex × income) groups equally — ensuring the model sees female-positive examples it was previously missing. The model is retrained on this corrected set.' },
    { key: 1, label: 'STRATEGY 02 · POST-PROCESSING', title: 'Threshold Calibration', desc: 'The female decision threshold is independently calibrated to equalise selection rates between groups, without any retraining required.' },
  ]

  const threshold = data?.after?.female_threshold

  return (
    <div>
      <SectionTitle step={5} title="Applying fairness corrections…" sub="FairLens deploys two independent mitigation strategies simultaneously — attacking bias at the data level and the decision level." />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
        {phases.map(p => {
          const isRunning = mitigationPhase === p.key
          const isDone    = mitigationPhase > p.key
          const color     = isDone ? C.green : isRunning ? C.amber : C.muted
          return (
            <Card key={p.key} glow={isRunning ? C.amber : isDone ? C.green : null}
              style={{ borderColor: isDone ? `${C.green}50` : isRunning ? `${C.amber}50` : C.edge, transition: 'all 0.4s' }}>
              {/* Top accent bar */}
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                background: color, transform: isDone ? 'scaleX(1)' : isRunning ? 'scaleX(1)' : 'scaleX(0)',
                transformOrigin: 'left', transition: 'transform 1.5s ease', opacity: isDone || isRunning ? 1 : 0,
              }} />
              <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color, letterSpacing: 2, marginBottom: 12 }}>{p.label}</div>
              <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 18, marginBottom: 10 }}>{p.title}</div>
              <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>{p.desc}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--ff-mono)', fontSize: 10, color }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', background: color,
                  animation: isRunning ? 'blink 0.8s ease-in-out infinite' : 'none',
                }} />
                {isDone ? 'COMPLETE ✓' : isRunning ? 'RUNNING…' : 'PENDING'}
              </div>
            </Card>
          )
        })}
      </div>

      {/* Threshold display */}
      {mitigationPhase >= 2 && threshold !== undefined && (
        <Card style={{ marginBottom: 0 }}>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.green, letterSpacing: 2, marginBottom: 20 }}>THRESHOLD CALIBRATION APPLIED</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            {[
              { label: 'MALE THRESHOLD', val: '0.50', pct: 50, color: C.blue },
              { label: 'FEMALE THRESHOLD (calibrated)', val: threshold.toFixed(2), pct: threshold * 100, color: C.purple },
            ].map(t => (
              <div key={t.label}>
                <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>{t.label}</div>
                <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 28, color: t.color, marginBottom: 10 }}>{t.val}</div>
                <GaugeBar value={t.pct} color={t.color} animated />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, color: C.muted, fontSize: 12, lineHeight: 1.7 }}>
            Lowering the female threshold from 0.50 → {threshold.toFixed(2)} compensates for the model's learned bias —
            women with equivalent merit scores now clear the cutoff at the same rate as men.
          </div>
        </Card>
      )}

      {/* Warnings */}
      {mitigationPhase >= 2 && data?.warnings?.length > 0 && (
        <MitigationWarnings warnings={data.warnings} valid={data.mitigation_status === 'ok'} />
      )}

      <style>{`@keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.3 } }`}</style>
    </div>
  )
}

// ─── Verdict Banner ────────────────────────────────────────────────────────────
const VerdictBanner = ({ verdict, before, after }) => {
  if (!verdict) return null
  const { outcome, verdict_label, verdict_detail } = verdict

  const configs = {
    IMPROVED:    { color: C.green, icon: '🎯', border: C.green },
    PARTIAL:     { color: C.amber, icon: '⚠️',  border: C.amber },
    FAILED:      { color: C.red,   icon: '🚫', border: C.red   },
    DEGENERATE:  { color: C.red,   icon: '🚫', border: C.red   },
    DEGRADATION: { color: C.red,   icon: '📉', border: C.red   },  // metrics worsened
  }
  const cfg = configs[outcome] || configs.FAILED

  return (
    <div style={{
      border: `2px solid ${cfg.border}`, background: `${cfg.border}08`,
      padding: '20px 24px', display: 'flex', alignItems: 'flex-start',
      gap: 16, marginBottom: 24, position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.025,
        backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 6px, white 6px, white 7px)',
      }} />
      <span style={{ fontSize: 28, flexShrink: 0 }}>{cfg.icon}</span>
      <div>
        <div style={{ fontWeight: 700, fontSize: 15, color: cfg.color, letterSpacing: 1, marginBottom: 6 }}>
          {typeof verdict_label === 'string'
            ? verdict_label.replace(/BIAS REDUCED BY [\d.]+\s*%[^).]*/gi,
                'Bias reduced within defined fairness thresholds')
            : verdict_label}
        </div>
        <div style={{ color: `${cfg.color}90`, fontSize: 13, lineHeight: 1.6 }}>
          {verdict_detail}
        </div>
        {outcome === 'IMPROVED' && before && after && (
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.green, marginTop: 8 }}>
            SPD: {before.spd.toFixed(4)} → {after.spd.toFixed(4)} &nbsp;|&nbsp;
            DI: {before.di.toFixed(4)} → {after.di.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Audit Note — Enterprise pre-deployment review ───────────────────────────
const AuditNote = ({ auditNote, impactAssessment, outcome }) => {
  if (!auditNote) return null
  const isDeg = outcome === 'DEGRADED'
  const isOk  = outcome === 'IMPROVED'
  const borderColor = isDeg ? C.red : C.amber
  const icon = isDeg ? '⛔' : '📋'
  const shift = impactAssessment?.selection_rate_shift
  const needsValidation = impactAssessment?.requires_business_validation
  return (
    <div style={{ border: `1px solid ${borderColor}40`, background: `${borderColor}05`, marginBottom: 20 }}>
      <div style={{ padding: '12px 20px', borderBottom: `1px solid ${borderColor}25`,
        display: 'flex', alignItems: 'center', gap: 10, background: `${borderColor}08` }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 13,
          color: borderColor, letterSpacing: 0.5 }}>
          Audit Notice — Pre-Deployment Review Required
        </span>
      </div>
      <div style={{ padding: '16px 20px', borderBottom: shift ? `1px solid ${borderColor}20` : 'none' }}>
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.8 }}>{auditNote}</div>
      </div>
      {shift && needsValidation && (
        <div style={{ padding: '14px 20px' }}>
          {impactAssessment.overall_shift_severity && (() => {
            const sev = impactAssessment.overall_shift_severity
            const sc  = sev === 'HIGH' ? C.red : sev === 'MODERATE' ? C.amber : C.green
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, fontWeight: 700,
                  padding: '6px 14px', letterSpacing: 1.5,
                  background: `${sc}18`, border: `1px solid ${sc}50`, color: sc }}>
                  SELECTION SHIFT SEVERITY: {sev}
                </div>
                <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted }}>
                  {sev === 'HIGH' ? '> 20pp — formal compliance review required'
                   : sev === 'MODERATE' ? '10–20pp — business validation required'
                   : '≤ 10pp — standard monitoring'}
                </div>
              </div>
            )
          })()}
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted,
            letterSpacing: 2, marginBottom: 12, textTransform: 'uppercase' }}>
            Selection Rate Shift — Validate Against Operational Baselines
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, background: C.edge }}>
            {[
              { label: 'MALE CANDIDATES',   before: shift.male_before,   after: shift.male_after,   delta: shift.male_delta,   color: C.blue,   sev: shift.male_severity   },
              { label: 'FEMALE CANDIDATES', before: shift.female_before, after: shift.female_after, delta: shift.female_delta, color: C.purple, sev: shift.female_severity },
            ].map(g => (
              <div key={g.label} style={{ background: C.surface, padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, letterSpacing: 2 }}>{g.label}</div>
                  {g.sev && (() => {
                    const sc = g.sev === 'HIGH' ? C.red : g.sev === 'MODERATE' ? C.amber : C.green
                    return <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 8, letterSpacing: 1,
                      padding: '2px 6px', background: `${sc}18`, border: `1px solid ${sc}40`, color: sc }}>{g.sev}</div>
                  })()}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, marginBottom: 3 }}>BEFORE</div>
                    <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 18, color: C.muted }}>{(g.before * 100).toFixed(1)}%</div>
                  </div>
                  <div style={{ color: C.muted, fontSize: 14 }}>→</div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, marginBottom: 3 }}>AFTER</div>
                    <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 18, color: g.color }}>{(g.after * 100).toFixed(1)}%</div>
                  </div>
                  <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, marginLeft: 'auto',
                    color: g.delta > 0 ? C.green : g.delta < 0 ? C.amber : C.muted,
                    background: `${g.delta > 0 ? C.green : g.delta < 0 ? C.amber : C.muted}15`,
                    padding: '4px 8px' }}>
                    {g.delta > 0 ? '+' : ''}{(g.delta * 100).toFixed(1)}pp
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, marginTop: 10, lineHeight: 1.6 }}>
            {impactAssessment.review_note}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── STEP 6: Results ─────────────────────────────────────────────────────────
const StepResults = ({ data }) => {
  const { before, after, after_preprocessing: pre, improvement, risk, explanation } = data
  const cfg    = data.dataset_info?.col_config || {}
  const groupA = cfg.group_a_label || 'Group A'
  const groupB = cfg.group_b_label || 'Group B'

  const verdict  = data.mitigation_verdict || null
  const outcome  = verdict?.outcome ?? 'FAILED'
  const didPass  = outcome === 'IMPROVED'
  const didFail  = outcome === 'FAILED' || outcome === 'DEGENERATE' || outcome === 'DEGRADATION'
  const isDeg    = outcome === 'DEGRADATION'

  const afterColor       = didPass ? C.green : didFail ? C.red : C.amber
  const afterHeaderColor = didPass ? C.green : didFail ? C.red : C.amber
  const afterHeaderIcon  = didPass ? '✓' : '✗'
  const afterHeaderText  = didPass
    ? 'AFTER — BIAS REDUCED'
    : isDeg
    ? 'AFTER — DEGRADATION (METRICS WORSENED)'
    : didFail
    ? 'AFTER — MITIGATION FAILED'
    : 'AFTER — PARTIAL IMPROVEMENT'

  const afterFairnessLabel = after?.fairness_label ?? (after?.bias_flag ? 'BIASED' : 'FAIR')

  // Read deployment_status directly from the backend (hard rule applied there)
  const afterDeployStatus = after?.deployment_status ?? (after?.bias_flag ? 'DO NOT DEPLOY' : 'CONDITIONALLY SAFE — Pending business validation')

  const sectionSub = didPass
    ? 'Bias reduced within defined fairness thresholds. Review selection rate shifts and validate business impact before deployment.'
    : isDeg
    ? 'Mitigation degraded fairness metrics. Do not deploy. Root-cause investigation required.'
    : didFail
    ? 'Fairness thresholds not met after mitigation. Results shown below. Further remediation required.'
    : 'Fairness thresholds not fully met. Partial improvement recorded. Do not deploy without further review.'

  const barData = [
    { stage: 'Baseline', male: before.male_rate * 100, female: before.female_rate * 100 },
    { stage: 'Pre-proc', male: pre.male_rate * 100,    female: pre.female_rate * 100    },
    { stage: 'Post-proc', male: after.male_rate * 100, female: after.female_rate * 100  },
  ]

  const lineData = [
    { stage: 'Baseline',  spd: before.spd, di: before.di },
    { stage: 'Pre-proc',  spd: pre.spd,    di: pre.di    },
    { stage: 'Post-proc', spd: after.spd,  di: after.di  },
  ]

  const metrics = [
    { key: 'male_rate',  label: `${groupA} Sel. Rate`, fmt: v => `${(v*100).toFixed(1)}%` },
    { key: 'female_rate',label: `${groupB} Sel. Rate`, fmt: v => `${(v*100).toFixed(1)}%` },
    { key: 'spd',        label: 'SPD',                 fmt: v => v.toFixed(4)             },
    { key: 'di',         label: 'Disparate Impact',    fmt: v => v.toFixed(4)             },
    { key: 'accuracy',   label: 'Model Accuracy',      fmt: v => `${(v*100).toFixed(1)}%` },
  ]

  // Metric-level color: green if improved vs baseline, red if same/worse/degraded
  const metricColor = (key) => {
    if (didFail || isDeg) return C.red
    if (!verdict) return C.muted
    if (key === 'spd')         return verdict.spd_improved ? C.green : C.red
    if (key === 'di')          return verdict.di_improved  ? C.green : C.red
    if (key === 'female_rate') return verdict.spd_improved ? C.green : C.red
    return afterColor
  }

  // Improvement display — use formula: (|SPD_before| - |SPD_after|) / |SPD_before|
  // improvement comes from backend (already computed with correct formula and zeroed if failed)
  const showImprovement = improvement > 0 && didPass
  const improvementLabel = showImprovement
    ? `${improvement}% SPD reduction  (formula: (|${Math.abs(before.spd).toFixed(4)}| − |${Math.abs(after.spd).toFixed(4)}|) / |${Math.abs(before.spd).toFixed(4)}|)`
    : null

  return (
    <div>
      <SectionTitle
        step={6}
        title={
          didPass  ? 'Fairness thresholds met. Pre-deployment review required.' :
          isDeg    ? 'Mitigation degraded model. Do not deploy.' :
          didFail  ? 'Fairness thresholds not met.' :
                     'Partial improvement. Further remediation required.'
        }
        sub={sectionSub}
      />

      {/* Verdict banner — driven entirely by backend verdict */}
      <VerdictBanner verdict={verdict} before={before} after={after} />

      {/* Improvement formula display — only shown when genuinely improved */}
      {showImprovement && (
        <div style={{ background: `${C.green}07`, border: `1px solid ${C.green}30`,
          padding: '14px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ color: C.green, fontSize: 18 }}>✓</span>
            <span style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 14, color: C.green, letterSpacing: 0.3 }}>
              Bias reduced within defined fairness thresholds
            </span>
          </div>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted, lineHeight: 1.8, paddingLeft: 28 }}>
            SPD: {Math.abs(before.spd).toFixed(4)} → {Math.abs(after.spd).toFixed(4)} (target: ≤ 0.05)
            &nbsp;&nbsp;|&nbsp;&nbsp;
            DI: {before.di.toFixed(4)} → {after.di.toFixed(4)} (target: ≥ 0.80)
          </div>
        </div>
      )}

      {/* Audit note — enterprise pre-deployment review */}
      <AuditNote auditNote={data.audit_note} impactAssessment={data.impact_assessment} outcome={outcome} />

      {/* Before / After table */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr', gap: 0, marginBottom: 24, alignItems: 'stretch' }}>
        {/* Before */}
        <div style={{ background: C.surface, border: `1px solid ${C.red}40`, padding: '24px 20px' }}>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, letterSpacing: 2, color: C.red, marginBottom: 16 }}>
            ⚠ BEFORE — BIASED MODEL
          </div>
          {metrics.map(m => (
            <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: `1px solid ${C.edge}` }}>
              <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>{m.label}</span>
              <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 12, fontWeight: 700,
                color: m.key === 'female_rate' || m.key === 'spd' || m.key === 'di' ? C.red : C.blue }}>
                {m.fmt(before[m.key])}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: `1px solid ${C.edge}` }}>
            <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>Fairness Label</span>
            <Pill value="BIASED" bad="BIASED" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0' }}>
            <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>Deployment</span>
            <Pill value={before?.deployment_status ?? 'CONDITIONALLY SAFE — Pending business validation'} good="CONDITIONALLY SAFE — Pending business validation" bad="DO NOT DEPLOY" />
          </div>
        </div>

        {/* Arrow */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: C.lift, border: `1px solid ${C.edge}`, borderLeft: 'none', borderRight: 'none' }}>
          <span style={{ color: C.amber, fontSize: 16 }}>→</span>
        </div>

        {/* After — label and colors are truthful */}
        <div style={{ background: C.surface, border: `1px solid ${afterHeaderColor}40`, padding: '24px 20px' }}>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, letterSpacing: 2, color: afterHeaderColor, marginBottom: 16 }}>
            {afterHeaderIcon} {afterHeaderText}
          </div>
          {metrics.map(m => (
            <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: `1px solid ${C.edge}` }}>
              <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>{m.label}</span>
              <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 12, fontWeight: 700, color: metricColor(m.key) }}>
                {m.fmt(after[m.key])}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: `1px solid ${C.edge}` }}>
            <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>Fairness Label</span>
            {/* Only show FAIR if backend actually confirms it */}
            <Pill value={afterFairnessLabel} good="FAIR" bad="BIASED" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0' }}>
            <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted }}>Deployment</span>
            {/* deployment_status comes from hard backend rule — never from Gemini */}
            <Pill value={afterDeployStatus} good="CONDITIONALLY SAFE — Pending business validation" bad="DO NOT DEPLOY" />
          </div>
        </div>
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <Card>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 1, marginBottom: 14 }}>
            SELECTION RATES ACROSS STAGES
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={barData} barCategoryGap="30%">
              <XAxis dataKey="stage" tick={{ fontFamily: 'var(--ff-mono)', fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${v}%`} tick={{ fontFamily: 'var(--ff-mono)', fontSize: 9, fill: C.muted }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="male"   name={groupA} fill={C.blue}   radius={[2,2,0,0]} />
              <Bar dataKey="female" name={groupB} fill={C.purple} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, letterSpacing: 1, marginBottom: 14 }}>
            SPD TRAJECTORY (target: |SPD| ≤ 0.05)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={lineData}>
              <XAxis dataKey="stage" tick={{ fontFamily: 'var(--ff-mono)', fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontFamily: 'var(--ff-mono)', fontSize: 9, fill: C.muted }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0.05}  stroke={`${C.green}50`} strokeDasharray="4 3" label={{ value: '+0.05', fill: C.green, fontSize: 9 }} />
              <ReferenceLine y={-0.05} stroke={`${C.green}50`} strokeDasharray="4 3" label={{ value: '-0.05', fill: C.green, fontSize: 9 }} />
              <Line type="monotone" dataKey="spd" name="SPD" stroke={didPass ? C.green : didFail ? C.red : C.amber}
                strokeWidth={2} dot={{ fill: didPass ? C.green : didFail ? C.red : C.amber, r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Warnings */}
      {data.warnings?.length > 0 && (
        <MitigationWarnings warnings={data.warnings} valid={outcome === 'IMPROVED'} />
      )}

      {/* Mitigation status badge */}
      <MitigationStatusBadge status={data.mitigation_status} improvement={improvement} />

      {/* Updated risk assessment — recommendation comes from hard backend rule */}
      {data.risk && <RiskPanel risk={{ ...data.risk, _isPost: true }} before={data.after} />}

      {/* §F1: Download fair dataset — hidden when:
           - fair_dataset_available is false (backend did not generate it), OR
           - is_mitigated is false (no mitigation ran), OR
           - is_fair_after is true (model became fair — no corrected CSV needed)
           Belt-and-suspenders: backend already sets fair_dataset_available=false
           in those cases, but explicit checks make intent unambiguous. */}
      {data.fair_dataset_available && data.is_mitigated !== false && !data.is_fair_after && (
        <DownloadButton
          available={data.fair_dataset_available}
          datasetInfo={data.fair_dataset_info}
        />
      )}
    </div>
  )
}

// ─── AI Explanation Card ─────────────────────────────────────────────────────
const AIExplanationCard = ({ explanation }) => (
  <div style={{
    background: C.surface, borderTop: `2px solid ${C.purple}`,
    border: `1px solid ${C.edge}`, padding: 24, marginBottom: 20,
    boxShadow: `0 0 40px ${C.purple}10`,
    position: 'relative', overflow: 'hidden',
  }}>
    {/* Shimmer line */}
    <div style={{
      position: 'absolute', top: -1, left: 0, right: 0, height: 2,
      background: `linear-gradient(90deg, ${C.purple}, ${C.blue}, ${C.purple})`,
      backgroundSize: '200% 100%', animation: 'shimmer 3s ease-in-out infinite',
    }} />

    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <span style={{ fontSize: 22, animation: 'breathe 3s ease-in-out infinite' }}>🧠</span>
      <div>
        <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 14, color: C.purple, letterSpacing: 1 }}>
          Why This Model Is Biased (AI Explanation)
        </div>
        <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, letterSpacing: 2, marginTop: 2 }}>
          GENERATED BY GEMINI · BASED ON REAL METRICS
        </div>
      </div>
    </div>

    <div style={{
      borderLeft: `3px solid ${C.purple}60`,
      paddingLeft: 16, color: C.text, fontSize: 14, lineHeight: 1.8,
    }}>
      {explanation}
    </div>
    <style>{`
      @keyframes shimmer { 0%,100% { background-position:0% } 50% { background-position:100% } }
      @keyframes breathe { 0%,100% { transform:scale(1) } 50% { transform:scale(1.1) } }
    `}</style>
  </div>
)

// ─── Risk Panel ───────────────────────────────────────────────────────────────
const RiskPanel = ({ risk, before }) => {
  const { legal_risk, ethical_risk, recommendation, risk_level, source, _isPost } = risk

  // Derive display recommendation: always use the hard rule output.
  // If risk_level is present use it; otherwise derive from recommendation string.
  const isSafe = recommendation === 'CONDITIONALLY SAFE — Pending business validation' || recommendation === 'SAFE TO DEPLOY' || risk_level === 'LOW'
  const displayRec   = isSafe ? 'CONDITIONALLY SAFE — Pending business validation' : 'DO NOT DEPLOY'
  const displayColor = isSafe ? C.green : C.red
  const displayIcon  = isSafe ? '✅' : '🚫'

  const scoreMap     = { HIGH: 78, MEDIUM: 42, LOW: 12 }
  const legalScore   = scoreMap[legal_risk]   ?? 50
  const ethicalScore = scoreMap[ethical_risk] ?? 50
  const rawComposite = Math.round(0.55 * legalScore + 0.45 * ethicalScore)
  // Consistency guard: composite must not imply higher risk than deployment risk_level
  const riskLevelCap = { LOW: 20, MEDIUM: 69, HIGH: 100 }[risk_level] ?? 100
  const composite    = Math.min(rawComposite, riskLevelCap)

  const gauges = [
    { label: '⚖️ Legal Risk (EEOC / Title VII)',         level: legal_risk,   score: legalScore   },
    { label: '🧭 Ethical Risk (Algorithmic Fairness)',   level: ethical_risk, score: ethicalScore },
  ]

  return (
    <div style={{
      border: `1px solid ${displayColor}40`,
      boxShadow: `0 0 24px ${displayColor}08`,
      marginBottom: 20,
    }}>
      {/* Header */}
      <div style={{
        background: C.surface, padding: '18px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${C.edge}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 22 }}>⚖️</span>
          <div>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 15, letterSpacing: 0.5 }}>
              {_isPost ? 'Updated Risk After Mitigation' : 'Deployment Risk Assessment'}
            </div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, letterSpacing: 2, marginTop: 2 }}>
              EEOC STANDARDS · TITLE VII · AI ETHICS GUIDELINES
              {source === 'gemini' && ' · EXPLAINED BY GEMINI · DECIDED BY FAIRLENS RULES'}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted, marginBottom: 2 }}>RISK SCORE</div>
          <div style={{
            fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 28,
            color: riskColor(composite >= 70 ? 'HIGH' : composite >= 35 ? 'MEDIUM' : 'LOW'),
          }}>{composite}</div>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 9, color: C.muted }}>/100</div>
        </div>
      </div>

      {/* Gauges */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: C.edge, gap: 1 }}>
        {gauges.map(g => (
          <div key={g.label} style={{ background: C.surface, padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted }}>{g.label}</div>
              <Tag label={g.level} color={riskColor(g.level)} />
            </div>
            <GaugeBar value={g.score} color={riskColor(g.level)} animated />
          </div>
        ))}
      </div>

      {/* Recommendation — binary: CONDITIONALLY SAFE or DO NOT DEPLOY */}
      <div style={{
        background: `${displayColor}07`,
        padding: '20px 24px', display: 'flex', gap: 16, alignItems: 'flex-start',
        borderTop: `1px solid ${C.edge}`,
      }}>
        <span style={{ fontSize: 24, flexShrink: 0 }}>{displayIcon}</span>
        <div>
          <div style={{
            fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 18,
            color: displayColor, letterSpacing: 1, marginBottom: 6,
          }}>{displayRec}</div>
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.7 }}>
            {isSafe
              ? 'Fairness thresholds met. Conditionally safe pending formal business impact validation. Consult legal and compliance teams. Track SPD and DI in production.'
              : 'One or more conditions failed: |SPD| > 0.05 OR DI < 0.80 OR accuracy < 70%. This model must not enter production. Apply FairLens mitigation and re-evaluate before any deployment.'}
          </div>
          <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: `${displayColor}80`, marginTop: 8 }}>
            RULE: SAFE only if abs(SPD) ≤ 0.05 AND DI ≥ 0.80 AND accuracy ≥ 70%
          </div>
          {risk._risk_cap_applied && (
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted,
              marginTop: 6, padding: '4px 0', borderTop: `1px solid ${C.edge}` }}>
              {'ℹ Risk levels adjusted for deployment consistency. '}
              Raw: Legal={risk._raw_legal_risk} · Ethical={risk._raw_ethical_risk}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── HERO ─────────────────────────────────────────────────────────────────────
const Hero = ({ onStart }) => (
  <div style={{
    minHeight: '100vh', display: 'flex', flexDirection: 'column',
    justifyContent: 'center', alignItems: 'center', textAlign: 'center',
    padding: '100px 24px 60px', position: 'relative',
    background: `radial-gradient(ellipse 70% 50% at 50% 60%, ${C.red}08 0%, transparent 70%)`,
  }}>
    {/* Background grid */}
    <div style={{
      position: 'absolute', inset: 0, zIndex: 0,
      backgroundImage: `linear-gradient(${C.edge}50 1px, transparent 1px), linear-gradient(90deg, ${C.edge}50 1px, transparent 1px)`,
      backgroundSize: '60px 60px',
      maskImage: 'radial-gradient(ellipse 80% 80% at 50% 50%, black 20%, transparent 100%)',
    }} />

    <div style={{ position: 'relative', zIndex: 1, maxWidth: 720 }}>
      <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, letterSpacing: 4, color: C.amber, marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <span style={{ width: 40, height: 1, background: `${C.amber}60`, display: 'inline-block' }} />
        AI FAIRNESS INVESTIGATION SYSTEM
        <span style={{ width: 40, height: 1, background: `${C.amber}60`, display: 'inline-block' }} />
      </div>

      <h1 style={{ fontFamily: 'var(--ff-serif)', fontSize: 'clamp(2.4rem, 6vw, 4.8rem)', lineHeight: 1.05, marginBottom: 24, letterSpacing: -0.5 }}>
        <span style={{ display: 'block', color: C.text }}>Expose Hidden</span>
        <span style={{ display: 'block', color: C.red, textShadow: `0 0 60px ${C.red}50`, fontStyle: 'italic' }}>AI Discrimination</span>
        <span style={{ display: 'block', color: C.text }}>Before It Impacts Real Lives</span>
      </h1>

      <p style={{ color: C.muted, fontSize: 15, maxWidth: 540, margin: '0 auto 40px', lineHeight: 1.8, fontWeight: 300 }}>
        Upload any hiring dataset. FairLens runs real ML fairness analysis, generates
        a <strong style={{ color: C.text }}>Gemini AI explanation</strong>, calculates legal &amp; ethical risk,
        then applies two mitigation strategies — with measurable proof.
      </p>

      <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 56 }}>
        <button onClick={onStart} style={{
          background: C.red, color: 'white', border: 'none', cursor: 'pointer',
          fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 14, letterSpacing: 2,
          padding: '15px 40px',
          clipPath: 'polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))',
          transition: 'all 0.2s',
        }}>⚡ RUN LIVE BIAS DEMO</button>
        <a href="http://localhost:8000/docs" target="_blank" rel="noreferrer" style={{
          background: 'transparent', color: C.muted, border: `1px solid ${C.edge}`,
          fontFamily: 'var(--ff-mono)', fontSize: 12, letterSpacing: 1,
          padding: '15px 24px', textDecoration: 'none', transition: 'all 0.2s',
        }}>API DOCS ↗</a>
      </div>

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', background: C.surface, border: `1px solid ${C.edge}` }}>
        {[
          { val: '1 in 3', label: 'Women unfairly rejected by biased AI systems', color: C.red },
          { val: '67%', label: 'Companies unaware of model discrimination', color: C.amber },
          { val: '~98%', label: 'Bias reduction achievable with FairLens', color: C.green },
        ].map(s => (
          <div key={s.label} style={{ padding: '20px 16px', borderRight: `1px solid ${C.edge}` }}>
            <div style={{ fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 28, color: s.color, lineHeight: 1, marginBottom: 6 }}>{s.val}</div>
            <div style={{ fontFamily: 'var(--ff-mono)', fontSize: 10, color: C.muted, lineHeight: 1.5 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  </div>
)

// ─── NAV ─────────────────────────────────────────────────────────────────────
const Nav = ({ onReset }) => (
  <nav style={{
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
    background: 'rgba(7,7,15,0.92)', backdropFilter: 'blur(12px)',
    borderBottom: `1px solid ${C.edge}`, padding: '14px 28px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  }}>
    <div style={{ fontFamily: 'var(--ff-serif)', fontSize: 20, color: C.text, cursor: 'pointer' }} onClick={onReset}>
      Fair<span style={{ color: C.amber }}>Lens</span>
    </div>
    <div style={{
      fontFamily: 'var(--ff-mono)', fontSize: 10, letterSpacing: 2,
      border: `1px solid ${C.amber}`, color: C.amber, padding: '3px 10px',
    }}>LIVE INVESTIGATION</div>
    <a href="http://localhost:8000/docs" target="_blank" rel="noreferrer"
      style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: C.muted, textDecoration: 'none',
        border: `1px solid ${C.edge}`, padding: '5px 12px' }}>
      API ↗
    </a>
  </nav>
)

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]        = useState('hero')
  const [step, setStep]        = useState(1)
  const [file, setFile]        = useState(null)
  const [result, setResult]    = useState(null)
  const [loading, setLoading]  = useState(false)
  const [error, setError]      = useState(null)
  const [trainProg, setTrainProg]   = useState(0)
  const [mitigating, setMitigating] = useState(false)
  const [mitigPhase, setMitigPhase] = useState(-1)

  // §C3: Column detection state
  const [detection,     setDetection]     = useState(null)   // /detect-columns result
  const [detectLoading, setDetectLoading] = useState(false)
  const [colConfig, setColConfig] = useState({ protected_col: '', target_col: '' })

  const scrollRef = useRef()

  const goStep = (n) => {
    setStep(n)
    setTimeout(() => scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  // §C3: Call /detect-columns whenever a new file is selected
  const handleFile = async (f) => {
    setFile(f)
    setError(null)
    setDetection(null)
    setColConfig({ protected_col: '', target_col: '' })

    if (!f) return
    setDetectLoading(true)
    try {
      const fd = new FormData()
      fd.append('file', f)
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/detect-columns`, { method: 'POST', body: fd })
      const data = await res.json()
      setDetection(data)
      // Auto-populate dropdowns from detected candidates
      setColConfig({
        protected_col: data.auto_protected || '',
        target_col:    data.auto_target    || '',
      })
    } catch (e) {
      // Detection failure is non-fatal — user can still select manually
      setDetection({ protected_candidates: [], target_candidates: [], all_columns: [], suitable: false })
    } finally {
      setDetectLoading(false)
    }
  }

  const runAnalysis = async () => {
    setError(null)
    setLoading(true)
    setResult(null)
    setTrainProg(0)
    setMitigPhase(-1)
    goStep(2)

    let p = 0
    const ticker = setInterval(() => {
      p = Math.min(p + Math.random() * 3 + 0.5, 95)
      setTrainProg(p)
    }, 120)

    try {
      const fd = new FormData()
      if (file) {
        fd.append('file', file)
        // §C4: send selected columns so backend uses exactly what the user chose
        if (colConfig.protected_col) fd.append('protected_col', colConfig.protected_col)
        if (colConfig.target_col)    fd.append('target_col',    colConfig.target_col)
      } else {
        const blob = new Blob([DEMO_CSV], { type: 'text/csv' })
        fd.append('file', blob, 'fairlens_demo.csv')
        // Demo CSV has sex + income — no need to send column params
      }

      const res  = await fetch(`${import.meta.env.VITE_API_URL || ''}/analyze`, { method: 'POST', body: fd })
      const data = await res.json()

      if (!res.ok) throw new Error(data.detail || `Server error ${res.status}`)

      clearInterval(ticker)
      setTrainProg(100)
      setResult(data)
      setTimeout(() => goStep(3), 600)

    } catch (err) {
      clearInterval(ticker)
      setError(err.message)
      setLoading(false)
      goStep(1)
      return
    }
    setLoading(false)
  }

  const handleMitigate = async () => {
    // §F1 HARD STOP: if backend says already fair, skip mitigation entirely.
    // Do NOT play the animation, do NOT generate a dataset.
    // Jump directly to step 6 to show AlreadyFairResult.
    if (result?.status === 'ALREADY FAIR' || result?.status === 'ALREADY PROCESSED' || result?.is_mitigated === false) {
      goStep(6)
      return
    }

    // Normal path: run mitigation animation then show results
    goStep(5)
    setMitigating(true)
    setMitigPhase(0)
    await new Promise(r => setTimeout(r, 1800))
    setMitigPhase(1)
    await new Promise(r => setTimeout(r, 2000))
    setMitigPhase(2)
    await new Promise(r => setTimeout(r, 800))
    setMitigating(false)
    goStep(6)
  }

  const reset = () => {
    setView('hero'); setStep(1); setFile(null); setResult(null)
    setError(null); setTrainProg(0); setMitigPhase(-1)
    setDetection(null); setColConfig({ protected_col: '', target_col: '' })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (view === 'hero') {
    return (
      <>
        <Nav onReset={reset} />
        <Hero onStart={() => setView('demo')} />
      </>
    )
  }

  return (
    <>
      <Nav onReset={reset} />
      <div style={{ paddingTop: 57 }}>
        <StepNav current={step} onStep={goStep} canNavigate={!!result} />
        {/* Progress line */}
        <div style={{ height: 2, background: C.edge }}>
          <div style={{
            height: '100%', width: `${(step / 6) * 100}%`,
            background: `linear-gradient(90deg, ${C.green}, ${C.amber})`,
            transition: 'width 0.6s ease', boxShadow: `0 0 8px ${C.amber}`,
          }} />
        </div>

        <div ref={scrollRef} style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>

          {step === 1 && (
            <StepUpload
              file={file}
              onFile={handleFile}
              onRun={runAnalysis}
              loading={loading}
              error={error}
              detection={detection}
              colConfig={colConfig}
              onColConfig={setColConfig}
            />
          )}

          {step === 2 && <StepTraining progress={trainProg} />}

          {step === 3 && result && (
            <div>
              <StepBiasDetection data={result} />
              <div style={{ display: 'flex', gap: 14, marginTop: 40, paddingTop: 24, borderTop: `1px solid ${C.edge}` }}>
                <button onClick={() => goStep(1)} style={ghostBtn}>← Back</button>
                {/* §F1: already fair → skip to results directly, no impact sim, no mitigation */}
                {result.status === 'ALREADY FAIR' || result.is_mitigated === false ? (
                  <button onClick={handleMitigate}
                    style={{ ...primaryBtn, background: C.green, color: '#000' }}>
                    ✓ View Fair Results →
                  </button>
                ) : (
                  <button onClick={() => goStep(4)} style={dangerBtn}>See Real-World Impact →</button>
                )}
              </div>
            </div>
          )}

          {step === 4 && result && (
            <div>
              <StepImpact data={result} />
              <div style={{ display: 'flex', gap: 14, marginTop: 40, paddingTop: 24, borderTop: `1px solid ${C.edge}` }}>
                <button onClick={() => goStep(3)} style={ghostBtn}>← Back</button>
                {/* §F1: no "Fix the Model" when already fair */}
                {result.status === 'ALREADY FAIR' || result.is_mitigated === false ? (
                  <button onClick={handleMitigate}
                    style={{ ...primaryBtn, background: C.green, color: '#000' }}>
                    ✓ Already Fair — View Results →
                  </button>
                ) : (
                  <button onClick={handleMitigate} style={dangerBtn}>Fix the Model →</button>
                )}
              </div>
            </div>
          )}

          {step === 5 && (
            <div>
              <StepMitigation data={result} mitigating={mitigating} mitigationPhase={mitigPhase} />
              {/* Warnings from mitigation */}
              {result?.warnings?.length > 0 && (
                <MitigationWarnings warnings={result.warnings} valid={result.mitigation_status === 'ok'} />
              )}
              <div style={{ display: 'flex', gap: 14, marginTop: 40, paddingTop: 24, borderTop: `1px solid ${C.edge}` }}>
                <button onClick={() => goStep(4)} style={ghostBtn}>← Back</button>
              </div>
            </div>
          )}

          {step === 6 && result && (
            <div>
              {/* §F1: Route to the correct result component based on whether
                   mitigation was applied. ALREADY FAIR → no improvement %, no download.
                   Mitigated → full before/after comparison with optional download. */}
              {(result.status === 'ALREADY FAIR' || result.status === 'ALREADY PROCESSED' || result.is_mitigated === false)
                ? <AlreadyFairResult data={result} />
                : <StepResults data={result} />
              }
              <div style={{ display: 'flex', gap: 14, marginTop: 40, paddingTop: 24, borderTop: `1px solid ${C.edge}`, flexWrap: 'wrap' }}>
                <button onClick={reset} style={{ ...primaryBtn, background: C.green, color: '#000' }}>🔄 Run New Analysis</button>
                <button onClick={() => goStep(1)} style={ghostBtn}>Upload Different Dataset</button>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  )
}

// ─── Button styles ────────────────────────────────────────────────────────────
const primaryBtn = {
  padding: '13px 28px', border: 'none', cursor: 'pointer',
  fontFamily: 'var(--ff-sans)', fontWeight: 700, fontSize: 13, letterSpacing: 2,
  clipPath: 'polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))',
  transition: 'all 0.2s',
}
const dangerBtn = { ...primaryBtn, background: C.red, color: '#fff' }
const ghostBtn  = {
  ...primaryBtn,
  clipPath: 'none', background: 'transparent', color: C.muted,
  border: `1px solid ${C.edge}`, fontFamily: 'var(--ff-mono)', fontSize: 12,
}

// ─── Built-in demo CSV ────────────────────────────────────────────────────────
const DEMO_CSV = `age,sex,education_num,hours_per_week,occupation,marital_status,workclass,capital_gain,income
38,Male,13,45,Exec,Married,Private,4500,>50K
29,Female,11,38,Service,Single,Private,0,<=50K
44,Male,15,55,Tech,Married,Self-emp,7200,>50K
31,Female,12,40,Service,Divorced,Private,0,<=50K
52,Male,14,50,Exec,Married,Private,8900,>50K
26,Female,10,35,Service,Single,Gov,0,<=50K
41,Male,13,48,Tech,Married,Private,3200,>50K
33,Female,13,42,Tech,Single,Gov,0,>50K
58,Male,16,60,Exec,Married,Self-emp,9500,>50K
27,Female,11,37,Service,Single,Private,0,<=50K
45,Male,12,44,Sales,Married,Private,2100,>50K
35,Female,14,40,Tech,Married,Gov,1500,>50K
39,Male,13,47,Exec,Married,Private,5600,>50K
30,Female,10,32,Service,Single,Private,0,<=50K
55,Male,15,58,Exec,Married,Self-emp,8200,>50K
28,Female,12,39,Sales,Single,Private,0,<=50K
47,Male,14,52,Tech,Married,Private,4100,>50K
36,Female,11,36,Service,Divorced,Private,0,<=50K
43,Male,13,46,Exec,Married,Private,6300,>50K
32,Female,15,44,Tech,Single,Gov,2000,>50K
${Array.from({length: 200}, (_,i) => {
  const male = i % 3 !== 0
  const occ  = male ? ['Exec','Exec','Tech','Sales','Labor'][i%5] : ['Service','Service','Labor','Sales','Tech'][i%5]
  const hrs  = male ? 40+i%20 : 30+i%18
  const edu  = male ? 12+i%4 : 10+i%5
  const inc  = (occ==='Exec'||occ==='Tech') && hrs>42 ? '>50K' : '<=50K'
  return `${22+i%40},${male?'Male':'Female'},${edu},${hrs},${occ},${['Married','Single','Divorced'][i%3]},${['Private','Gov','Self-emp'][i%3]},${i%7===0?3000+i*10:0},${inc}`
}).join('\n')}`
