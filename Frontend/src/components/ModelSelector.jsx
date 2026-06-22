import { useState, useRef, useEffect } from 'react'

export default function ModelSelector({
  models, selected, onChange,
  modalities, selectedModality, onModalityChange,
  onStart, onTestAll, running,
  showEditor, onToggleEditor, hasOverrides,
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  const filtered = query.trim()
    ? models.filter(m => m.toLowerCase().includes(query.toLowerCase()))
    : models

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function pick(model) {
    onChange(model)
    setQuery('')
    setOpen(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
        {/* Model search dropdown */}
        <div className="relative flex-1 max-w-xs" ref={containerRef}>
          <div className={`flex items-center gap-2 bg-slate-800 border rounded-lg px-3 py-2.5 transition-colors ${open ? 'border-indigo-500 ring-2 ring-indigo-500/30' : 'border-slate-700'} ${running ? 'opacity-50 pointer-events-none' : ''}`}>
            <span className="text-slate-500 text-sm flex-shrink-0">🔍</span>
            <input
              type="text"
              value={open ? query : selected || ''}
              placeholder="Search model…"
              onFocus={() => { setOpen(true); setQuery('') }}
              onChange={e => setQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none min-w-0"
            />
            {selected && !open && (
              <button onClick={() => { onChange(''); onModalityChange('') }} className="text-slate-500 hover:text-slate-300 flex-shrink-0 text-xs">✕</button>
            )}
            <span className="text-slate-500 text-xs flex-shrink-0">{open ? '▲' : '▼'}</span>
          </div>

          {open && (
            <div className="absolute z-50 mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
              {filtered.length === 0 ? (
                <p className="px-4 py-3 text-sm text-slate-500">No models match "{query}"</p>
              ) : (
                <ul className="max-h-60 overflow-y-auto">
                  {filtered.map(m => (
                    <li key={m}>
                      <button
                        onMouseDown={() => pick(m)}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${m === selected ? 'bg-indigo-600 text-white' : 'text-slate-200 hover:bg-slate-700'}`}
                      >
                        {query ? highlight(m, query) : m}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="px-3 py-1.5 border-t border-slate-700 text-xs text-slate-600">
                {filtered.length} of {models.length} models
              </div>
            </div>
          )}
        </div>

        {/* Modality dropdown — only shown when a model is selected */}
        {selected && modalities.length > 0 && (
          <div className="relative">
            <select
              value={selectedModality}
              onChange={e => onModalityChange(e.target.value)}
              disabled={running}
              className="appearance-none bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-4 py-2.5 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer max-w-[260px]"
            >
              <option value="">All modalities ({modalities.length})</option>
              {modalities.map(m => (
                <option key={m.index} value={String(m.index)}>{m.label}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">▼</span>
          </div>
        )}

        {/* Edit Request Params — only when a model is selected */}
        {selected && (
          <button
            onClick={onToggleEditor}
            disabled={running}
            className={`flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${
              showEditor
                ? 'bg-amber-900/40 border-amber-600/60 text-amber-300 hover:bg-amber-900/60'
                : hasOverrides
                ? 'bg-amber-900/20 border-amber-700/50 text-amber-400 hover:bg-amber-900/40'
                : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
            }`}
          >
            ⚙️ {showEditor ? 'Hide Parameters' : 'Change Parameters'}
            {hasOverrides && !showEditor && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />}
          </button>
        )}

        {/* Start Test */}
        <button
          onClick={onStart}
          disabled={!selected || running}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
        >
          {running ? (
            <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Running…</>
          ) : (
            <>▶ {selectedModality !== '' ? 'Test Modality' : 'Test Model'}</>
          )}
        </button>

        {/* Test All Models */}
        <button
          onClick={onTestAll}
          disabled={running}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-sm font-semibold transition-colors border border-slate-600"
        >
          {running ? (
            <><span className="w-3.5 h-3.5 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin" />Running…</>
          ) : (
            <>⚡ Test All Models</>
          )}
        </button>
      </div>
    </div>
  )
}

function highlight(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-indigo-500/40 text-indigo-200 rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}
