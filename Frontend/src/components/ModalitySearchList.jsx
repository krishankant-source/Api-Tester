import { useState } from 'react'

/**
 * Searchable list of a model's modalities. Filter by modality name OR endpoint,
 * and add/remove each to the cross-model "test set".
 */
export default function ModalitySearchList({ model, modalities, isInSet, onToggle, running }) {
  const [q, setQ] = useState('')

  if (!model || !modalities.length) return null

  const query = q.trim().toLowerCase()
  const filtered = query
    ? modalities.filter(m =>
        (m.modalityName || '').toLowerCase().includes(query) ||
        (m.label || '').toLowerCase().includes(query) ||
        (m.endpoint || '').toLowerCase().includes(query))
    : modalities

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 bg-slate-800/40">
        <span className="text-sm font-semibold text-slate-200">{model} — modalities</span>
        <div className="ml-auto flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 flex-1 max-w-xs focus-within:border-indigo-500">
          <span className="text-slate-500 text-xs">🔍</span>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search by name or endpoint…"
            className="flex-1 bg-transparent text-xs text-slate-100 placeholder-slate-500 outline-none min-w-0"
          />
          {q && <button onClick={() => setQ('')} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>}
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto divide-y divide-slate-800">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">No modalities match “{q}”</p>
        ) : filtered.map(m => {
          const inSet = isInSet(m.index)
          return (
            <button
              key={m.index}
              onClick={() => onToggle(m)}
              disabled={running}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:opacity-50 ${inSet ? 'bg-indigo-950/40 hover:bg-indigo-950/60' : 'hover:bg-slate-800/50'}`}
            >
              <span className={`flex-shrink-0 w-5 h-5 rounded border flex items-center justify-center text-xs ${inSet ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-slate-600 text-transparent'}`}>✓</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-200 truncate">{m.modalityName}</span>
                  {m.modelType && <span className="text-[10px] text-indigo-400 flex-shrink-0">{m.modelType}</span>}
                </div>
                <div className="text-[11px] text-slate-500 font-mono whitespace-nowrap overflow-x-auto" title={m.endpoint}>{m.endpoint}</div>
              </div>
              <span className={`flex-shrink-0 text-xs font-medium ${inSet ? 'text-indigo-300' : 'text-slate-500'}`}>{inSet ? 'Added' : '+ Add'}</span>
            </button>
          )
        })}
      </div>
      <div className="px-4 py-2 border-t border-slate-700 text-xs text-slate-500">
        {filtered.length} of {modalities.length} modalities · click to add to the Test Set
      </div>
    </div>
  )
}
