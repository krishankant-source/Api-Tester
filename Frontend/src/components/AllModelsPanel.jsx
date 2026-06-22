import { useState } from 'react'
import ResultCard from './ResultCard.jsx'

function StatusDot({ status }) {
  if (status === 'running') return <span className="w-2.5 h-2.5 rounded-full bg-indigo-400 animate-pulse flex-shrink-0" />
  if (status === 'done') return <span className="w-2.5 h-2.5 rounded-full bg-green-400 flex-shrink-0" />
  if (status === 'error') return <span className="w-2.5 h-2.5 rounded-full bg-red-400 flex-shrink-0" />
  return <span className="w-2.5 h-2.5 rounded-full bg-slate-600 flex-shrink-0" />
}

export default function AllModelsPanel({ models, modelStates }) {
  const [expanded, setExpanded] = useState(null)

  const total = models.length
  const done = models.filter(m => ['done', 'error'].includes(modelStates[m]?.status)).length
  const running = models.filter(m => modelStates[m]?.status === 'running').length
  const pct = total ? Math.round((done / total) * 100) : 0

  return (
    <div className="space-y-4">
      {/* Overall progress */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-300 font-semibold">Testing all models</span>
          <span className="text-slate-500">{done}/{total} complete {running > 0 && `· ${running} running`}</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Per-model rows */}
      <div className="space-y-2">
        {models.map(model => {
          const state = modelStates[model] || { status: 'pending' }
          const { status, results = [], progressByLabel = {}, error } = state
          const passed = results.filter(r => r.success).length
          const failed = results.filter(r => !r.success).length
          const isOpen = expanded === model
          const latestMessages = Object.entries(progressByLabel)
            .map(([label, msgs]) => ({ label, msg: msgs[msgs.length - 1] }))
            .filter(x => x.msg)
            .slice(-3)

          return (
            <div key={model} className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
              <button
                onClick={() => results.length > 0 && setExpanded(isOpen ? null : model)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left ${results.length > 0 ? 'hover:bg-slate-800/50' : ''} transition-colors`}
              >
                <StatusDot status={status} />
                <span className="flex-1 text-sm font-medium text-slate-200">{model}</span>

                {status === 'pending' && <span className="text-xs text-slate-600">Waiting…</span>}

                {status === 'running' && (
                  <span className="text-xs text-indigo-400 animate-pulse">Running…</span>
                )}

                {(status === 'done' || status === 'error') && results.length > 0 && (
                  <div className="flex items-center gap-2">
                    {passed > 0 && <span className="text-xs bg-green-900/60 text-green-300 px-2 py-0.5 rounded-full">{passed} passed</span>}
                    {failed > 0 && <span className="text-xs bg-red-900/60 text-red-300 px-2 py-0.5 rounded-full">{failed} failed</span>}
                    <span className="text-slate-500 text-xs">{isOpen ? '▲' : '▼'}</span>
                  </div>
                )}

                {status === 'error' && results.length === 0 && (
                  <span className="text-xs text-red-400 truncate max-w-xs">{error}</span>
                )}
              </button>

              {/* Live progress messages while running */}
              {status === 'running' && latestMessages.length > 0 && (
                <div className="px-4 pb-3 space-y-1 border-t border-slate-800">
                  {latestMessages.map(({ label, msg }, i) => (
                    <div key={i} className="flex gap-2 text-xs text-slate-500">
                      <span className="text-slate-600 truncate max-w-[140px]">{label}</span>
                      <span className="truncate text-slate-500">{msg}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Expanded results */}
              {isOpen && results.length > 0 && (
                <div className="border-t border-slate-800 p-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {results.map((r, i) => <ResultCard key={i} result={r} />)}
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
