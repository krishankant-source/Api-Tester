import { useState, useEffect, useRef } from 'react'
import ModelSelector from './components/ModelSelector.jsx'
import LiveFeed from './components/LiveFeed.jsx'
import ResultCard from './components/ResultCard.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import AllModelsPanel from './components/AllModelsPanel.jsx'
import RequestEditor from './components/RequestEditor.jsx'
import ScraperModal from './components/ScraperModal.jsx'
import ValidationPanel from './components/ValidationPanel.jsx'
import ModalitySearchList from './components/ModalitySearchList.jsx'
import TestSetPanel from './components/TestSetPanel.jsx'

const TABS = ['Test', 'History']

export default function App() {
  const [tab, setTab] = useState('Test')

  // Model + modality selection
  const [models, setModels] = useState([])
  const [selected, setSelected] = useState('')
  const [modalities, setModalities] = useState([])
  const [selectedModality, setSelectedModality] = useState('')

  // Request editor
  const [showEditor, setShowEditor] = useState(false)
  const [overrides, setOverrides] = useState({}) // { [modalityIndex]: parsedJSON }

  // Test state
  const [testMode, setTestMode] = useState(null) // null | 'single' | 'all'
  const [testState, setTestState] = useState('idle') // idle | running | done | error
  const [progressByLabel, setProgressByLabel] = useState({})
  const [results, setResults] = useState([])
  const [currentRun, setCurrentRun] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')

  // Test-all state
  const [allModels, setAllModels] = useState([])
  const [modelStates, setModelStates] = useState({})

  const [history, setHistory] = useState([])
  const [scrapeOpen, setScrapeOpen] = useState(false)
  const [buildSpecsOpen, setBuildSpecsOpen] = useState(false)
  const [source, setSource] = useState('scraped') // 'scraped' | 'spec'

  // Cross-model test set (cart of modalities from different models)
  const [testSet, setTestSet] = useState([]) // { key, model, modalityIdx, ...full modality }
  const [selectionOverrides, setSelectionOverrides] = useState({}) // { [item.key]: customBody }
  const [searchIndex, setSearchIndex] = useState({}) // model -> { endpoints, modalities } for endpoint search

  // Validation mode (no-cost health probing)
  const [validationMode, setValidationMode] = useState(false)
  const [valResults, setValResults] = useState([])
  const [valExpected, setValExpected] = useState(null)
  const [valModelsProgress, setValModelsProgress] = useState(null) // { done, total } for validate-all

  const esRef = useRef(null)

  // ── Loaders ──────────────────────────────────────────────────────────────

  function loadSearchIndex() {
    fetch('/api/search-index').then(r => r.json()).then(arr => {
      const map = {}
      for (const x of arr) map[x.name] = { endpoints: x.endpoints || [], modalities: x.modalities || [] }
      setSearchIndex(map)
    }).catch(() => {})
  }

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
    fetch('/api/source').then(r => r.json()).then(d => setSource(d.source)).catch(() => {})
    loadSearchIndex()
  }, [])

  // Switch config source (scraped ↔ spec ↔ models); reset selection + reload model list
  function changeSource(src) {
    if (src === source || running) return
    fetch('/api/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: src }) })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setErrorMsg(d.error); return }
        setSource(d.source)
        setSelected(''); setSelectedModality(''); setModalities([]); setOverrides({})
        setTestSet([]); setSelectionOverrides({}) // indices are per-source; a stale set would point at wrong modalities
        setTestMode(null); setTestState('idle')
        fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
        loadSearchIndex()
      })
      .catch(() => {})
  }

  // Re-parse Backend/Models/ (the "models" source is built from those files on
  // the fly) so files added/edited after load are picked up without a restart.
  function rescanModels() {
    if (running) return
    fetch('/api/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'models' }) })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setErrorMsg(d.error); return }
        setSelected(''); setSelectedModality(''); setModalities([]); setOverrides({})
        setTestSet([]); setSelectionOverrides({})
        setTestMode(null); setTestState('idle')
        fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
        loadSearchIndex()
      })
      .catch(() => {})
  }

  useEffect(() => {
    if (tab === 'History') refreshHistory()
  }, [tab])

  useEffect(() => {
    if (!selected) { setModalities([]); setSelectedModality(''); setOverrides({}); setShowEditor(false); return }
    fetch(`/api/models/${encodeURIComponent(selected)}/modalities`)
      .then(r => r.json())
      .then(mods => { setModalities(mods); setOverrides({}); })
      .catch(() => setModalities([]))
  }, [selected])

  // ── History ───────────────────────────────────────────────────────────────

  function refreshHistory() {
    fetch('/api/history').then(r => r.json()).then(setHistory).catch(() => {})
  }
  function clearHistory() {
    fetch('/api/history', { method: 'DELETE' }).then(() => setHistory([])).catch(() => {})
  }

  // ── Override editor ───────────────────────────────────────────────────────

  function handleOverrideChange(idx, val) {
    setOverrides(prev => {
      if (val == null) { const next = { ...prev }; delete next[idx]; return next } // reset this modality
      return { ...prev, [idx]: val }
    })
  }

  // Re-fetch models + current modalities (called after a scrape completes)
  function refreshAfterScrape() {
    fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
    loadSearchIndex()
    if (selected) {
      fetch(`/api/models/${encodeURIComponent(selected)}/modalities`)
        .then(r => r.json())
        .then(mods => { setModalities(mods); setOverrides({}) })
        .catch(() => {})
    }
  }
  function resetOverrides() {
    setOverrides({})
  }
  const hasOverrides = Object.keys(overrides).length > 0

  // ── SSE helpers ───────────────────────────────────────────────────────────

  function resetSingleState() {
    setProgressByLabel({})
    setResults([])
    setCurrentRun(null)
    setErrorMsg('')
  }
  function resetAllState() {
    setAllModels([])
    setModelStates({})
  }
  function closeSSE() {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
  }

  function openSSE(url) {
    closeSSE()
    const es = new EventSource(url)
    esRef.current = es
    return es
  }

  function attachSingleHandlers(es) {
    let settled = false
    es.addEventListener('progress', e => {
      const { label, message } = JSON.parse(e.data)
      setProgressByLabel(prev => ({ ...prev, [label]: [...(prev[label] || []), message] }))
    })
    es.addEventListener('result', e => setResults(prev => [...prev, JSON.parse(e.data)]))
    es.addEventListener('done', e => { settled = true; setCurrentRun(JSON.parse(e.data)); setTestState('done'); es.close() })
    es.addEventListener('error', e => {
      settled = true
      if (e.data) setErrorMsg(JSON.parse(e.data).message)
      setTestState('error'); es.close()
    })
    es.onerror = () => { if (settled) return; setTestState('error'); setErrorMsg('Connection to server lost'); es.close() }
  }

  // ── Start single model / modality test ───────────────────────────────────

  async function startTest() {
    if (!selected || testState === 'running') return
    resetSingleState()
    resetValState()
    setTestMode('single')
    setTestState('running')
    setShowEditor(false)

    let testId = null
    if (hasOverrides) {
      try {
        const r = await fetch('/api/test/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overrides }),
        })
        testId = (await r.json()).testId
      } catch { /* run without overrides if prepare fails */ }
    }

    const params = new URLSearchParams()
    if (selectedModality !== '') params.set('modalityIdx', selectedModality)
    if (testId) params.set('testId', testId)
    const qs = params.toString()
    const url = `/api/test/${encodeURIComponent(selected)}/stream${qs ? '?' + qs : ''}`

    attachSingleHandlers(openSSE(url))
  }

  // ── Start test-all ────────────────────────────────────────────────────────

  function startTestAll() {
    if (testState === 'running') return
    resetAllState()
    resetSingleState()
    resetValState()
    setTestMode('all')
    setTestState('running')
    setShowEditor(false)

    let settled = false
    const es = openSSE('/api/test-all/stream')

    es.addEventListener('models', e => {
      const { models: ms } = JSON.parse(e.data)
      setAllModels(ms)
      setModelStates(Object.fromEntries(ms.map(m => [m, { status: 'pending', results: [], progressByLabel: {} }])))
    })
    es.addEventListener('model-start', e => {
      const { model } = JSON.parse(e.data)
      setModelStates(prev => ({ ...prev, [model]: { ...prev[model], status: 'running' } }))
    })
    es.addEventListener('progress', e => {
      const { model, label, message } = JSON.parse(e.data)
      setModelStates(prev => {
        const s = prev[model] || { status: 'running', results: [], progressByLabel: {} }
        return { ...prev, [model]: { ...s, progressByLabel: { ...s.progressByLabel, [label]: [...(s.progressByLabel[label] || []), message] } } }
      })
    })
    es.addEventListener('result', e => {
      const result = JSON.parse(e.data)
      setModelStates(prev => {
        const s = prev[result.model] || { status: 'running', results: [], progressByLabel: {} }
        return { ...prev, [result.model]: { ...s, results: [...s.results, result] } }
      })
    })
    es.addEventListener('model-done', e => {
      const { model } = JSON.parse(e.data)
      setModelStates(prev => ({ ...prev, [model]: { ...prev[model], status: 'done' } }))
    })
    es.addEventListener('model-error', e => {
      const { model, error } = JSON.parse(e.data)
      setModelStates(prev => ({ ...prev, [model]: { ...prev[model], status: 'error', error } }))
    })
    es.addEventListener('done', e => { settled = true; setCurrentRun(JSON.parse(e.data)); setTestState('done'); es.close() })
    es.addEventListener('error', e => {
      settled = true
      if (e.data) setErrorMsg(JSON.parse(e.data).message)
      setTestState('error'); es.close()
    })
    es.onerror = () => { if (settled) return; setTestState('error'); setErrorMsg('Connection to server lost'); es.close() }
  }

  // ── Validation mode (no-cost probes) ──────────────────────────────────────

  function resetValState() {
    setValResults([])
    setValExpected(null)
    setValModelsProgress(null)
  }

  function startValidate() {
    if (!selected || testState === 'running') return
    resetValState(); resetSingleState(); resetAllState()
    setTestMode('validate'); setTestState('running'); setShowEditor(false)

    const params = new URLSearchParams()
    if (selectedModality !== '') params.set('modalityIdx', selectedModality)
    const qs = params.toString()
    let settled = false
    const es = openSSE(`/api/validate/${encodeURIComponent(selected)}/stream${qs ? '?' + qs : ''}`)

    es.addEventListener('start', e => setValExpected(JSON.parse(e.data).count))
    es.addEventListener('result', e => setValResults(prev => [...prev, JSON.parse(e.data)]))
    es.addEventListener('done', () => { settled = true; setTestState('done'); es.close() })
    es.addEventListener('error', e => { settled = true; if (e.data) setErrorMsg(JSON.parse(e.data).message); setTestState('error'); es.close() })
    es.onerror = () => { if (settled) return; setTestState('error'); setErrorMsg('Connection to server lost'); es.close() }
  }

  function startValidateAll() {
    if (testState === 'running') return
    resetValState(); resetSingleState(); resetAllState()
    setTestMode('validate-all'); setTestState('running'); setShowEditor(false)

    let settled = false
    const es = openSSE('/api/validate-all/stream')
    es.addEventListener('models', e => setValModelsProgress({ done: 0, total: JSON.parse(e.data).total }))
    es.addEventListener('result', e => setValResults(prev => [...prev, JSON.parse(e.data)]))
    es.addEventListener('model-done', () => setValModelsProgress(prev => prev ? { ...prev, done: prev.done + 1 } : prev))
    es.addEventListener('model-error', () => setValModelsProgress(prev => prev ? { ...prev, done: prev.done + 1 } : prev))
    es.addEventListener('done', () => { settled = true; setTestState('done'); es.close() })
    es.addEventListener('error', e => { settled = true; if (e.data) setErrorMsg(JSON.parse(e.data).message); setTestState('error'); es.close() })
    es.onerror = () => { if (settled) return; setTestState('error'); setErrorMsg('Connection to server lost'); es.close() }
  }

  // Route the action buttons to test or validate depending on the toggle
  function handleStart() { validationMode ? startValidate() : startTest() }
  function handleTestAll() { validationMode ? startValidateAll() : startTestAll() }

  // ── Test set (cross-model selection) ──────────────────────────────────────
  const setKey = (model, idx) => `${model}#${idx}`
  const isInSet = (model, idx) => testSet.some(s => s.key === setKey(model, idx))
  function toggleInSet(model, mod) {
    const key = setKey(model, mod.index)
    setTestSet(prev => {
      if (prev.some(s => s.key === key)) {
        setSelectionOverrides(o => { const n = { ...o }; delete n[key]; return n })
        return prev.filter(s => s.key !== key)
      }
      return [...prev, {
        key, model, modalityIdx: mod.index,
        subModelName: mod.subModelName, modalityName: mod.modalityName,
        endpoint: mod.endpoint, method: mod.method, modelType: mod.modelType,
        exampleRequest: mod.exampleRequest, parameters: mod.parameters || [], hasExample: mod.hasExample,
      }]
    })
  }
  const removeFromSet = key => {
    setTestSet(prev => prev.filter(s => s.key !== key))
    setSelectionOverrides(o => { const n = { ...o }; delete n[key]; return n })
  }
  const clearSet = () => { setTestSet([]); setSelectionOverrides({}) }
  function setItemOverride(key, val) {
    setSelectionOverrides(prev => {
      if (val == null) { const n = { ...prev }; delete n[key]; return n }
      return { ...prev, [key]: val }
    })
  }

  async function startSelection() {
    if (!testSet.length || testState === 'running') return
    const validate = validationMode
    resetSingleState(); resetAllState(); resetValState()
    setTestMode(validate ? 'selection-validate' : 'selection')
    setTestState('running'); setShowEditor(false)

    let selectionId = null
    try {
      const r = await fetch('/api/selection/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections: testSet.map(s => ({ model: s.model, modalityIdx: s.modalityIdx, override: selectionOverrides[s.key] })) }),
      })
      selectionId = (await r.json()).selectionId
    } catch { setTestState('error'); setErrorMsg('Could not prepare the selection'); return }

    let settled = false
    const es = openSSE(`/api/selection/stream?selectionId=${encodeURIComponent(selectionId)}&mode=${validate ? 'validate' : 'test'}`)
    if (validate) {
      es.addEventListener('start', e => setValExpected(JSON.parse(e.data).count))
      es.addEventListener('result', e => setValResults(prev => [...prev, JSON.parse(e.data)]))
      es.addEventListener('done', () => { settled = true; setTestState('done'); es.close() })
    } else {
      es.addEventListener('progress', e => {
        const { label, message } = JSON.parse(e.data)
        setProgressByLabel(prev => ({ ...prev, [label]: [...(prev[label] || []), message] }))
      })
      es.addEventListener('result', e => setResults(prev => [...prev, JSON.parse(e.data)]))
      es.addEventListener('done', e => { settled = true; setCurrentRun(JSON.parse(e.data)); setTestState('done'); es.close() })
    }
    es.addEventListener('error', e => { settled = true; if (e.data) setErrorMsg(JSON.parse(e.data).message); setTestState('error'); es.close() })
    es.onerror = () => { if (settled) return; setTestState('error'); setErrorMsg('Connection to server lost'); es.close() }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length
  const running = testState === 'running'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
        <span className="text-2xl">🪨</span>
        <div>
          <h1 className="text-lg font-bold text-white leading-none">Pixazo API Tester</h1>
          <p className="text-xs text-slate-500 mt-0.5">Test generative AI model endpoints</p>
        </div>
        {/* Config source switch */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">Source:</span>
          <div className="flex bg-slate-900 border border-slate-700 rounded-lg p-0.5" title="Which config the tester uses to send requests">
            <button onClick={() => changeSource('scraped')} disabled={running}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 ${source === 'scraped' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              Scraped
            </button>
            <button onClick={() => changeSource('spec')} disabled={running}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 ${source === 'spec' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              Spec
            </button>
            <button onClick={() => changeSource('models')} disabled={running}
              title="Model doc files you drop into Backend/Models/ (parsed HTML)"
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 ${source === 'models' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              Models
            </button>
          </div>
          {source === 'models' && (
            <button onClick={rescanModels} disabled={running}
              title="Re-read Backend/Models/ to pick up newly added or edited files"
              className="px-2 py-1 rounded-md text-xs font-semibold border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-40">
              ↻ Rescan
            </button>
          )}
        </div>
        <button
          onClick={() => setBuildSpecsOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white text-sm font-medium transition-colors"
          title="Build config from OpenAPI specs (api_id → endpoints + curl)"
        >
          📦 Build from Specs
        </button>
        <button
          onClick={() => setScrapeOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white text-sm font-medium transition-colors"
          title="Re-scrape pixazo.ai for models & parameters"
        >
          🕷️ Run Scraper
        </button>
      </header>

      <nav className="border-b border-slate-800 px-6 flex">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
          >
            {t}
            {t === 'History' && history.length > 0 && (
              <span className="ml-2 text-xs bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded-full">{history.length}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="px-6 py-6 max-w-6xl mx-auto space-y-6">
        {tab === 'Test' && (
          <>
            {/* Controls */}
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-slate-400">Select Model & Run</h2>
              <ModelSelector
                models={models}
                selected={selected}
                onChange={m => { setSelected(m); setSelectedModality('') }}
                modalities={modalities}
                selectedModality={selectedModality}
                onModalityChange={setSelectedModality}
                onStart={handleStart}
                onTestAll={handleTestAll}
                running={running}
                showEditor={showEditor}
                onToggleEditor={() => setShowEditor(v => !v)}
                hasOverrides={hasOverrides}
                validationMode={validationMode}
                onToggleValidation={() => setValidationMode(v => !v)}
                searchIndex={searchIndex}
              />
              {selected && modalities.length > 0 && selectedModality !== '' && (
                <p className="text-xs text-slate-500">
                  Testing 1 of {modalities.length} modalities ·{' '}
                  <button onClick={() => setSelectedModality('')} className="text-indigo-400 hover:text-indigo-300">switch to all</button>
                </p>
              )}
            </div>

            {/* Request editor panel */}
            {showEditor && modalities.length > 0 && (
              <RequestEditor
                modalities={modalities}
                selectedModality={selectedModality}
                overrides={overrides}
                onChange={handleOverrideChange}
                onClose={() => setShowEditor(false)}
                onReset={resetOverrides}
              />
            )}

            {/* Search modalities of the selected model + add to the test set */}
            {selected && modalities.length > 0 && (
              <ModalitySearchList
                model={selected}
                modalities={modalities}
                isInSet={idx => isInSet(selected, idx)}
                onToggle={mod => toggleInSet(selected, mod)}
                running={running}
              />
            )}

            {/* Cross-model test set (cart) */}
            <TestSetPanel
              items={testSet}
              overrides={selectionOverrides}
              onSetOverride={setItemOverride}
              onRemove={removeFromSet}
              onClear={clearSet}
              onRun={startSelection}
              validationMode={validationMode}
              running={running}
            />

            {/* Error banner */}
            {testState === 'error' && (
              <div className="bg-red-950/50 border border-red-800 rounded-xl p-4 text-sm text-red-300">
                ✗ {errorMsg || 'An error occurred'}
              </div>
            )}

            {/* Single model / test-set results */}
            {(testMode === 'single' || testMode === 'selection') && (
              <>
                {(running || testState === 'done') && (
                  <LiveFeed progressByLabel={progressByLabel} results={results} />
                )}
                {results.length > 0 && (
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                      <span className="text-sm text-slate-300">{passed} passed</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                      <span className="text-sm text-slate-300">{failed} failed</span>
                    </div>
                    {currentRun?.durationMs && (
                      <span className="text-sm text-slate-500 ml-auto">Finished in {(currentRun.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                )}
                {results.length > 0 && (
                  <div>
                    <h2 className="text-sm font-semibold text-slate-400 mb-3">Results</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {results.map((r, i) => <ResultCard key={i} result={r} />)}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Test-all results */}
            {testMode === 'all' && allModels.length > 0 && (
              <AllModelsPanel models={allModels} modelStates={modelStates} />
            )}

            {/* Validation results (no-cost) — single model, all models, or test set */}
            {(testMode === 'validate' || testMode === 'validate-all' || testMode === 'selection-validate') && (
              <ValidationPanel
                results={valResults}
                expected={testMode === 'validate-all' ? null : valExpected}
                running={running}
                grouped={testMode === 'validate-all' || testMode === 'selection-validate'}
                modelsProgress={testMode === 'validate-all' ? valModelsProgress : null}
              />
            )}

            {/* Idle */}
            {testMode === null && (
              <div className="text-center py-16 text-slate-600">
                <p className="text-5xl mb-4">{validationMode ? '🛡️' : '⚡'}</p>
                {validationMode ? (
                  <p className="text-sm">Validation mode is <span className="text-emerald-400">ON</span> — hit <span className="text-slate-400">Validate Model</span> / <span className="text-slate-400">Validate All</span> to health-check endpoints with <span className="text-emerald-400">no credits used</span></p>
                ) : (
                  <p className="text-sm">Pick a model and hit <span className="text-slate-500">Test Model</span>, or hit <span className="text-slate-500">Test All Models</span> to run everything</p>
                )}
              </div>
            )}
          </>
        )}

        {tab === 'History' && (
          <HistoryPanel history={history} onClear={clearHistory} />
        )}
      </main>

      <ScraperModal
        open={scrapeOpen}
        onClose={() => setScrapeOpen(false)}
        onComplete={refreshAfterScrape}
      />

      <ScraperModal
        open={buildSpecsOpen}
        onClose={() => setBuildSpecsOpen(false)}
        onComplete={refreshAfterScrape}
        streamUrl="/api/build-specs/stream"
        icon="📦"
        title="Build from OpenAPI Specs"
        subtitle="Fetches specs by api_id → endpoints, example bodies & curl commands"
        idleText="This reads specs/model-docs*.json, fetches each model's live OpenAPI spec from Pixazo's API Management, and writes pixazo_config.spec.json (endpoints + example bodies + a curl per modality). Switch Source to “Spec” to test against it. Takes ~1–2 minutes."
        startLabel="▶ Build Config"
        runningLabel="Building from specs… (~1–2 min)"
      />
    </div>
  )
}
