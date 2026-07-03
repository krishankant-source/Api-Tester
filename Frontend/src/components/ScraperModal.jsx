import { useState, useRef, useEffect } from 'react'

/**
 * Runs the Pixazo scraper on demand and streams its progress.
 * The scraper NEVER runs automatically — only when the user starts it here.
 */
export default function ScraperModal({
  open, onClose, onComplete,
  streamUrl = '/api/scrape/stream',
  icon = '🕷️',
  title = 'Run Model Scraper',
  subtitle = 'Re-scrapes pixazo.ai for models, endpoints & parameters',
  idleText = 'This launches the scraper to rebuild the model config with the latest models and their tweakable parameters. It visits every model page, so a full run can take several minutes.',
  startLabel = '▶ Start Scrape',
  runningLabel = 'Working… (this can take a few minutes)',
}) {
  const [status, setStatus] = useState('idle') // idle | running | done | error
  const [lines, setLines] = useState([])
  const [msg, setMsg] = useState('')
  const esRef = useRef(null)
  const doneRef = useRef(false)
  const consoleRef = useRef(null)

  // Auto-scroll the console
  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight
  }, [lines])

  // Clean up the stream on unmount
  useEffect(() => () => { if (esRef.current) esRef.current.close() }, [])

  if (!open) return null

  function start() {
    setStatus('running'); setLines([]); setMsg(''); doneRef.current = false
    const es = new EventSource(streamUrl)
    esRef.current = es

    es.addEventListener('start', e => {
      try { setLines(l => [...l, { stream: 'sys', line: JSON.parse(e.data).message }]) } catch { /* noop */ }
    })
    es.addEventListener('log', e => {
      try { setLines(l => [...l, JSON.parse(e.data)]) } catch { /* noop */ }
    })
    es.addEventListener('done', e => {
      doneRef.current = true
      let models
      try { models = JSON.parse(e.data).models } catch { /* noop */ }
      setStatus('done'); setMsg(models != null ? `Done — config updated with ${models} models.` : 'Done — finished successfully.')
      es.close()
      if (onComplete) onComplete()
    })
    es.addEventListener('error', e => {
      doneRef.current = true
      let m = 'Scrape failed.'
      try { if (e.data) m = JSON.parse(e.data).message } catch { /* noop */ }
      setStatus('error'); setMsg(m)
      es.close()
    })
    es.onerror = () => {
      if (doneRef.current) return
      setStatus('error'); setMsg('Connection to server lost.')
      es.close()
    }
  }

  function handleClose() {
    if (esRef.current) esRef.current.close()
    esRef.current = null
    setStatus('idle'); setLines([]); setMsg('')
    onClose()
  }

  const running = status === 'running'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-2xl max-h-[86vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <span className="text-xl">{icon}</span>
            <div>
              <h3 className="text-base font-bold text-white leading-none">{title}</h3>
              <p className="text-xs text-slate-500 mt-1">{subtitle}</p>
            </div>
          </div>
          <button onClick={handleClose} disabled={running}
            className="text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed text-sm">✕</button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto">
          {status === 'idle' && (
            <div className="text-sm text-slate-400 space-y-3">
              <p>{idleText}</p>
            </div>
          )}

          {(running || status === 'done' || status === 'error') && (
            <div ref={consoleRef} className="bg-black border border-slate-800 rounded-lg px-3.5 py-3 font-mono text-xs leading-relaxed text-slate-300 max-h-80 overflow-y-auto whitespace-pre-wrap break-words">
              {lines.length === 0 && <span className="text-slate-600">Starting…</span>}
              {lines.map((l, i) => (
                <div key={i} className={l.stream === 'err' ? 'text-red-400' : l.stream === 'sys' ? 'text-indigo-400' : 'text-slate-300'}>
                  {l.line}
                </div>
              ))}
            </div>
          )}

          {msg && (
            <p className={`mt-3 text-sm ${status === 'error' ? 'text-red-400' : 'text-green-400'}`}>{msg}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-700 flex items-center gap-3">
          {status === 'idle' && (
            <button onClick={start}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors">
              {startLabel}
            </button>
          )}
          {running && (
            <span className="flex items-center gap-2 text-sm text-indigo-400">
              <span className="w-4 h-4 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" />
              {runningLabel}
            </span>
          )}
          {(status === 'done' || status === 'error') && (
            <button onClick={start}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-semibold transition-colors">
              ↻ Run again
            </button>
          )}
          <button onClick={handleClose} disabled={running}
            className="ml-auto px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium transition-colors">
            {status === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
