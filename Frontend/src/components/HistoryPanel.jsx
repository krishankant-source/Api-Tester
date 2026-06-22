import { useState } from 'react'
import ResultCard from './ResultCard.jsx'

function formatDate(iso) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDuration(ms) {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function HistoryPanel({ history, onClear }) {
  const [expanded, setExpanded] = useState(null)

  if (history.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <p className="text-4xl mb-3">📋</p>
        <p className="text-sm">No test runs yet. Run a test to see history here.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-400">{history.length} run{history.length !== 1 ? 's' : ''} saved</p>
        <button
          onClick={onClear}
          className="text-xs text-slate-500 hover:text-red-400 transition-colors"
        >
          Clear all
        </button>
      </div>

      <div className="space-y-3">
        {history.map(run => {
          const passed = run.results.filter(r => r.success).length
          const total = run.results.length
          const isOpen = expanded === run.id

          return (
            <div key={run.id} className="rounded-xl border border-slate-700 bg-slate-900 overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : run.id)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-800/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-100">{run.model}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${passed === total ? 'bg-green-900/60 text-green-300' : passed === 0 ? 'bg-red-900/60 text-red-300' : 'bg-yellow-900/60 text-yellow-300'}`}>
                      {passed}/{total} passed
                    </span>
                    {run.durationMs && (
                      <span className="text-xs text-slate-500">{formatDuration(run.durationMs)}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{formatDate(run.timestamp)}</p>
                </div>
                <span className="text-slate-500 text-sm flex-shrink-0">{isOpen ? '▲' : '▼'}</span>
              </button>

              {isOpen && (
                <div className="border-t border-slate-800 p-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {run.results.map((r, i) => (
                      <ResultCard key={i} result={r} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
