import { useState, useEffect } from 'react'

// Build a copy-pasteable curl from the modality + the body actually being sent.
function buildCurl(method, endpoint, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Ocp-Apim-Subscription-Key': '$PIXAZO_KEY',
  }
  const lines = [`curl -X ${method || 'POST'} ${JSON.stringify(endpoint || '')}`]
  // Headers double-quoted so $PIXAZO_KEY expands; body single-quoted so the JSON
  // is literal (no $/backtick expansion or shell injection).
  for (const [k, v] of Object.entries(headers)) lines.push(`  -H ${JSON.stringify(`${k}: ${v}`)}`)
  const bodyStr = JSON.stringify(body ?? {})
  lines.push(`  -d '${bodyStr.replace(/'/g, "'\\''")}'`)
  return lines.join(' \\\n')
}

/* ── A single parameter control (dropdown / pills / toggle / number / text) ── */
function ParamField({ param, current, onSet }) {
  const { name, type, control, options = [], min, max, description, required, inExample } = param

  let field
  if (control === 'boolean') {
    const on = current === true || current === 'true'
    field = (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onSet(!on)}
          className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-indigo-500' : 'bg-slate-700'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <span className="text-xs font-mono text-slate-400">{String(on)}</span>
      </div>
    )
  } else if (control === 'enum') {
    if (options.length <= 6) {
      field = (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt, i) => {
            const sel = String(current) === String(opt)
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSet(opt)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  sel
                    ? 'bg-indigo-600 border-indigo-500 text-white'
                    : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-indigo-500 hover:text-white'
                }`}
              >
                {String(opt)}
              </button>
            )
          })}
        </div>
      )
    } else {
      field = (
        <select
          value={current ?? ''}
          onChange={e => {
            const raw = e.target.value
            const match = options.find(o => String(o) === raw)
            onSet(match !== undefined ? match : raw)
          }}
          className="appearance-none bg-slate-800 border border-slate-600 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer max-w-xs"
        >
          {options.map((opt, i) => <option key={i} value={String(opt)}>{String(opt)}</option>)}
        </select>
      )
    }
  } else if (control === 'number') {
    field = (
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={current ?? ''}
          min={min}
          max={max}
          step={/int/i.test(type) ? 1 : 'any'}
          onChange={e => onSet(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-32 bg-slate-800 border border-slate-600 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {(min !== undefined || max !== undefined) && (
          <span className="text-xs text-slate-500">
            {min !== undefined ? min : '—'} to {max !== undefined ? max : '—'}
          </span>
        )}
      </div>
    )
  } else {
    // text — use a textarea for long / prompt-like fields
    const longish = /prompt|text|description|caption|negative/i.test(name) || (typeof current === 'string' && current.length > 60)
    field = longish ? (
      <textarea
        value={current ?? ''}
        onChange={e => onSet(e.target.value)}
        rows={3}
        className="w-full bg-slate-800 border border-slate-600 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y leading-relaxed"
      />
    ) : (
      <input
        type="text"
        value={current ?? ''}
        onChange={e => onSet(e.target.value)}
        className="w-full bg-slate-800 border border-slate-600 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    )
  }

  return (
    <div className="py-3.5 border-b border-slate-800 last:border-b-0">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-sm font-mono font-semibold text-slate-200">{name}</span>
        <span className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded-full bg-slate-800 border border-slate-700">{type}</span>
        {required
          ? <span className="text-[10px] font-bold text-indigo-400">REQUIRED</span>
          : <span className="text-[10px] text-slate-600">optional</span>}
        {!inExample && <span className="text-[10px] text-slate-600">· not in example</span>}
      </div>
      {field}
      {description && <p className="text-xs text-slate-500 mt-2 leading-snug">{description}</p>}
    </div>
  )
}

/* ── One modality: Form ⇄ JSON views ──────────────────────────────────────── */
export function ModalityEditor({ modality, value, onChange }) {
  const params = modality.parameters || []
  const isObj = value && typeof value === 'object' && !Array.isArray(value)
  const canForm = params.length > 0 && isObj

  const [view, setView] = useState(canForm ? 'form' : 'json')
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  function copyCurl() {
    const curl = buildCurl(modality.method, modality.endpoint, value)
    navigator.clipboard?.writeText(curl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  // Keep the JSON text in sync when `value` changes from outside (form edits / reset),
  // but don't reformat while the user is typing valid JSON that already equals value.
  useEffect(() => {
    try { if (JSON.stringify(JSON.parse(text)) === JSON.stringify(value)) return } catch { /* fall through */ }
    setText(JSON.stringify(value, null, 2))
    setError(null)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const modified = JSON.stringify(value) !== JSON.stringify(modality.exampleRequest)

  function setField(pname, v) {
    onChange({ ...value, [pname]: v })
  }
  function handleJson(e) {
    const raw = e.target.value
    setText(raw)
    try { onChange(JSON.parse(raw)); setError(null) }
    catch { setError('Invalid JSON') }
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${modified ? 'border-amber-600/50' : 'border-slate-700'}`}>
      {/* Header */}
      <div className="px-4 py-2.5 bg-slate-800/60">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-slate-500 flex-shrink-0">#{modality.index}</span>
              <span className="text-sm font-medium text-slate-200">{modality.modalityName}</span>
              {modified && (
                <span className="text-xs bg-amber-900/60 text-amber-300 px-1.5 py-0.5 rounded-full flex-shrink-0">edited</span>
              )}
              {modality.hasExample === false && (
                <span className="text-xs bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full flex-shrink-0"
                  title="The spec had no example body for this modality — add one before a real test, or it sends an empty request.">
                  ⚠ no example body
                </span>
              )}
            </div>
            {modality.modelType && <span className="text-xs text-indigo-400">{modality.modelType}</span>}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* View switch */}
            <div className="flex bg-slate-900 border border-slate-700 rounded-lg p-0.5">
              <button
                onClick={() => setView('form')}
                disabled={!canForm}
                title={canForm ? '' : 'No parameter metadata — run the scraper'}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${view === 'form' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                Form
              </button>
              <button
                onClick={() => setView('json')}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${view === 'json' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                JSON
              </button>
            </div>
            <button onClick={copyCurl}
              className={`text-xs transition-colors ${copied ? 'text-green-400' : 'text-slate-400 hover:text-slate-200'}`}
              title="Copy this request as a curl command">
              {copied ? '✓ copied' : '⧉ curl'}
            </button>
            <button onClick={() => onChange(null)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">↺ Reset</button>
          </div>
        </div>

        {/* Full request URL — one line, never wraps; scroll horizontally to read it end-to-end */}
        {modality.endpoint && (
          <div
            className="mt-2 flex items-center gap-2 bg-slate-950/70 border border-slate-700/60 rounded-md px-2.5 py-1.5 text-xs font-mono overflow-x-auto whitespace-nowrap"
            title={modality.endpoint}
          >
            <span className="text-emerald-400 font-semibold flex-shrink-0">{modality.method || 'POST'}</span>
            <span className="text-slate-300">{modality.endpoint}</span>
          </div>
        )}
      </div>

      {/* Body */}
      {view === 'form' ? (
        canForm ? (
          <div className="px-4 py-1 bg-slate-900/40">
            {params.map(p => {
              const has = Object.prototype.hasOwnProperty.call(value, p.name)
              const current = has ? value[p.name] : p.default
              return <ParamField key={p.name} param={p} current={current} onSet={v => setField(p.name, v)} />
            })}
          </div>
        ) : (
          <div className="px-4 py-6 text-center text-xs text-slate-500 bg-slate-900/40">
            No parameter metadata for this modality. Use the <span className="text-slate-400">JSON</span> view, or run the scraper to enable guided editing.
          </div>
        )
      ) : (
        <div className="relative">
          <textarea
            value={text}
            onChange={handleJson}
            spellCheck={false}
            rows={Math.min(Math.max(text.split('\n').length, 4), 16)}
            className="w-full bg-slate-950 text-slate-200 font-mono text-xs px-4 py-3 resize-y outline-none focus:ring-1 focus:ring-indigo-500/50 leading-relaxed"
          />
          <div className="absolute bottom-2 right-3 text-xs">
            {error ? <span className="text-red-400">{error}</span> : <span className="text-green-500">✓ valid JSON</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function RequestEditor({ modalities, selectedModality, overrides, onChange, onClose, onReset }) {
  const visible = selectedModality !== ''
    ? modalities.filter(m => String(m.index) === selectedModality)
    : modalities

  const editedCount = Object.keys(overrides).length

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 bg-slate-800/40">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-200">⚙️ Change Parameters</span>
          {editedCount > 0 && (
            <span className="text-xs bg-amber-900/60 text-amber-300 px-2 py-0.5 rounded-full">{editedCount} modified</span>
          )}
          <span className="text-xs text-slate-500">{visible.length} {visible.length === 1 ? 'modality' : 'modalities'}</span>
        </div>
        <div className="flex items-center gap-3">
          {editedCount > 0 && (
            <button onClick={onReset} className="text-xs text-slate-500 hover:text-red-400 transition-colors">Reset all</button>
          )}
          <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">✕ Close</button>
        </div>
      </div>

      {/* Editors */}
      <div className="p-4 space-y-3 max-h-[64vh] overflow-y-auto">
        {visible.map(m => (
          <ModalityEditor
            key={m.index}
            modality={m}
            value={overrides[String(m.index)] ?? m.exampleRequest}
            onChange={val => onChange(String(m.index), val)}
          />
        ))}
      </div>

      <div className="px-5 py-3 border-t border-slate-700 bg-slate-800/40 flex items-center gap-2 text-xs text-slate-500">
        <span>💡</span>
        <span>Pick values per parameter, or switch to JSON for full control. Changes apply only to this test run.</span>
      </div>
    </div>
  )
}
