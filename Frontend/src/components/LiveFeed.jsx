export default function LiveFeed({ progressByLabel, results }) {
  const resultMap = new Map(results.map(r => [r.label, r]))

  const allLabels = [
    ...new Set([...Object.keys(progressByLabel), ...results.map(r => r.label)])
  ]

  if (allLabels.length === 0) return null

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
        <span className="text-sm font-semibold text-slate-300">Live Status</span>
      </div>
      <div className="divide-y divide-slate-800">
        {allLabels.map(label => {
          const result = resultMap.get(label)
          const messages = progressByLabel[label] || []
          const lastMsg = messages[messages.length - 1] || ''
          const isDone = !!result

          return (
            <div key={label} className="px-4 py-3 flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0">
                {isDone ? (
                  result.success
                    ? <span className="text-green-400 text-base">✓</span>
                    : <span className="text-red-400 text-base">✗</span>
                ) : (
                  <span className="w-4 h-4 mt-0.5 block border-2 border-slate-600 border-t-indigo-400 rounded-full animate-spin" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-200 truncate">{label}</p>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  {isDone
                    ? result.success
                      ? `Done in ${result.elapsedMs ? (result.elapsedMs / 1000).toFixed(1) + 's' : 'sync'}`
                      : result.error
                    : lastMsg}
                </p>
              </div>
              <div className="flex-shrink-0">
                {isDone && (
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${result.success ? 'bg-green-900/60 text-green-300' : 'bg-red-900/60 text-red-300'}`}>
                    {result.success ? 'PASS' : 'FAIL'}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
