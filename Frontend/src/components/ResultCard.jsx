function extractMediaUrl(result) {
  if (!result) return null
  const r = result

  // Primary: output.media_url
  if (r.output?.media_url) return r.output.media_url

  // Direct string fields
  for (const f of ['output', 'url', 'video_url', 'image_url', 'media_url', 'media', 'videoUrl', 'imageUrl']) {
    if (typeof r[f] === 'string' && r[f].startsWith('http')) return r[f]
  }

  // Array output
  if (Array.isArray(r.output)) {
    const first = r.output[0]
    if (typeof first === 'string' && first.startsWith('http')) return first
    if (first?.url) return first.url
  }

  // Nested
  if (r.data?.url) return r.data.url
  if (r.images?.[0]?.url) return r.images[0].url
  if (r.artifacts?.[0]?.url) return r.artifacts[0].url
  if (r.result?.url) return r.result.url
  if (r.generations?.[0]?.url) return r.generations[0].url
  if (r.videos?.[0]?.url) return r.videos[0].url

  return null
}

function isVideo(url) {
  if (!url) return false
  return /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(url) || url.includes('/video')
}

export default function ResultCard({ result }) {
  const mediaUrl = extractMediaUrl(result.result)
  const video = isVideo(mediaUrl)

  return (
    <div className={`rounded-xl border overflow-hidden ${result.success ? 'border-green-800/50 bg-slate-900' : 'border-red-800/50 bg-slate-900'}`}>
      {/* Header */}
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-slate-500 font-mono truncate">{result.subModelName}</p>
          <p className="text-sm font-semibold text-slate-100 mt-0.5">{result.modalityName}</p>
          {result.modelType && (
            <p className="text-xs text-indigo-400 mt-0.5">{result.modelType}</p>
          )}
        </div>
        <span className={`flex-shrink-0 mt-0.5 text-xs px-2.5 py-1 rounded-full font-bold ${result.success ? 'bg-green-900/70 text-green-300' : 'bg-red-900/70 text-red-300'}`}>
          {result.success ? '✓ PASS' : '✗ FAIL'}
        </span>
      </div>

      {/* Media preview */}
      {result.success && mediaUrl && (
        <div className="px-4 pb-3">
          {video ? (
            <video
              src={mediaUrl}
              controls
              className="w-full max-h-56 rounded-lg bg-black object-contain"
            />
          ) : (
            <a href={mediaUrl} target="_blank" rel="noreferrer">
              <img
                src={mediaUrl}
                alt="result"
                className="w-full max-h-56 rounded-lg object-contain bg-slate-800"
                onError={e => { e.target.style.display = 'none' }}
              />
            </a>
          )}
          <a
            href={mediaUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 text-indigo-300 hover:text-indigo-200 transition-colors text-xs font-medium"
          >
            <span>↗ Open in new window</span>
            <span className="text-indigo-500 truncate ml-auto">{mediaUrl}</span>
          </a>
        </div>
      )}

      {/* Success but no media */}
      {result.success && !mediaUrl && result.note && (
        <p className="px-4 pb-3 text-xs text-slate-400">{result.note}</p>
      )}

      {/* Failure */}
      {!result.success && result.error && (
        <div className="px-4 pb-3">
          <p className="text-xs text-red-400 bg-red-950/40 rounded-lg px-3 py-2 font-mono break-all">
            {result.error}
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-800 flex items-center gap-3 flex-wrap">
        {result.elapsedMs && (
          <span className="text-xs text-slate-500">{(result.elapsedMs / 1000).toFixed(1)}s</span>
        )}
        {result.requestId && (
          <span className="text-xs text-slate-600 font-mono truncate">id: {result.requestId}</span>
        )}
        <a
          href={result.endpoint}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-slate-600 hover:text-slate-400 truncate ml-auto"
          title={result.endpoint}
        >
          {result.endpoint?.replace('https://gateway.pixazo.ai/', '')}
        </a>
      </div>
    </div>
  )
}
