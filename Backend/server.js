import 'dotenv/config'; // load .env into process.env before anything reads it
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { listModels, getModalities, reloadConfig, getSource, setSource, listSources, getModelsReport } from './configLoader.js';
import { runModel } from './Runner.js';
import { sendRequest, pollUntilDone } from './apiClient.js';
import { probeModality } from './validator.js';
import cfg from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = path.join(__dirname, 'results.json');
const PORT = 3001;

const app = express();
app.use(cors());
app.use(express.json());

// In-memory store for prepared test configs (custom overrides)
const pendingTests = new Map();
// In-memory store for prepared cross-model selections (a "test set")
const pendingSelections = new Map();

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

// Lightweight search index so the main box can match a model by its name OR by
// any of its modality endpoints / names. Reflects the active config source.
app.get('/api/search-index', (_req, res) => {
    try {
        res.json(listModels().map(name => {
            let mods = [];
            try { mods = getModalities(name); } catch { /* skip broken model */ }
            return {
                name,
                endpoints: mods.map(m => m.endpoint).filter(Boolean),
                modalities: mods.map(m => m.modalityName).filter(Boolean),
            };
        }));
    } catch (err) { res.status(500).json({ error: err.message }); }
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
            curl: m.curl || null,
            hasExample: m.hasExample,
        })));
    } catch (err) { res.status(404).json({ error: err.message }); }
});

// ── Config source (scraped ↔ spec-built ↔ Models/*.html) ─────────────────────
app.get('/api/source', (_req, res) => res.json({ source: getSource(), sources: listSources() }));
app.post('/api/source', (req, res) => {
    try {
        const data = setSource(req.body.source);
        res.json({ ok: true, source: getSource(), models: data.length });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Which Models/*.html files were parsed (and which were skipped) for the
// "models" source — lets the UI confirm dropped files were picked up.
app.get('/api/models-source/report', (_req, res) => res.json(getModelsReport()));

// SSE: build pixazo_config.spec.json from the OpenAPI specs (api_id/operation_id
// in specs/model-docs*.json → live APIM specs → endpoints + example bodies + curls).
let buildSpecsRunning = false;
app.get('/api/build-specs/stream', (req, res) => {
    const emit = sseSetup(res);
    if (buildSpecsRunning) { emit('error', { message: 'A spec build is already running.' }); return res.end(); }
    buildSpecsRunning = true;

    const scriptPath = path.join(__dirname, 'specs', 'build_from_specs.js');
    if (!fs.existsSync(scriptPath)) {
        buildSpecsRunning = false;
        emit('error', { message: `Builder not found at ${scriptPath}` });
        return res.end();
    }

    emit('start', { message: 'Building config from OpenAPI specs…' });
    const child = spawn('node', [scriptPath], { cwd: __dirname });
    let buffer = '';
    const pump = (chunk, stream) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) emit('log', { stream, line: line.replace(/\s+$/, '') });
    };
    child.stdout.on('data', c => pump(c, 'out'));
    child.stderr.on('data', c => pump(c, 'err'));
    child.on('close', code => {
        buildSpecsRunning = false;
        if (buffer.trim()) emit('log', { stream: 'out', line: buffer.trim() });
        if (code === 0) {
            // If the spec source is active, reload it so new data is served.
            try { if (getSource() === 'spec') reloadConfig(); } catch { /* ignore */ }
            emit('done', { code });
        } else {
            emit('error', { message: `Builder exited with code ${code}` });
        }
        res.end();
    });
    child.on('error', err => { buildSpecsRunning = false; emit('error', { message: `Failed to start builder: ${err.message}` }); res.end(); });
    req.on('close', () => { if (!child.killed) child.kill('SIGTERM'); });
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

// ── Validation mode (NO-COST health probes) ─────────────────────────────────
// Sends an empty body to each endpoint and reads only the initial status —
// never polls, so no generation runs. See validator.js for classification.

// SSE: validate one model (all modalities, or ?modalityIdx=N)
app.get('/api/validate/:model/stream', async (req, res) => {
    const emit = sseSetup(res);
    const { modalityIdx } = req.query;
    try {
        const mods = getModalities(req.params.model);
        let list;
        if (modalityIdx !== undefined) {
            const idx = parseInt(modalityIdx, 10);
            if (isNaN(idx) || idx < 0 || idx >= mods.length) {
                emit('error', { message: `Invalid modality index ${modalityIdx}` });
                return res.end();
            }
            list = [{ mod: mods[idx] }];
        } else {
            list = mods.map(mod => ({ mod }));
        }

        emit('start', { count: list.length });
        await runWithConcurrencyLocal(list, cfg.concurrency, async ({ mod }) => {
            const label = `[${mod.subModelName}] ${mod.modalityName}`;
            emit('progress', { label, message: 'Probing (empty body, no poll)…' });
            const r = await probeModality(mod);
            emit('result', {
                label, subModelName: mod.subModelName, modalityName: mod.modalityName,
                modelType: mod.modelType, endpoint: mod.endpoint, ...r,
            });
        });
        emit('done', {});
    } catch (err) {
        emit('error', { message: err.message });
    }
    res.end();
});

// SSE: validate ALL models (modalities probed concurrently per model)
app.get('/api/validate-all/stream', async (_req, res) => {
    const emit = sseSetup(res);
    const models = listModels();
    emit('models', { models, total: models.length });

    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        emit('model-start', { model, index: i, total: models.length });

        let mods;
        try { mods = getModalities(model); }
        catch (err) { emit('model-error', { model, index: i, error: err.message }); continue; }

        const list = mods.map(mod => ({ mod }));
        await runWithConcurrencyLocal(list, cfg.concurrency, async ({ mod }) => {
            const label = `[${mod.subModelName}] ${mod.modalityName}`;
            const r = await probeModality(mod);
            emit('result', {
                model, label, subModelName: mod.subModelName, modalityName: mod.modalityName,
                modelType: mod.modelType, endpoint: mod.endpoint, ...r,
            });
        });
        emit('model-done', { model, index: i });
    }
    emit('done', {});
    res.end();
});

// ── Cross-model selection ("test set") ──────────────────────────────────────
// Test/validate a hand-picked set of modalities from DIFFERENT models together.

// Store a selection [{ model, modalityIdx, override? }] and return a short id.
app.post('/api/selection/prepare', (req, res) => {
    const { selections } = req.body;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    pendingSelections.set(id, Array.isArray(selections) ? selections : []);
    setTimeout(() => pendingSelections.delete(id), 10 * 60 * 1000);
    res.json({ selectionId: id });
});

// SSE: run a prepared selection concurrently. ?mode=test (default) | validate
app.get('/api/selection/stream', async (req, res) => {
    const emit = sseSetup(res);
    const { selectionId, mode } = req.query;
    const validate = mode === 'validate';
    const selections = (selectionId && pendingSelections.get(selectionId)) || [];
    if (selectionId) pendingSelections.delete(selectionId);

    // Resolve each { model, modalityIdx } → the actual modality object.
    const items = [];
    for (const sel of selections) {
        try {
            const mods = getModalities(sel.model);
            const idx = parseInt(sel.modalityIdx, 10);
            if (isNaN(idx) || idx < 0 || idx >= mods.length) continue;
            items.push({ sel, mod: mods[idx] });
        } catch { /* unknown model — skip */ }
    }

    if (!items.length) { emit('error', { message: 'No valid modalities in the selection.' }); return res.end(); }

    const startTime = Date.now();
    const collected = [];
    emit('start', { count: items.length });

    try {
        await runWithConcurrencyLocal(items, cfg.concurrency, async ({ sel, mod }) => {
            const label = `[${sel.model}] ${mod.subModelName} · ${mod.modalityName}`;
            if (validate) {
                const r = await probeModality(mod);
                emit('result', {
                    model: sel.model, label, subModelName: mod.subModelName,
                    modalityName: mod.modalityName, endpoint: mod.endpoint, ...r,
                });
            } else {
                emit('progress', { label, message: 'Sending request...' });
                const effective = sel.override ? { ...mod, exampleRequest: sel.override } : mod;
                // Use our model-prefixed label (ignore runOneModality's internal one) so
                // modalities from different models never collide in the live feed.
                const result = await runOneModality(effective, (_l, m) => emit('progress', { label, message: m }));
                const tagged = { ...result, model: sel.model, label };
                collected.push(tagged);
                emit('result', tagged);
            }
        });

        if (validate) {
            emit('done', {});
        } else {
            const run = { id: startTime.toString(), model: '__selection__', timestamp: new Date(startTime).toISOString(), durationMs: Date.now() - startTime, results: collected };
            const history = loadHistory();
            history.unshift(run);
            saveHistory(history.slice(0, 100));
            emit('done', run);
        }
    } catch (err) {
        emit('error', { message: err.message });
    }
    res.end();
});

app.listen(PORT, () => console.log(`Pixazo API Tester server → http://localhost:${PORT}`));
