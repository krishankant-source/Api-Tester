/**
 * validator.js
 * ─────────────────────────────────────────────────────────────
 * "Validation mode" — a NO-COST health probe for an endpoint.
 *
 * It sends a deliberately-empty request body and reads ONLY the initial
 * HTTP status. It NEVER polls for a result, so no generation job is ever
 * waited on. Because almost every modality has at least one required field,
 * an empty body is rejected at the validation layer (HTTP 400/422) before
 * any billable work happens.
 *
 * Status → classification:
 *   400 / 422 / other 4xx  → 'healthy'      reachable, key valid, request validated (FREE)
 *   401 / 403              → 'auth'         reachable, but subscription key rejected
 *   404                    → 'notfound'     endpoint path wrong
 *   429                    → 'ratelimited'  reachable + auth OK, just throttled
 *   5xx                    → 'server'       gateway/backend error
 *   2xx                    → 'accepted'     ⚠️ endpoint accepted an empty request — a job
 *                                           MAY have been queued. We do NOT poll it. Flagged
 *                                           so the user knows it wasn't validated for free.
 *   no response            → 'unreachable'  network error / timeout
 */

import https from 'https';
import http from 'http';
import cfg from './config.js';

// Replace the subscription-key header (or any `process.env.*` placeholder) with
// the real key from config — same rule apiClient uses.
function injectAuth(headers = {}) {
    const out = { ...headers };
    for (const [k, v] of Object.entries(out)) {
        if (k.toLowerCase() === 'ocp-apim-subscription-key'
            || (typeof v === 'string' && v.startsWith('process.env.'))) {
            out[k] = cfg.subscriptionKey;
        }
    }
    return out;
}

function classify(statusCode) {
    if (typeof statusCode !== 'number') return 'unreachable';
    if (statusCode >= 200 && statusCode < 300) return 'accepted';
    if (statusCode >= 300 && statusCode < 400) return 'healthy'; // redirect = reachable, no generation
    if (statusCode === 401 || statusCode === 403) return 'auth';
    if (statusCode === 404) return 'notfound';
    if (statusCode === 429) return 'ratelimited';
    if (statusCode >= 500) return 'server';
    if (statusCode >= 400) return 'healthy'; // 400/422/405/415/… = reached & rejected, no generation
    return 'unknown';
}

function snippet(raw, max = 200) {
    if (!raw) return '';
    let text = raw;
    try {
        const j = JSON.parse(raw);
        text = j.message || j.error || j.detail || JSON.stringify(j);
    } catch { /* keep raw */ }
    text = String(text).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Probe a single modality with an empty body. Resolves (never rejects) with:
 *   { statusCode, classification, reachable, detail }
 *
 * NOTE: this intentionally sends `{}` and never reads any polling URL — so it
 * does not generate media and does not consume wallet credits (for the 400 case).
 */
export function probeModality(modality, { timeoutMs = 15000 } = {}) {
    return new Promise(resolve => {
        let settled = false;
        const done = (val) => { if (!settled) { settled = true; resolve(val); } };

        let url;
        try { url = new URL(modality.endpoint); }
        catch { return done({ statusCode: null, classification: 'unreachable', reachable: false, detail: `Bad endpoint URL: ${modality.endpoint}` }); }

        const lib = url.protocol === 'https:' ? https : http;
        const bodyStr = '{}'; // empty body — triggers required-field validation, no generation
        const headers = {
            ...injectAuth(modality.headers),
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
        };

        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: modality.method || 'POST',
            headers,
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => done({
                statusCode: res.statusCode,
                classification: classify(res.statusCode),
                reachable: true,
                detail: snippet(raw),
            }));
            res.on('error', err => done({
                statusCode: res.statusCode ?? null,
                classification: res.statusCode ? classify(res.statusCode) : 'unreachable',
                reachable: !!res.statusCode,
                detail: err.message,
            }));
        });

        req.on('error', err => done({ statusCode: null, classification: 'unreachable', reachable: false, detail: err.message }));
        req.setTimeout(timeoutMs, () => { req.destroy(); done({ statusCode: null, classification: 'unreachable', reachable: false, detail: `No response (timeout after ${timeoutMs / 1000}s)` }); });
        req.write(bodyStr);
        req.end();
    });
}
