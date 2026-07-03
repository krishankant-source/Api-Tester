/**
 * build_from_specs.cjs
 * ─────────────────────────────────────────────────────────────
 * Spec-driven config builder (alternative to the HTML scraper).
 *
 * 1. Reads model-docs*.json in this folder → every (model, sub-model, feature)
 *    with its api_id + operation_id.
 * 2. For each unique api_id, fetches the live OpenAPI spec from Pixazo's Azure
 *    API Management (anonymous management API → export link → blob).
 * 3. Matches each feature's operation_id to an operation in the spec → pulls the
 *    full endpoint URL (server + path), method, and example request body.
 * 4. Emits:
 *      ../pixazo_config.spec.json   — tester-compatible config (model→subModels→modalities)
 *      ../curls.json                — { "model / submodel / modality": "curl …" }
 *      ../curls.sh                  — runnable bash file of every curl
 *    Each modality record also carries a ready-to-run `curl` string.
 *
 * NOTE: this only BUILDS the requests. It never fires them — running a request
 * (and spending credits) stays in the tester / validation mode.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MGMT ='https://apiresrc.management.azure-api.net/subscriptions/000/resourceGroups/000/providers/Microsoft.ApiManagement/service/apiresrc';
const API_VERSION = '2022-04-01-preview';
const SPECS_DIR = __dirname;
const OUT_CONFIG = path.join(__dirname, '..', 'pixazo_config.spec.json');
const OUT_CURLS = path.join(__dirname, '..', 'curls.json');
const OUT_SH = path.join(__dirname, '..', 'curls.sh');
// Matches the scraped-config convention; the tester swaps this for the real key.
const KEY_PLACEHOLDER = 'process.env.subscription_key';

const log = (...a) => console.log(...a);

function get(url) {
    return new Promise((resolve) => {
        const req = https.get(url, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
    });
}

async function runConc(items, limit, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (queue.length) { const it = queue.shift(); await fn(it); }
    }));
}

async function fetchSpec(apiId) {
    const exp = await get(`${MGMT}/apis/${encodeURIComponent(apiId)}?export=true&format=openapi%2Bjson-link&api-version=${API_VERSION}`);
    if (exp.status !== 200) return { error: `export HTTP ${exp.status || exp.error}` };
    let link;
    try { const j = JSON.parse(exp.body); link = j.link || (j.value && j.value.link); }
    catch { return { error: 'export not JSON' }; }
    if (!link) return { error: 'no export link' };
    const spec = await get(link.replace(/ /g, '%20'));
    if (spec.status !== 200) return { error: `blob HTTP ${spec.status || spec.error}` };
    try { return { spec: JSON.parse(spec.body) }; }
    catch { return { error: 'spec not JSON' }; }
}

function findOp(spec, operationId) {
    for (const p of Object.keys(spec.paths || {})) {
        for (const m of Object.keys(spec.paths[p])) {
            const op = spec.paths[p][m];
            if (op && op.operationId === operationId) return { path: p, method: m.toUpperCase(), op };
        }
    }
    return null;
}

function exampleOf(op) {
    const ct = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
    if (!ct) return null;
    if (ct.example != null) return ct.example;
    if (ct.examples) {
        for (const ex of Object.values(ct.examples)) {
            if (ex && ex.value !== undefined) return ex.value; // only real inline values, not wrapper metadata
        }
    }
    if (ct.schema && ct.schema.example != null) return ct.schema.example;
    return null;
}

// The live specs sometimes inject today's date where an enum value belongs
// (e.g. aspect_ratio: "2026-06-23"). Drop any such date-looking scalar so the
// API falls back to its own default instead of receiving an invalid value.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function sanitizeExample(obj, dropped) {
    if (Array.isArray(obj)) return obj.map(v => sanitizeExample(v, dropped));
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' && DATE_RE.test(v)) { dropped.push(k); continue; }
            out[k] = sanitizeExample(v, dropped);
        }
        return out;
    }
    return obj;
}

// Quote a string as a single bash argument (safe for $, backticks, quotes).
function shSingleQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function detectModelType(name) {
    const t = (name || '').toLowerCase();
    if (/image.?to.?video/.test(t)) return 'image-to-video';
    if (/text.?to.?video/.test(t)) return 'text-to-video';
    if (/video.?to.?video|video editing/.test(t)) return 'video-to-video';
    if (/reference.?to.?video/.test(t)) return 'reference-to-video';
    if (/audio.?to.?video/.test(t)) return 'audio-to-video';
    if (/image.?to.?image/.test(t)) return 'image-to-image';
    if (/text.?to.?image/.test(t)) return 'text-to-image';
    if (/text.?to.?(speech|song|music|audio)/.test(t)) return 'text-to-audio';
    if (/3d/.test(t)) return '3d';
    return undefined;
}

function buildCurl(method, endpoint, body) {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': '$PIXAZO_KEY',
    };
    const lines = [`curl -X ${method} ${JSON.stringify(endpoint)}`];
    // Headers double-quoted so $PIXAZO_KEY expands; body single-quoted so the
    // JSON payload is literal (no $/backtick expansion or injection).
    for (const [k, v] of Object.entries(headers)) lines.push(`  -H ${JSON.stringify(`${k}: ${v}`)}`);
    lines.push(`  -d ${shSingleQuote(JSON.stringify(body ?? {}))}`);
    return lines.join(' \\\n');
}

async function main() {
    const docsFile = fs.readdirSync(SPECS_DIR).find(f => /model-docs/i.test(f) && f.endsWith('.json'));
    if (!docsFile) { console.error('No model-docs*.json found in', SPECS_DIR); process.exit(1); }
    log(`Reading ${docsFile}`);
    const docs = JSON.parse(fs.readFileSync(path.join(SPECS_DIR, docsFile), 'utf8'));

    // Collect every feature → (model, submodel, api_id, operation_id)
    const tasks = [];
    for (const modelKey of Object.keys(docs)) {
        const md = docs[modelKey];
        for (const sm of md.models || []) {
            for (const ft of sm.features || []) {
                if (ft.api_id && ft.operation_id) {
                    tasks.push({ modelKey, subModelName: sm.name, featureName: ft.name, apiId: ft.api_id, operationId: ft.operation_id });
                }
            }
        }
    }
    const apiIds = [...new Set(tasks.map(t => t.apiId))];
    log(`Models: ${Object.keys(docs).length} | features: ${tasks.length} | unique api_ids: ${apiIds.length}`);

    // Fetch all specs (concurrency-limited)
    log('Fetching OpenAPI specs from APIM…');
    const specCache = {};
    let done = 0;
    await runConc(apiIds, 6, async (apiId) => {
        specCache[apiId] = await fetchSpec(apiId);
        done++;
        if (done % 10 === 0) process.stdout.write(`  …${done}/${apiIds.length}\n`);
    });

    const byModel = {};
    const curls = {};
    const shLines = ['#!/usr/bin/env bash', '# Generated from Pixazo OpenAPI specs. Set PIXAZO_KEY first:  export PIXAZO_KEY=your_key', ''];
    const stats = { resolved: 0, withExample: 0, noExample: 0, unresolved: 0, specErrors: 0, duplicates: 0, sanitizedFields: 0, sanitizedModalities: 0 };
    const unresolvedList = [];
    const seen = new Set(); // dedup: modelKey|subModel|feature|operationId

    for (const t of tasks) {
        const dedupKey = `${t.modelKey}|${t.subModelName}|${t.featureName}|${t.operationId}`;
        if (seen.has(dedupKey)) { stats.duplicates++; continue; }
        seen.add(dedupKey);

        const sc = specCache[t.apiId];
        if (!sc || sc.error) { stats.specErrors++; unresolvedList.push(`${t.modelKey}/${t.featureName} (api_id ${t.apiId}: ${sc ? sc.error : 'no spec'})`); continue; }
        const found = findOp(sc.spec, t.operationId);
        if (!found) { stats.unresolved++; unresolvedList.push(`${t.modelKey}/${t.featureName} (op ${t.operationId} not in ${t.apiId})`); continue; }

        const server = (sc.spec.servers && sc.spec.servers[0] && sc.spec.servers[0].url) || '';
        const endpoint = server.replace(/\/$/, '') + found.path;
        let example = exampleOf(found.op);
        let exampleWarning;
        if (example != null) {
            const dropped = [];
            example = sanitizeExample(example, dropped);
            if (dropped.length) {
                stats.sanitizedFields += dropped.length;
                stats.sanitizedModalities++;
                exampleWarning = `dropped corrupted spec value(s): ${[...new Set(dropped)].join(', ')}`;
            }
        }
        stats.resolved++;
        if (example != null) stats.withExample++; else stats.noExample++;

        const rec = {
            name: t.featureName,
            modelType: detectModelType(t.featureName),
            method: found.method,
            endpoint,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Ocp-Apim-Subscription-Key': KEY_PLACEHOLDER },
            exampleRequest: example != null ? example : {},
            hasExample: example != null,
            ...(exampleWarning ? { exampleWarning } : {}),
            apiId: t.apiId,
            operationId: t.operationId,
            curl: buildCurl(found.method, endpoint, example != null ? example : {}),
        };
        if (!byModel[t.modelKey]) byModel[t.modelKey] = {};
        if (!byModel[t.modelKey][t.subModelName]) byModel[t.modelKey][t.subModelName] = [];
        byModel[t.modelKey][t.subModelName].push(rec);

        curls[`${t.modelKey} / ${t.subModelName} / ${t.featureName}`] = rec.curl;
        shLines.push(`# ${t.modelKey} → ${t.subModelName} → ${t.featureName}${rec.hasExample ? '' : '  (NO EXAMPLE BODY in spec)'}`, rec.curl, '');
    }

    const config = Object.keys(byModel).sort().map(modelKey => ({
        name: modelKey,
        subModels: Object.keys(byModel[modelKey]).map(sn => ({ name: sn, modalities: byModel[modelKey][sn] })),
    }));

    fs.writeFileSync(OUT_CONFIG, JSON.stringify(config, null, 2));
    fs.writeFileSync(OUT_CURLS, JSON.stringify(curls, null, 2));
    fs.writeFileSync(OUT_SH, shLines.join('\n'));

    log('\n────────── COVERAGE ──────────');
    log(`resolved endpoints : ${stats.resolved}`);
    log(`  with example body: ${stats.withExample}`);
    log(`  no example body  : ${stats.noExample}`);
    log(`unresolved ops     : ${stats.unresolved}`);
    log(`spec fetch errors  : ${stats.specErrors}`);
    log(`duplicate rows skip: ${stats.duplicates}`);
    log(`sanitized bodies   : ${stats.sanitizedModalities} (dropped ${stats.sanitizedFields} corrupted field-value(s))`);
    log(`models in output   : ${config.length}`);
    log('──────────────────────────────');
    if (unresolvedList.length) {
        log('Unresolved (first 15):');
        unresolvedList.slice(0, 15).forEach(x => log('  - ' + x));
    }
    log(`\nWrote:\n  ${OUT_CONFIG}\n  ${OUT_CURLS}\n  ${OUT_SH}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
