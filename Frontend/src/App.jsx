import { useState, useEffect, useRef } from 'react'
import ModelSelector from './components/ModelSelector.jsx'
import LiveFeed from './components/LiveFeed.jsx'
import ResultCard from './components/ResultCard.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import AllModelsPanel from './components/AllModelsPanel.jsx'
import RequestEditor from './components/RequestEditor.jsx'
import ScraperModal from './components/ScraperModal.jsx'
import ValidationPanel from './components/ValidationPanel.jsx'

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

  // Validation mode (no-cost health probing)
  const [validationMode, setValidationMode] = useState(false)
  const [valResults, setValResults] = useState([])
  const [valExpected, setValExpected] = useState(null)
  const [valModelsProgress, setValModelsProgress] = useState(null) // { done, total } for validate-all

  const esRef = useRef(null)

  // ── Loaders ──────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
  }, [])

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
        <button
          onClick={() => setScrapeOpen(true)}
          className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white text-sm font-medium transition-colors"
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

            {/* Error banner */}
            {testState === 'error' && (
              <div className="bg-red-950/50 border border-red-800 rounded-xl p-4 text-sm text-red-300">
                ✗ {errorMsg || 'An error occurred'}
              </div>
            )}

            {/* Single model results */}
            {testMode === 'single' && (
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

            {/* Validation results (no-cost) */}
            {(testMode === 'validate' || testMode === 'validate-all') && (
              <ValidationPanel
                results={valResults}
                expected={testMode === 'validate' ? valExpected : null}
                running={running}
                grouped={testMode === 'validate-all'}
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
    </div>
  )
}
