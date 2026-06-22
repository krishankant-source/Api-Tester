import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { listModels, getModalities, reloadConfig } from './configLoader.js';
import { runModel } from './Runner.js';
import { sendRequest, pollUntilDone } from './apiClient.js';
import cfg from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = path.join(__dirname, 'results.json');
const PORT = 3001;

const app = express();
app.use(cors());
app.use(express.json());

// In-memory store for prepared test configs (custom overrides)
const pendingTests = new Map();

function loadHistory() {
    try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); }
    catch { return []; }
}

function saveHistory(runs) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(runs, null, 2));
}

function sseSetup(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    return (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    };
}

// Mirrors Runner.js runWithConcurrency — used when applying custom overrides
async function runWithConcurrencyLocal(items, limit, fn) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (queue.length) {
            const item = queue.shift();
            if (item) await fn(item);
        }
    });
    await Promise.all(workers);
}

// Run a single modality end-to-end (mirrors Runner.js testOneModality)
async function runOneModality(modality, onProgress) {
    const label = `[${modality.subModelName}] ${modality.modalityName}`;
    const base = {
        label,
        subModelName: modality.subModelName,
        modalityName: modality.modalityName,
        modelType: modality.modelType,
        endpoint: modality.endpoint,
    };

    onProgress(label, 'Sending request...');
    let init;
    try { init = await sendRequest(modality); }
    catch (err) { return { ...base, phase: 'request', success: false, error: err.message }; }

    if (!init.ok) {
        return { ...base, phase: 'request', success: false, error: `HTTP ${init.statusCode} — ${JSON.stringify(init.rawBody)}`, rawBody: init.rawBody };
    }

    onProgress(label, `✓ Request accepted (${init.statusCode}) — requestId: ${init.requestId}`);

    if (!init.pollingUrl) {
        return { ...base, phase: 'request', success: true, requestId: init.requestId, status: init.status, result: init.rawBody, note: 'Synchronous response' };
    }

    onProgress(label, `Polling ${init.pollingUrl}`);
    const poll = await pollUntilDone(
        init.pollingUrl, modality.headers,
        (status, elapsed) => onProgress(label, `⏳ status=${status} (${elapsed}s elapsed)`)
    );

    if (poll.timedOut) return { ...base, phase: 'polling', success: false, requestId: init.requestId, pollingUrl: init.pollingUrl, error: `Timed out after ${Math.round(poll.elapsed / 1000)}s` };
    if (poll.networkError) return { ...base, phase: 'polling', success: false, requestId: init.requestId, pollingUrl: init.pollingUrl, error: `Network error: ${poll.networkError}` };

    return {
        ...base, phase: 'completed', success: !poll.failed,
        requestId: init.requestId, pollingUrl: init.pollingUrl,
        status: poll.status, elapsedMs: poll.elapsed, result: poll.result,
        ...(poll.failed ? { error: `API returned failure status: ${poll.status}` } : {}),
    };
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/models', (_req, res) => {
    try { res.json(listModels()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Now includes exampleRequest so the frontend can show it for editing
app.get('/api/models/:model/modalities', (req, res) => {
    try {
        const mods = getModalities(req.params.model);
        res.json(mods.map((m, i) => ({
            index: i,
            label: `[${m.subModelName}] ${m.modalityName}`,
            subModelName: m.subModelName,
            modalityName: m.modalityName,
            modelType: m.modelType,
            method: m.method,
            endpoint: m.endpoint,
            exampleRequest: m.exampleRequest,
            parameters: m.parameters || [],
        })));
    } catch (err) { res.status(404).json({ error: err.message }); }
});

app.get('/api/history', (_req, res) => res.json(loadHistory()));
app.delete('/api/history', (_, res) => { saveHistory([]); res.json({ ok: true }); });

// ── Scraper ───────────────────────────────────────────────────────────────
// The scraper only runs when explicitly triggered here (the "Run Scraper"
// button in the UI). It never runs automatically on server start or tests.
let scrapeRunning = false;

// SSE: run the scraper, streaming its stdout as progress. Reloads the config
// cache on success so new models/parameters are picked up without a restart.
app.get('/api/scrape/stream', (req, res) => {
    const emit = sseSetup(res);

    if (scrapeRunning) {
        emit('error', { message: 'A scrape is already in progress.' });
        return res.end();
    }
    scrapeRunning = true;

    const scriptPath = path.join(__dirname, 'scraper', 'scrapper.js');
    if (!fs.existsSync(scriptPath)) {
        scrapeRunning = false;
        emit('error', { message: `Scraper not found at ${scriptPath}` });
        return res.end();
    }

    // Optionally limit to specific models:  ?only=nano-banana,flux
    const env = { ...process.env };
    if (req.query.only) env.ONLY_MODELS = String(req.query.only);

    emit('start', { message: 'Launching scraper…' });

    const child = spawn('node', [scriptPath], { cwd: __dirname, env });
    let buffer = '';

    const pump = (chunk, stream) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep partial line
        for (const line of lines) {
            const text = line.replace(/\s+$/, '');
            if (text.trim()) emit('log', { stream, line: text });
        }
    };
    child.stdout.on('data', c => pump(c, 'out'));
    child.stderr.on('data', c => pump(c, 'err'));

    child.on('close', code => {
        scrapeRunning = false;
        if (buffer.trim()) emit('log', { stream: 'out', line: buffer.trim() });
        if (code === 0) {
            try {
                const data = reloadConfig();
                emit('done', { code, models: data.length });
            } catch (err) {
                emit('error', { message: `Scrape finished but config reload failed: ${err.message}` });
            }
        } else {
            emit('error', { message: `Scraper exited with code ${code}` });
        }
        res.end();
    });

    child.on('error', err => {
        scrapeRunning = false;
        emit('error', { message: `Failed to start scraper: ${err.message}` });
        res.end();
    });

    // Kill the child if the client disconnects mid-run.
    req.on('close', () => {
        if (!child.killed) child.kill('SIGTERM');
    });
});

// Store custom request overrides and return a short-lived testId
app.post('/api/test/prepare', (req, res) => {
    const { overrides } = req.body; // { [modalityIndex]: customBody }
    const testId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    pendingTests.set(testId, overrides || {});
    setTimeout(() => pendingTests.delete(testId), 10 * 60 * 1000); // auto-expire 10 min
    res.json({ testId });
});

// SSE: test one model — supports ?modalityIdx=N and ?testId=... for custom overrides
app.get('/api/test/:model/stream', async (req, res) => {
    const { model } = req.params;
    const { modalityIdx, testId } = req.query;
    const emit = sseSetup(res);
    const collectedResults = [];
    const startTime = Date.now();

    // Load custom overrides if testId was provided
    const overrides = (testId && pendingTests.get(testId)) || {};
    if (testId) pendingTests.delete(testId);

    const hasOverrides = Object.keys(overrides).length > 0;
    const isSingle = modalityIdx !== undefined;

    try {
        if (hasOverrides || isSingle) {
            // Run modalities directly so we can apply per-modality overrides
            const allMods = getModalities(model);
            const idx = isSingle ? parseInt(modalityIdx, 10) : null;

            if (isSingle && (isNaN(idx) || idx < 0 || idx >= allMods.length)) {
                emit('error', { message: `Invalid modality index ${modalityIdx}` });
                return res.end();
            }

            const toRun = isSingle
                ? [{ mod: allMods[idx], idx }]
                : allMods.map((mod, i) => ({ mod, idx: i }));

            await runWithConcurrencyLocal(toRun, cfg.concurrency, async ({ mod, idx: i }) => {
                const custom = overrides[String(i)];
                const effective = custom ? { ...mod, exampleRequest: custom } : mod;
                const result = await runOneModality(effective, (label, msg) => emit('progress', { label, message: msg }));
                collectedResults.push(result);
                emit('result', result);
            });
        } else {
            // Default: let Runner.js handle it (uses its own concurrency pool)
            await runModel(model, {
                onProgress: (label, message) => emit('progress', { label, message }),
                onResult: (result) => { collectedResults.push(result); emit('result', result); },
            });
        }

        const run = { id: startTime.toString(), model, timestamp: new Date(startTime).toISOString(), durationMs: Date.now() - startTime, results: collectedResults };
        const history = loadHistory();
        history.unshift(run);
        saveHistory(history.slice(0, 100));
        emit('done', run);
    } catch (err) {
        emit('error', { message: err.message });
    }
    res.end();
});

// SSE: test ALL models sequentially
app.get('/api/test-all/stream', async (_, res) => {
    const emit = sseSetup(res);
    const models = listModels();
    const allResults = [];
    const startTime = Date.now();

    emit('models', { models, total: models.length });

    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        emit('model-start', { model, index: i, total: models.length });
        const modelResults = [];

        try {
            await runModel(model, {
                onProgress: (label, message) => emit('progress', { model, label, message }),
                onResult: (result) => {
                    const r = { ...result, model };
                    modelResults.push(r);
                    allResults.push(r);
                    emit('result', { ...r });
                },
            });
        } catch (err) {
            emit('model-error', { model, index: i, error: err.message });
            continue;
        }

        emit('model-done', {
            model, index: i,
            passed: modelResults.filter(r => r.success).length,
            failed: modelResults.filter(r => !r.success).length,
        });
    }

    const run = { id: startTime.toString(), model: '__all__', timestamp: new Date(startTime).toISOString(), durationMs: Date.now() - startTime, results: allResults };
    const history = loadHistory();
    history.unshift(run);
    saveHistory(history.slice(0, 100));
    emit('done', run);
    res.end();
});

app.listen(PORT, () => console.log(`Pixazo API Tester server → http://localhost:${PORT}`));
