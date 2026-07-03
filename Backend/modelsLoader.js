/**
 * modelsLoader.js
 * ─────────────────────────────────────────────────────────────
 * Third config source for the tester: build the model/sub-model/modality
 * config by parsing the HTML doc files dropped into Backend/Models/.
 *
 * Each file is the static HTML of a Pixazo model doc page (the same markup the
 * live scraper consumes). Unlike the scraper (which drives a real browser) and
 * the spec builder (which hits APIM over the network), this loader works on
 * local files only — no Playwright, no network — so it's instant and offline.
 *
 * It produces the exact same shape the runner/validator already expect:
 *   [{ name, subModels: [{ name, modalities: [
 *        { name, modelType, method, endpoint, headers, exampleRequest, parameters, hasExample }
 *   ] }] }]
 *
 * The DOM-shaped extraction (sections, HTTP code blocks, parameter tables) is
 * done with small, dependency-free regex helpers; the field-level parsing
 * (HTTP block → method/endpoint/headers/body, param table → parameters) mirrors
 * the scraper's pure helpers so both sources yield identical records.
 *
 * Files are named "<apiId>__<operation>.html". The Model → Sub-model → Modality
 * tree is grouped from the apiId: the Model (family) is the leading base words
 * (e.g. "Nano Banana"), the Sub-model is the full variant (e.g. "Nano Banana 2",
 * "Nano Banana Pro"), and each file's parsed sections become that sub-model's
 * modalities (deduped by name+endpoint). Drop more files and switch the tester's
 * Source to "Models" — everything regroups automatically.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, 'Models');

// Mirror the scraper: swap example media URLs for known-good samples so an
// image/video model's example body still points at something real when tested.
const SAMPLE_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/Sky_over_Munich_02.jpg/330px-Sky_over_Munich_02.jpg';
const SAMPLE_VIDEO_URL = 'https://pub-582b7213209642b9b995c96c95a30381.r2.dev/v1/ltx-2-3-quality-audio-to-video_019eb1b4-fe7a-7b92-5ad3-700e54c7b857b/output.mp4';

// The placeholder the tester swaps for the real key at request time (apiClient.injectAuth).
const KEY_PLACEHOLDER = 'process.env.subscription_key';

// Last load report — surfaced via the API so the UI can show which files were
// picked up and which failed to parse.
let _report = { dir: MODELS_DIR, files: [], errors: [] };
export function getModelsReport() { return _report; }

// ─── HTML text helpers (dependency-free) ─────────────────────────────────────

function decodeEntities(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
        .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
        .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'); // ampersand last so it never re-decodes
}
function safeCodePoint(n) { try { return String.fromCodePoint(n); } catch { return ''; } }

function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }

/** innerText-equivalent for an inline cell: tags stripped, entities decoded, whitespace collapsed. */
function cellText(html) { return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim(); }

/** innerText-equivalent for a <pre><code> block: preserve newlines (JSON / headers need them). */
function codeText(html) { return decodeEntities(stripTags(html)).replace(/\r\n?/g, '\n'); }

/** Some doc HTTP blocks render "https: //host" (space after the colon). Repair it. */
function normalizeUrls(s) {
    return s.replace(/\bhttps\s*:\s*\/\//gi, 'https://').replace(/\bhttp\s*:\s*\/\//gi, 'http://');
}

// ─── HTML structure extraction ───────────────────────────────────────────────

/** Every <pre><code>…</code></pre> block with its position in the document. */
function extractCodeBlocks(html) {
    const blocks = [];
    const re = /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        blocks.push({ index: m.index, text: normalizeUrls(codeText(m[1])) });
    }
    return blocks;
}

/** Each modality section is anchored by an <h2 class="section-heading">…</h2>. */
function extractSectionHeadings(html) {
    const heads = [];
    const re = /<h2[^>]*class="[^"]*\bsection-heading\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        heads.push({ index: m.index, text: cellText(m[1]) });
    }
    return heads;
}

/** The shared async polling endpoint (/v2/requests/status[/…]) — never a real model operation. */
const STATUS_EP_RE = /\/requests?\/status(?=$|[/?])/i;

/**
 * The doc's Base URL: the first code-block line that is a standalone full URL,
 * optionally prefixed by an HTTP verb (the "Base URL" section sometimes writes
 * "POST https://…"). Status-polling URLs are ignored.
 */
function extractBaseUrl(blocks) {
    for (const b of blocks) {
        const m = b.text.match(/^\s*(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?(https?:\/\/\S+)\s*$/im);
        if (m && !STATUS_EP_RE.test(m[1])) return m[1];
    }
    return null;
}

/**
 * A code block describing a real request → { method, endpoint }, else null.
 * Handles the full-URL form ("POST https://…/v1/x") and the relative form
 * ("POST /x HTTP/1.1", whose true endpoint is the doc's Base URL). The shared
 * /requests/status/ polling endpoint is rejected so it's never treated as a modality.
 */
function requestEndpointFromBlock(text, baseUrl) {
    const full = text.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+)/im);
    if (full) return STATUS_EP_RE.test(full[2]) ? null : { method: full[1].toUpperCase(), endpoint: full[2] };
    const rel = text.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+\/\S*\s+HTTP/im);
    if (rel && baseUrl && !STATUS_EP_RE.test(baseUrl)) return { method: rel[1].toUpperCase(), endpoint: baseUrl };
    return null;
}

/**
 * Pair each section-heading with the first real request block that follows it
 * (before the next heading). Doc-only sections like "Examples" — whose only HTTP
 * block is the status-polling endpoint — yield no modality and are dropped.
 */
function extractModalities(html) {
    const heads = extractSectionHeadings(html);
    const blocks = extractCodeBlocks(html);
    const baseUrl = extractBaseUrl(blocks);
    const mods = [];
    for (let i = 0; i < heads.length; i++) {
        const start = heads[i].index;
        const end = i + 1 < heads.length ? heads[i + 1].index : Infinity;
        for (const b of blocks) {
            if (b.index <= start || b.index >= end) continue;
            const info = requestEndpointFromBlock(b.text, baseUrl);
            if (!info) continue;
            mods.push({ headingText: heads[i].text, httpText: b.text, method: info.method, endpoint: info.endpoint });
            break;
        }
    }
    return mods;
}

/** Nearest preceding <h1..h4> heading text before a position (table caption). */
function headingBefore(html, idx) {
    const before = html.slice(0, idx);
    const matches = [...before.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)];
    return matches.length ? cellText(matches[matches.length - 1][1]) : '';
}

/** Every "Request Parameters"-style table: { heading, cols[], rows[][] }. */
function extractParamTables(html) {
    const tables = [];
    const tableRe = /<table[\s\S]*?<\/table>/gi;
    let m;
    while ((m = tableRe.exec(html)) !== null) {
        const tableHtml = m[0];
        const cols = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(x => cellText(x[1]));
        const looksLikeParams = cols.some(c => /parameter|field/i.test(c))
            && cols.some(c => /allowed|type|range|values|options/i.test(c));
        if (!looksLikeParams) continue;

        const tbody = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
        const rowsHtml = tbody ? tbody[1] : tableHtml;
        const rows = [...rowsHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
            .map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(td => cellText(td[1])))
            .filter(cells => cells.length > 0);

        tables.push({ heading: headingBefore(html, m.index), cols, rows });
    }
    return tables;
}

// ─── Field-level parsing (mirrors scraper/scrapper.js pure helpers) ───────────

function replaceSampleUrls(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(replaceSampleUrls);
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        if (key === 'url' && typeof val === 'string') {
            out[key] = (/\.(mp4|webm|mov|avi)(\?|$)/i.test(val) || /video/i.test(val)) ? SAMPLE_VIDEO_URL : SAMPLE_IMAGE_URL;
        } else if (key === 'image_url' && val && typeof val === 'object' && val.url) {
            out[key] = { ...val, url: SAMPLE_IMAGE_URL };
        } else if (val && typeof val === 'object') {
            out[key] = replaceSampleUrls(val);
        } else {
            out[key] = val;
        }
    }
    return out;
}

const HEADER_NAMES = new Set([
    'Content-Type', 'Cache-Control', 'Ocp-Apim-Subscription-Key',
    'Authorization', 'Accept', 'X-API-Key',
]);

/** Parse the HTTP request block text → { method, endpoint, headers, exampleRequest }. */
function parseHttpBlock(rawText, baseUrl) {
    const info = requestEndpointFromBlock(rawText, baseUrl);
    const method = info ? info.method : null;
    const endpoint = info ? info.endpoint : null;
    const lines = rawText.trim().split('\n');
    let bodyStart = -1;
    const headers = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        const headerMatch = line.match(/^([A-Za-z][A-Za-z0-9\-]+):\s*(.+)$/);
        if (headerMatch && HEADER_NAMES.has(headerMatch[1])) {
            headers[headerMatch[1]] = headerMatch[1] === 'Ocp-Apim-Subscription-Key'
                ? KEY_PLACEHOLDER : headerMatch[2].trim();
            continue;
        }

        if (line.startsWith('{') || line.startsWith('[')) { bodyStart = i; break; }
    }

    let exampleRequest = null;
    if (bodyStart !== -1) {
        const bodyText = lines.slice(bodyStart).join('\n').trim();
        try {
            exampleRequest = replaceSampleUrls(JSON.parse(bodyText));
        } catch {
            try {
                const cleaned = bodyText
                    .replace(/\/\/.*$/gm, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/,(\s*[}\]])/g, '$1');
                exampleRequest = replaceSampleUrls(JSON.parse(cleaned));
            } catch {
                exampleRequest = bodyText; // keep the raw text if it isn't valid JSON
            }
        }
    }

    return { method, endpoint, headers, exampleRequest };
}

function coerceByType(v, type) {
    const t = (type || '').toLowerCase();
    if (t.includes('int')) { const n = parseInt(v, 10); return Number.isNaN(n) ? v : n; }
    if (t.includes('number') || t.includes('float') || t.includes('double')) { const n = Number(v); return Number.isNaN(n) ? v : n; }
    if (t.includes('bool')) return /^true$/i.test(v);
    return v;
}

function parseAllowed(cell, type) {
    const raw = (cell || '').trim();
    const t = (type || '').toLowerCase();
    if (t.includes('bool')) return { control: 'boolean', options: [true, false] };

    const quoted = [...raw.matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(s => s.length);
    if (quoted.length >= 2) return { control: 'enum', options: quoted.map(v => coerceByType(v, t)) };

    const ticked = [...raw.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(s => s.length);
    if (ticked.length >= 2) return { control: 'enum', options: ticked.map(v => coerceByType(v, t)) };

    if (t.includes('int') || t.includes('number') || t.includes('float') || t.includes('double')) {
        const m = raw.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*[–\-—]\s*(-?\d+(?:\.\d+)?)/);
        if (m) return { control: 'number', min: Number(m[1]), max: Number(m[2]) };
        return { control: 'number' };
    }

    if (quoted.length === 1) return { control: 'enum', options: [coerceByType(quoted[0], t)] };
    return { control: 'text' };
}

function resolveDefault(name, tableDefault, type, exampleRequest) {
    if (exampleRequest && typeof exampleRequest === 'object' && !Array.isArray(exampleRequest)
        && Object.prototype.hasOwnProperty.call(exampleRequest, name)) {
        return exampleRequest[name];
    }
    const d = (tableDefault || '').trim();
    if (!d || d === '—' || d === '-' || d === '--') return undefined;
    const q = d.match(/^"(.*)"$/);
    if (q) return coerceByType(q[1], type);
    if (/^(true|false)$/i.test(d)) return /^true$/i.test(d);
    if (/^-?\d+(\.\d+)?$/.test(d)) return Number(d);
    return d;
}

function buildParameters(cols, rows, exampleRequest) {
    if (!rows || !rows.length) return [];
    const findCol = (...needles) => cols.findIndex(c => needles.some(n => c.toLowerCase().includes(n)));
    const iName = findCol('parameter', 'field', 'name');
    const iReq = findCol('required');
    const iType = findCol('type');
    const iDefault = findCol('default');
    const iAllowed = findCol('allowed', 'range', 'values', 'options');
    const iDesc = findCol('description', 'desc');

    const params = [];
    for (const row of rows) {
        const cell = i => (i >= 0 && row[i] != null ? String(row[i]) : '');
        const name = (iName >= 0 ? cell(iName) : (row[0] != null ? String(row[0]) : '')).replace(/`/g, '').trim();
        if (!name) continue;
        const type = cell(iType).trim();
        const spec = parseAllowed(cell(iAllowed).trim(), type);
        const def = resolveDefault(name, cell(iDefault).trim(), type, exampleRequest);
        const inExample = !!(exampleRequest && typeof exampleRequest === 'object' && !Array.isArray(exampleRequest)
            && Object.prototype.hasOwnProperty.call(exampleRequest, name));

        params.push({
            name,
            type: type || 'string',
            required: /yes/i.test(cell(iReq).trim()),
            control: spec.control,
            ...(spec.options ? { options: spec.options } : {}),
            ...(spec.min !== undefined ? { min: spec.min } : {}),
            ...(spec.max !== undefined ? { max: spec.max } : {}),
            ...(def !== undefined ? { default: def } : {}),
            description: cell(iDesc).trim(),
            inExample,
        });
    }
    return params;
}

function detectModelType(headingText) {
    const t = (headingText || '').toLowerCase();
    if (/first.?last.?frame/.test(t)) return 'image-to-video';
    if (/image.?to.?video|img.?to.?vid|\bi2v\b/.test(t)) return 'image-to-video';
    if (/image.?to.?image|img.?to.?img|\bi2i\b/.test(t)) return 'image-to-image';
    if (/reference.?to.?video|\br2v\b/.test(t)) return 'reference-to-video';
    if (/edit.?video|video.?edit|\bv2v\b/.test(t)) return 'video-to-video';
    if (/video.?to.?video/.test(t)) return 'video-to-video';
    if (/video.?to.?image/.test(t)) return 'video-to-image';
    if (/audio.?to.?video|\ba2v\b/.test(t)) return 'audio-to-video';
    if (/text.?to.?video|\bt2v\b/.test(t)) return 'text-to-video';
    if (/text.?to.?image|\bt2i\b/.test(t)) return 'text-to-image';
    if (/frame.?to.?video/.test(t)) return 'image-to-video';
    if (/text.?to.?(speech|song|music|audio)/.test(t)) return 'text-to-audio';
    if (/3d/.test(t)) return '3d';
    if (/video/.test(t)) return 'text-to-video';
    return 'text-to-image';
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function subModelNameFromHeading(headingText) {
    const dashMatch = headingText.match(/-\s*(.+?)\s*API\s*$/i);
    return dashMatch ? dashMatch[1].trim() : headingText;
}

/** Derive the model slug from the API path (…/<slug>/v1/…), else the filename. */
function slugFromEndpoint(endpoint, fallback) {
    try {
        const seg = new URL(endpoint).pathname.split('/').filter(Boolean);
        if (seg.length) return seg[0];
    } catch { /* fall through */ }
    return fallback;
}

function fileSlug(filename) {
    return path.basename(filename).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Family / sub-model grouping (apiId → Model → Sub-model) ──────────────────

// Plumbing words that are never part of a model or sub-model name.
const NOISE_TOKENS = new Set(['api', 'async', 'request', 'requests', 'edit', 'generate', 'generation', 'create', 'gen', 'clone', 'polling']);
// Tokens that mark a *variant* (a sub-model), so the family name stops before them.
const VARIANT_TOKENS = new Set([
    'pro', 'standard', 'turbo', 'lightning', 'xl', 'sdxl', 'large', 'base', 'mini',
    'fast', 'flash', 'lite', 'ultra', 'max', 'small', 'medium', 'plus', 'schnell',
    'distilled', 'quality', 'preview', 'beta',
]);
const ACRONYMS = new Set(['xl', 'sdxl', 'hd', 'ai', '4k', '2d', '3d', 'ip', 'sd']);
// Media/modality words: the family name stops here (they describe an operation, not the brand).
const MEDIA_TOKENS = new Set([
    'image', 'images', 'img', 'video', 'videos', 'audio', 'speech', 'music', 'voice',
    'song', 'sound', 'text', 'vision', 'motion', 'avatar', 'lipsync', '3d',
]);

const isNumberTok = t => /^\d+$/.test(t);
// version/generation/param-size tokens: v2, o3, 7b/80b/1m … and plain numbers.
const isVersionStop = t => isNumberTok(t) || /^v\d+$/.test(t) || /^o\d+$/.test(t) || /^\d+[bmk]$/i.test(t) || VARIANT_TOKENS.has(t);

function apiIdTokens(apiId) {
    return String(apiId).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function prettyToken(t) {
    if (ACRONYMS.has(t)) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Join consecutive short number tokens into a dotted version ("3","5" → "3.5"); drop long internal ids ("923"). */
function compactTokens(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (isNumberTok(t)) {
            if (t.length >= 3) continue; // internal id, not a version
            const nums = [t];
            while (i + 1 < tokens.length && isNumberTok(tokens[i + 1]) && tokens[i + 1].length < 3) nums.push(tokens[++i]);
            out.push(nums.join('.'));
        } else {
            out.push(t);
        }
    }
    return out;
}

function titleCase(tokens) {
    return compactTokens(tokens).map(prettyToken).join(' ');
}

/** Model (family) = leading base words up to the first version/variant/media/noise token. */
function familyName(apiId) {
    const toks = apiIdTokens(apiId);
    const base = [];
    for (const t of toks) {
        if (isVersionStop(t) || NOISE_TOKENS.has(t) || MEDIA_TOKENS.has(t)) break;
        base.push(t);
    }
    return titleCase(base.length ? base : toks) || apiId;
}

/** Sub-model = every meaningful token (base + variant + version), noise words removed. */
function subModelName(apiId) {
    const toks = apiIdTokens(apiId).filter(t => !NOISE_TOKENS.has(t));
    return titleCase(toks) || familyName(apiId);
}

/** apiId for a Models/ file: the part before "__", else the whole filename slug. */
function apiIdFromFilename(filename) {
    const base = path.basename(filename).replace(/\.[^.]+$/, '');
    const idx = base.indexOf('__');
    return idx >= 0 ? base.slice(0, idx) : base;
}

// ─── Junk-entry filters (placeholders, internal ids, legacy hosts) ─────────────

// Real models live on the Pixazo gateway; other hosts are legacy/dead endpoints.
const GATEWAY_HOST = 'gateway.pixazo.ai';
function isGatewayEndpoint(url) {
    try { return new URL(url).host === GATEWAY_HOST; } catch { return false; }
}

// apiIds that are placeholders, not real catalog models.
const EXCLUDED_APIIDS = new Set(['ai-model-api', 'ai-model']);
function isExcludedApiId(apiId) {
    return EXCLUDED_APIIDS.has(String(apiId).toLowerCase());
}

// A Mongo ObjectId-style filename is an internal id, not a real apiId — the real
// model name is recovered from the endpoint path instead of excluding the file.
const isObjectId = (apiId) => /^[0-9a-f]{24,}$/i.test(String(apiId));

// ─── Per-file → model object ──────────────────────────────────────────────────

/** Parse one model doc HTML string into a tester model object. Throws on no usable content. */
export function parseModelHtml(html, filename = 'model.html') {
    const rawMods = extractModalities(html);
    if (!rawMods.length) throw new Error('no modality sections found (need <h2 class="section-heading"> + an HTTP request block)');

    const tables = extractParamTables(html).map(pt => ({
        ...pt,
        modalityName: (pt.heading || '').replace(/^request parameters\s*[-–—:]\s*/i, '').trim(),
    }));
    const usedTable = new Array(tables.length).fill(false);
    const tableForModality = (heading) => {
        const h = norm(heading);
        let idx = tables.findIndex((pt, i) => !usedTable[i] && pt.modalityName
            && (h.startsWith(norm(pt.modalityName)) || norm(pt.modalityName).startsWith(h) || h.includes(norm(pt.modalityName))));
        if (idx === -1) idx = tables.findIndex((_, i) => !usedTable[i]);
        if (idx === -1) return null;
        usedTable[idx] = true;
        return tables[idx];
    };

    const subModelMap = new Map();
    let slug = null;
    for (const raw of rawMods) {
        const { method, endpoint, headers, exampleRequest } = parseHttpBlock(raw.httpText, raw.endpoint);
        if (!endpoint) continue;
        if (!slug) slug = slugFromEndpoint(endpoint, fileSlug(filename));

        const matched = tableForModality(raw.headingText);
        const parameters = matched ? buildParameters(matched.cols, matched.rows, exampleRequest) : [];
        const subModelName = subModelNameFromHeading(raw.headingText);
        const hasExample = !!(exampleRequest && typeof exampleRequest === 'object'
            && !Array.isArray(exampleRequest) && Object.keys(exampleRequest).length > 0);

        if (!subModelMap.has(subModelName)) subModelMap.set(subModelName, []);
        subModelMap.get(subModelName).push({
            name: raw.headingText,
            modelType: detectModelType(raw.headingText),
            method: method || 'POST',
            endpoint,
            headers,
            exampleRequest: exampleRequest ?? {},
            parameters,
            hasExample,
        });
    }

    if (!slug) throw new Error('no valid endpoint found in any modality');
    const subModels = [...subModelMap.entries()].map(([name, modalities]) => ({ name, modalities }));
    return { name: slug, subModels };
}

// ─── Directory → config array ─────────────────────────────────────────────────

/**
 * Read every model doc file in Backend/Models/ and build the tester config.
 * Files that fail to parse are skipped and recorded in the load report so the
 * UI can surface them — one bad file never breaks the whole source.
 */
export function buildModelsConfig() {
    _report = { dir: MODELS_DIR, files: [], errors: [] };
    if (!fs.existsSync(MODELS_DIR)) return [];

    const files = fs.readdirSync(MODELS_DIR)
        .filter(f => !f.startsWith('.') && /\.(json|html?|txt)$/i.test(f))
        .sort();

    // family name → { name, subs: Map(subName → { name, modalities, seen }) }
    const families = new Map();

    for (const f of files) {
        const full = path.join(MODELS_DIR, f);
        try {
            if (!fs.statSync(full).isFile()) continue;
            const html = fs.readFileSync(full, 'utf8');
            if (!html.trim()) { _report.errors.push({ file: f, error: 'file is empty' }); continue; }

            let apiId = apiIdFromFilename(f);
            if (isExcludedApiId(apiId)) continue; // placeholder apiId — not a real model

            const parsed = parseModelHtml(html, f);
            const allMods = parsed.subModels.flatMap(sm => sm.modalities);
            if (!allMods.length) { _report.errors.push({ file: f, error: 'no modalities parsed' }); continue; }

            const mods = allMods.filter(m => isGatewayEndpoint(m.endpoint));
            if (!mods.length) continue; // off-gateway / legacy host only — excluded

            // Files named with an internal ObjectId: recover the real apiId from the endpoint path.
            if (isObjectId(apiId)) apiId = slugFromEndpoint(mods[0].endpoint, apiId);

            const famName = familyName(apiId);
            const subName = subModelName(apiId);

            if (!families.has(famName)) families.set(famName, { name: famName, subs: new Map() });
            const fam = families.get(famName);
            if (!fam.subs.has(subName)) fam.subs.set(subName, { name: subName, modalities: [], seen: new Set() });
            const sub = fam.subs.get(subName);

            let added = 0;
            for (const m of mods) {
                const key = `${m.name}\u0000${m.endpoint}`;
                if (sub.seen.has(key)) continue; // dedup across files/operations
                sub.seen.add(key);
                sub.modalities.push(m);
                added++;
            }
            _report.files.push({ file: f, model: famName, subModel: subName, modalities: added });
        } catch (err) {
            _report.errors.push({ file: f, error: err.message });
        }
    }

    if (_report.errors.length) {
        for (const e of _report.errors) console.warn(`[models] skipped ${e.file}: ${e.error}`);
    }

    // Collapse fragmented families: when a shorter family name is a leading-word
    // prefix of another (e.g. "Kling" vs "Kling Video"), fold the longer into the
    // shortest root so every variant lives under one Model.
    const famNames = [...families.keys()];
    const rootOf = (name) => {
        let root = name;
        for (const cand of famNames) {
            if (cand !== name && name.startsWith(cand + ' ') && cand.split(' ').length < root.split(' ').length) {
                root = cand;
            }
        }
        return root;
    };
    const merged = new Map();
    for (const [name, fam] of families) {
        const root = rootOf(name);
        if (!merged.has(root)) merged.set(root, { name: root, subs: new Map() });
        const tgt = merged.get(root);
        for (const [subName, sub] of fam.subs) {
            if (!tgt.subs.has(subName)) { tgt.subs.set(subName, sub); continue; }
            const ex = tgt.subs.get(subName);
            for (const m of sub.modalities) {
                const key = `${m.name}\u0000${m.endpoint}`;
                if (ex.seen.has(key)) continue;
                ex.seen.add(key);
                ex.modalities.push(m);
            }
        }
    }

    return [...merged.values()]
        .map(fam => ({
            name: fam.name,
            subModels: [...fam.subs.values()]
                .map(s => ({ name: s.name, modalities: s.modalities }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
