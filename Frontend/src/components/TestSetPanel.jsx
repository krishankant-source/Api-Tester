import { useState } from 'react'
import { ModalityEditor } from './RequestEditor.jsx'

/**
 * The cross-model "test set" (cart): modalities hand-picked from different
 * models, tested (or validated) together in one run. Each row can be expanded
 * to edit its request parameters (reuses the single-model Change-Parameters UI).
 */
export default function TestSetPanel({ items, overrides, onSetOverride, onRemove, onClear, onRun, validationMode, running }) {
  const [openKey, setOpenKey] = useState(null)

  if (!items.length) return null

  return (
    <div className={`border rounded-xl overflow-hidden ${validationMode ? 'border-emerald-700/50 bg-emerald-950/10' : 'border-indigo-700/50 bg-indigo-950/10'}`}>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/60">
        <span className="text-sm font-semibold text-slate-100">🧺 Test Set</span>
        <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">{items.length}</span>
        <span className="text-xs text-slate-500">modalities from {new Set(items.map(i => i.model)).size} model(s)</span>
        <button onClick={onClear} disabled={running} className="ml-auto text-xs text-slate-500 hover:text-red-400 disabled:opacity-40">Clear all</button>
      </div>

      <div className="divide-y divide-slate-800/70 max-h-[26rem] overflow-y-auto">
        {items.map(it => {
          const edited = overrides[it.key] != null
          const isOpen = openKey === it.key
          return (
            <div key={it.key}>
              <div className="flex items-center gap-2 px-4 py-2.5">
                <span className="text-[10px] font-semibold text-indigo-300 bg-indigo-950/60 border border-indigo-800/60 px-1.5 py-0.5 rounded flex-shrink-0">{it.model}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-200 truncate">{it.modalityName}</div>
                  <div className="text-[11px] text-slate-500 font-mono whitespace-nowrap overflow-x-auto" title={it.endpoint}>{it.endpoint}</div>
                </div>
                {edited && <span className="text-[10px] bg-amber-900/60 text-amber-300 px-1.5 py-0.5 rounded-full flex-shrink-0">edited</span>}
                {!validationMode && (
                  <button
                    onClick={() => setOpenKey(isOpen ? null : it.key)}
                    disabled={running}
                    className={`text-xs px-2 py-1 rounded-md border transition-colors disabled:opacity-40 flex-shrink-0 ${isOpen ? 'bg-amber-900/40 border-amber-600/60 text-amber-300' : 'border-slate-600 text-slate-300 hover:bg-slate-800'}`}
                    title="Edit this modality's request parameters"
                  >
                    ⚙ {isOpen ? 'Close' : 'Params'}
                  </button>
                )}
                <button onClick={() => onRemove(it.key)} disabled={running} className="text-slate-500 hover:text-red-400 text-xs disabled:opacity-40 flex-shrink-0">✕</button>
              </div>

              {isOpen && !validationMode && (
                <div className="px-4 pb-3">
                  <ModalityEditor
                    modality={{
                      index: it.modalityIdx,
                      modalityName: it.modalityName,
                      modelType: it.modelType,
                      method: it.method,
                      endpoint: it.endpoint,
                      parameters: it.parameters || [],
                      exampleRequest: it.exampleRequest || {},
                      hasExample: it.hasExample,
                    }}
                    value={overrides[it.key] ?? (it.exampleRequest || {})}
                    onChange={val => onSetOverride(it.key, val)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="px-4 py-3 border-t border-slate-700/60 flex items-center gap-3">
        <button
          onClick={onRun}
          disabled={running}
          className={`flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${validationMode ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}
        >
          {running ? (
            <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Running…</>
          ) : validationMode ? (
            <>🛡️ Validate Selected ({items.length})</>
          ) : (
            <>▶ Test Selected ({items.length})</>
          )}
        </button>
        <span className="text-xs text-slate-500">
          {validationMode ? 'Free health-check of every selected endpoint.' : 'Runs all selected modalities simultaneously (⚙ to tweak params).'}
        </span>
      </div>
    </div>
  )
}
