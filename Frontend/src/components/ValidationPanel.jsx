import { useState } from 'react'

// Classification → display metadata
const META = {
  healthy:     { icon: '✓', dot: 'bg-green-400',  text: 'text-green-300',  badge: 'bg-green-900/60 text-green-300',   label: 'Reachable · key OK' },
  accepted:    { icon: '⚠', dot: 'bg-amber-400',  text: 'text-amber-300',  badge: 'bg-amber-900/60 text-amber-300',   label: 'Accepted empty request' },
  ratelimited: { icon: '⏳', dot: 'bg-amber-400',  text: 'text-amber-300',  badge: 'bg-amber-900/60 text-amber-300',   label: 'Rate limited (reachable)' },
  auth:        { icon: '🔑', dot: 'bg-red-400',    text: 'text-red-300',    badge: 'bg-red-900/60 text-red-300',       label: 'Auth failed — check key' },
  notfound:    { icon: '✗', dot: 'bg-red-400',    text: 'text-red-300',    badge: 'bg-red-900/60 text-red-300',       label: 'Not found (404)' },
  server:      { icon: '✗', dot: 'bg-red-400',    text: 'text-red-300',    badge: 'bg-red-900/60 text-red-300',       label: 'Server error (5xx)' },
  unreachable: { icon: '✗', dot: 'bg-red-400',    text: 'text-red-300',    badge: 'bg-red-900/60 text-red-300',       label: 'No response' },
  unknown:     { icon: '?', dot: 'bg-slate-500',  text: 'text-slate-400',  badge: 'bg-slate-700 text-slate-300',      label: 'Unknown' },
}
const bucketOf = c => (['healthy', 'ratelimited'].includes(c) ? 'ok' : c === 'accepted' ? 'warn' : 'fail')

function Row({ r }) {
  const m = META[r.classification] || META.unknown
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-slate-800 last:border-b-0">
      <span className={`mt-0.5 flex-shrink-0 ${m.text}`}>{m.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-slate-200 truncate">{r.modalityName}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${m.badge}`}>
            {r.statusCode ?? '—'} · {m.label}
          </span>
        </div>
        {r.detail && <p className="text-xs text-slate-500 mt-0.5 break-words">{r.detail}</p>}
        {r.endpoint && (
          <p className="text-[11px] text-slate-600 font-mono whitespace-nowrap overflow-x-auto mt-0.5" title={r.endpoint}>{r.endpoint}</p>
        )}
      </div>
    </div>
  )
}

function Summary({ results, expected, running, modelsProgress }) {
  const counts = results.reduce((a, r) => { a[bucketOf(r.classification)]++; return a }, { ok: 0, warn: 0, fail: 0 })
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">🛡️ Validation</span>
          {counts.warn === 0 ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/50 text-green-300 font-semibold">NO CREDITS USED</span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/50 text-amber-300 font-semibold">⚠ {counts.warn} ACCEPTED — MAY HAVE BILLED</span>
          )}
        </div>
        <span className="text-xs text-slate-500">
          {results.length}{expected ? ` / ${expected}` : ''} probed
          {modelsProgress && ` · ${modelsProgress.done}/${modelsProgress.total} models`}
          {running && ' · running…'}
        </span>
      </div>
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-400" /><span className="text-slate-300">{counts.ok} healthy</span></span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400" /><span className="text-slate-300">{counts.warn} accepted</span></span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /><span className="text-slate-300">{counts.fail} problem{counts.fail !== 1 ? 's' : ''}</span></span>
      </div>
      {counts.warn > 0 && (
        <p className="text-[11px] text-amber-400/80 mt-2">⚠ “Accepted” means the endpoint took an empty request — it was <b>not</b> polled, but couldn’t be verified for free. (Models with no required field.)</p>
      )}
    </div>
  )
}

function ModelGroup({ model, results }) {
  const [open, setOpen] = useState(false)
  const counts = results.reduce((a, r) => { a[bucketOf(r.classification)]++; return a }, { ok: 0, warn: 0, fail: 0 })
  const dot = counts.fail > 0 ? 'bg-red-400' : counts.warn > 0 ? 'bg-amber-400' : 'bg-green-400'
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/50 transition-colors">
        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dot}`} />
        <span className="flex-1 text-sm font-medium text-slate-200">{model}</span>
        <span className="text-xs text-slate-500">
          {counts.ok > 0 && <span className="text-green-400">{counts.ok}✓ </span>}
          {counts.warn > 0 && <span className="text-amber-400">{counts.warn}⚠ </span>}
          {counts.fail > 0 && <span className="text-red-400">{counts.fail}✗ </span>}
        </span>
        <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="border-t border-slate-800">{results.map((r, i) => <Row key={i} r={r} />)}</div>}
    </div>
  )
}

export default function ValidationPanel({ results, expected, running, grouped, modelsProgress }) {
  if (results.length === 0 && !running) return null

  let body
  if (grouped) {
    // group by model, preserving first-seen order
    const order = []
    const byModel = {}
    for (const r of results) {
      const k = r.model || '—'
      if (!byModel[k]) { byModel[k] = []; order.push(k) }
      byModel[k].push(r)
    }
    body = <div className="space-y-2">{order.map(m => <ModelGroup key={m} model={m} results={byModel[m]} />)}</div>
  } else {
    body = (
      <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
        {results.map((r, i) => <Row key={i} r={r} />)}
        {running && results.length === 0 && <div className="px-4 py-6 text-center text-sm text-slate-500">Probing endpoints…</div>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Summary results={results} expected={expected} running={running} modelsProgress={modelsProgress} />
      {body}
    </div>
  )
}
