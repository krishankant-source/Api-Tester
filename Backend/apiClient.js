/**
 * apiClient.js
 * ─────────────────────────────────────────────────────────────
 * Handles two things:
 *   1. sendRequest()  — fires the initial generation POST
 *   2. pollUntilDone() — polls the returned URL until complete/error/timeout
 *
 * Both functions are pure async — no logging, no process.exit.
 * All status reporting is done by the caller (runner.js).
 */

import https from 'https';
import http from 'http';
import cfg from './config.js';

// ─── Low-level HTTP helper ────────────────────────────────────────────────────
/**
 * Makes an HTTP/HTTPS request. Returns { statusCode, body (parsed JSON) }.
 * Throws on network error or non-2xx response.
 */
function request(method, url, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const bodyStr = body ? JSON.stringify(body) : null;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                ...headers,
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
            },
        };

        const req = lib.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(raw); }
                catch { parsed = { _raw: raw }; }

                resolve({ statusCode: res.statusCode, body: parsed });
            });
        });

        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// ─── Inject real API key into headers ────────────────────────────────────────
/**
 * Replaces the placeholder subscription key with the real one from config.
 */
function injectAuth(headers) {
    const out = { ...headers };
    for (const [k, v] of Object.entries(out)) {
        if (
            k.toLowerCase() === 'ocp-apim-subscription-key' ||
            (typeof v === 'string' && v.startsWith('process.env.'))
        ) {
            out[k] = cfg.subscriptionKey;
        }
    }
    return out;
}

// ─── Send initial generation request ─────────────────────────────────────────
/**
 * Sends the initial POST to the generation endpoint.
 *
 * Returns:
 * {
 *   ok         : boolean,
 *   statusCode : number,
 *   requestId  : string | null,
 *   pollingUrl : string | null,
 *   status     : string | null,
 *   rawBody    : object,       // full response for debugging
 * }
 */
async function sendRequest(modality) {
    const { method, endpoint, headers, exampleRequest } = modality;
    const authedHeaders = injectAuth(headers);

    let res;
    try {
        res = await request(method, endpoint, authedHeaders, exampleRequest);
    } catch (err) {
        return { ok: false, error: err.message, rawBody: null };
    }

    const body = res.body;

    // Extract the key fields — field names vary by API, try common ones
    const requestId = body.request_id || body.requestId || body.id || null;
    const pollingUrl = body.polling_url || body.status_url || body.poll_url
        || body.statusUrl || body.pollUrl || null;
    const status = body.status || body.state || null;

    return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        statusCode: res.statusCode,
        requestId,
        pollingUrl,
        status,
        rawBody: body,
    };
}

// ─── Poll until done ──────────────────────────────────────────────────────────
/**
 * Polls pollingUrl every cfg.polling.intervalMs until:
 *   - status is in completedStatuses → resolves with { done: true, result }
 *   - status is in failedStatuses    → resolves with { done: true, failed: true, result }
 *   - timeout is reached             → resolves with { done: false, timedOut: true }
 *
 * onTick(status, elapsed) is called on each poll so the caller can log progress.
 */
async function pollUntilDone(pollingUrl, authHeaders, onTick = () => { }) {
    const authedHeaders = injectAuth(authHeaders);
    const { intervalMs, timeoutMs, completedStatuses, failedStatuses } = cfg.polling;

    const start = Date.now();

    while (true) {
        const elapsed = Date.now() - start;

        if (elapsed >= timeoutMs) {
            return { done: false, timedOut: true, elapsed };
        }

        await sleep(intervalMs);

        let res;
        try {
            res = await request('GET', pollingUrl, authedHeaders);
        } catch (err) {
            return { done: false, networkError: err.message, elapsed };
        }

        const body = res.body;
        const status = (body.status || body.state || '').toLowerCase();
        const elapsedSec = Math.round((Date.now() - start) / 1000);

        onTick(status, elapsedSec);

        if (completedStatuses.map(s => s.toLowerCase()).includes(status)) {
            return { done: true, failed: false, status, result: body, elapsed: Date.now() - start };
        }
        if (failedStatuses.map(s => s.toLowerCase()).includes(status)) {
            return { done: true, failed: true, status, result: body, elapsed: Date.now() - start };
        }
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export { sendRequest, pollUntilDone };