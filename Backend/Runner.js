/**
 * runner.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrates parallel testing of all modalities for one model.
 *
 * For each modality:
 *   1. Send the initial request
 *   2. Extract polling URL from response
 *   3. Poll until complete/error/timeout
 *   4. Emit result events as they arrive (don't wait for all to finish)
 *
 * Uses a concurrency limit (cfg.concurrency) so we don't hammer
 * the API with too many simultaneous requests.
 *
 * Exports a single function:
 *   runModel(modelSlug, { onResult, onProgress }) → Promise<summary>
 */

import { getModalities } from './configLoader.js';
import { sendRequest, pollUntilDone } from './apiClient.js';
import cfg from './config.js';

/**
 * Tests all modalities of a model in parallel (with concurrency limit).
 *``
 * Callbacks:
 *   onProgress(modalityLabel, message)  — called during polling for live updates
 *   onResult(result)                    — called as soon as each modality finishes
 *
 * Returns a summary array once all modalities are done.
 */
async function runModel(modelSlug, { onProgress = () => { }, onResult = () => { } } = {}) {
    const modalities = getModalities(modelSlug);

    if (!modalities.length) {
        throw new Error(`No modalities found for model "${modelSlug}"`);
    }

    const results = [];

    // Run with concurrency limit using a pool pattern
    await runWithConcurrency(modalities, cfg.concurrency, async (modality) => {
        const label = `[${modality.subModelName}] ${modality.modalityName}`;
        const result = await testOneModality(modality, label, onProgress);
        results.push(result);
        onResult(result);
    });

    return results;
}

// ─── Test a single modality end-to-end ───────────────────────────────────────
async function testOneModality(modality, label, onProgress) {
    const base = {
        label,
        subModelName: modality.subModelName,
        modalityName: modality.modalityName,
        modelType: modality.modelType,
        endpoint: modality.endpoint,
    };

    // Step 1: fire the initial request
    onProgress(label, 'Sending request...');
    const init = await sendRequest(modality);

    if (!init.ok) {
        return {
            ...base,
            phase: 'request',
            success: false,
            error: `HTTP ${init.statusCode} — ${init.error || JSON.stringify(init.rawBody)}`,
            rawBody: init.rawBody,
        };
    }

    onProgress(label, `✓ Request accepted (${init.statusCode}) — requestId: ${init.requestId}`);

    // Step 2: poll
    if (!init.pollingUrl) {
        // No polling URL in response — maybe it completed synchronously
        return {
            ...base,
            phase: 'request',
            success: true,
            requestId: init.requestId,
            status: init.status,
            result: init.rawBody,
            note: 'No polling URL returned — may be synchronous response',
        };
    }

    onProgress(label, `Polling ${init.pollingUrl}`);

    const poll = await pollUntilDone(
        init.pollingUrl,
        modality.headers,
        (status, elapsedSec) => onProgress(label, `⏳ status=${status} (${elapsedSec}s elapsed)`)
    );

    if (poll.timedOut) {
        return {
            ...base,
            phase: 'polling',
            success: false,
            requestId: init.requestId,
            pollingUrl: init.pollingUrl,
            error: `Timed out after ${Math.round(poll.elapsed / 1000)}s`,
        };
    }

    if (poll.networkError) {
        return {
            ...base,
            phase: 'polling',
            success: false,
            requestId: init.requestId,
            pollingUrl: init.pollingUrl,
            error: `Network error during polling: ${poll.networkError}`,
        };
    }

    return {
        ...base,
        phase: 'completed',
        success: !poll.failed,
        requestId: init.requestId,
        pollingUrl: init.pollingUrl,
        status: poll.status,
        elapsedMs: poll.elapsed,
        result: poll.result,
        ...(poll.failed ? { error: `API returned failure status: ${poll.status}` } : {}),
    };
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────
/**
 * Runs asyncFn on each item in items[], at most `limit` at a time.
 * Results arrive as they complete (no ordering guarantee).
 */
async function runWithConcurrency(items, limit, asyncFn) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (queue.length) {
            const item = queue.shift();
            if (item) await asyncFn(item);
        }
    });
    await Promise.all(workers);
}

export { runModel };