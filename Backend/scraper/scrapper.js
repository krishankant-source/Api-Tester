/**
 * Pixazo.ai Model Scraper  v5.0
 * ============================================================================
 * Model discovery: scrapes pixazo.ai/models/mcp (lists ALL 100+ models).
 *   /models only shows ~33 featured models; /models/mcp has the full list.
 *
 * For every modality the scraper now captures TWO things:
 *   1. The HTTP example block  -> method, endpoint, headers, exampleRequest
 *   2. The "Request Parameters" table -> a structured `parameters` array that
 *      lists every tweakable field with its type, allowed values / range and
 *      default. This powers the frontend "Change Parameters" UI (dropdowns,
 *      toggles, number inputs, etc).
 *
 * DOM facts (confirmed from live inspection):
 *   - Each modality lives in a <section class="sectionn" id="doc-..."> with a
 *     .section-heading and a .tab-content.active .copy-wrap (the HTTP example).
 *   - Each modality ALSO has a sibling params section whose heading reads
 *     "Request Parameters - {ModalityName}" and contains a <table> with columns:
 *       Parameter | Required | Type | Default | Allowed values / range | Description
 *   - The params tables appear in the SAME document order as the modality
 *     sections, so we associate them greedily in order (with a name-prefix check).
 *
 * Output hierarchy:  model -> subModels[] -> modalities[]
 *   Each modality: { name, modelType, method, endpoint, headers, exampleRequest, parameters[] }
 *   Each parameter: { name, type, required, control, options?, min?, max?, default, description, inExample }
 *
 * Image/video URLs in the example body are replaced with fixed sample URLs.
 * NOTE: this scraper only runs when invoked manually (npm start or the
 *       "Run Scraper" button in the tester app). It never runs automatically.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- Constants -------------------------------------------------------------
const BASE_URL = 'https://pixazo.ai';
// Write outputs into the Backend folder (one level up from /scraper) so the
// tester app picks them up regardless of the process cwd.
// Output paths default to the Backend folder, overridable via env (used to
// scrape into a temp file then swap, so a long run never serves a partial config).
const OUTPUT_FILE = process.env.OUTPUT ? path.resolve(process.env.OUTPUT) : path.join(__dirname, '..', 'pixazo_config.json');
const NAMES_FILE = process.env.NAMES ? path.resolve(process.env.NAMES) : path.join(__dirname, '..', 'model_names.json');
const REQ_DELAY_MS = 2000;
const NAV_TIMEOUT = 30_000;

const SAMPLE_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/Sky_over_Munich_02.jpg/330px-Sky_over_Munich_02.jpg';
const SAMPLE_VIDEO_URL = 'https://pub-582b7213209642b9b995c96c95a30381.r2.dev/v1/ltx-2-3-quality-audio-to-video_019eb1b4-fe7a-7b92-5ad3-700e54c7b857b/output.mp4';

// Optional: limit to a comma-separated list of model slugs (for quick tests)
//   ONLY_MODELS=nano-banana,flux node scrapper.js
const ONLY_MODELS = (process.env.ONLY_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);

// --- Helpers ---------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = {
  info: (...a) => console.log('[i]', ...a),
  ok: (...a) => console.log('[ok]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
  err: (...a) => console.error('[err]', ...a),
  step: label => console.log(`\n${'='.repeat(60)}\n  ${label}\n${'='.repeat(60)}`),
};

// --- Model type detection (from modality heading text) ---------------------
function detectModelType(headingText) {
  const t = headingText.toLowerCase();
  if (/first.?last.?frame|first.*last.*frame/.test(t)) return 'image-to-video';
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
  if (/video/.test(t)) return 'text-to-video';
  return 'text-to-image';
}

// --- Replace sample media URLs in parsed body ------------------------------
function replaceSampleUrls(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => replaceSampleUrls(item));

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'url' && typeof val === 'string') {
      if (/\.(mp4|webm|mov|avi)(\?|$)/i.test(val) || /video/i.test(val)) {
        result[key] = SAMPLE_VIDEO_URL;
      } else {
        result[key] = SAMPLE_IMAGE_URL;
      }
    } else if (key === 'image_url' && typeof val === 'object' && val && val.url) {
      result[key] = { ...val, url: SAMPLE_IMAGE_URL };
    } else if (typeof val === 'object') {
      result[key] = replaceSampleUrls(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// --- Parse the raw HTTP copy-wrap text -------------------------------------
function parseHttpBlock(rawText) {
  const text = rawText.trim();
  const lines = text.split('\n');

  let method = null;
  let endpoint = null;
  const headers = {};
  let bodyStart = -1;

  const HEADER_NAMES = new Set([
    'Content-Type', 'Cache-Control', 'Ocp-Apim-Subscription-Key',
    'Authorization', 'Accept', 'X-API-Key',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const httpMatch = line.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+)/i);
    if (httpMatch && !method) {
      method = httpMatch[1].toUpperCase();
      endpoint = httpMatch[2];
      continue;
    }

    const headerMatch = line.match(/^([A-Za-z][A-Za-z0-9\-]+):\s*(.+)$/);
    if (headerMatch && HEADER_NAMES.has(headerMatch[1])) {
      let val = headerMatch[2].trim();
      if (headerMatch[1] === 'Ocp-Apim-Subscription-Key') {
        val = 'process.env.subscription_key';
      }
      headers[headerMatch[1]] = val;
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
        exampleRequest = bodyText;
      }
    }
  }

  return { method, endpoint, headers, exampleRequest };
}

// --- Parameter table parsing -----------------------------------------------
/** Coerce a raw string value to the column's declared type. */
function coerceByType(v, type) {
  const t = (type || '').toLowerCase();
  if (t.includes('int')) { const n = parseInt(v, 10); return Number.isNaN(n) ? v : n; }
  if (t.includes('number') || t.includes('float') || t.includes('double')) { const n = Number(v); return Number.isNaN(n) ? v : n; }
  if (t.includes('bool')) return /^true$/i.test(v);
  return v;
}

/**
 * Turn the "Allowed values / range" cell + declared type into a control spec.
 * Returns { control, options?, min?, max? }.
 *   control: 'enum' | 'boolean' | 'number' | 'text'
 */
function parseAllowed(cell, type) {
  const raw = (cell || '').trim();
  const t = (type || '').toLowerCase();

  if (t.includes('bool')) return { control: 'boolean', options: [true, false] };

  // Quoted enum values:  "auto", "16:9", "1:1"
  const quoted = [...raw.matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(s => s.length);
  if (quoted.length >= 2) return { control: 'enum', options: quoted.map(v => coerceByType(v, t)) };

  // Backtick enum fallback:  `jpeg`, `png`, `webp`
  const ticked = [...raw.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(s => s.length);
  if (ticked.length >= 2) return { control: 'enum', options: ticked.map(v => coerceByType(v, t)) };

  // Numeric type -> look for a range like "1-10", "1–10", "0.0 - 1.0"
  if (t.includes('int') || t.includes('number') || t.includes('float') || t.includes('double')) {
    const m = raw.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*[–\-—]\s*(-?\d+(?:\.\d+)?)/);
    if (m) return { control: 'number', min: Number(m[1]), max: Number(m[2]) };
    return { control: 'number' };
  }

  // A single quoted value is still a (one-option) enum
  if (quoted.length === 1) return { control: 'enum', options: [coerceByType(quoted[0], t)] };

  return { control: 'text' };
}

/** Resolve the default value: prefer the actual exampleRequest value. */
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

/** Build the `parameters` array from a param table's column map + rows. */
function buildParameters(cols, rows, exampleRequest) {
  if (!rows || !rows.length) return [];

  // Map columns by fuzzy header name -> index
  const findCol = (...needles) =>
    cols.findIndex(c => needles.some(n => c.toLowerCase().includes(n)));
  const iName = findCol('parameter', 'field', 'name');
  const iReq = findCol('required');
  const iType = findCol('type');
  const iDefault = findCol('default');
  const iAllowed = findCol('allowed', 'range', 'values', 'options');
  const iDesc = findCol('description', 'desc');

  const params = [];
  for (const row of rows) {
    // Safe cell access — some rows have fewer <td> than header columns.
    const cell = i => (i >= 0 && row[i] != null ? String(row[i]) : '');
    const name = (iName >= 0 ? cell(iName) : (row[0] != null ? String(row[0]) : '')).replace(/`/g, '').trim();
    if (!name) continue;
    const type = cell(iType).trim();
    const requiredCell = cell(iReq).trim();
    const defaultCell = cell(iDefault).trim();
    const allowedCell = cell(iAllowed).trim();
    const description = cell(iDesc).trim();

    const spec = parseAllowed(allowedCell, type);
    const def = resolveDefault(name, defaultCell, type, exampleRequest);
    const inExample = !!(exampleRequest && typeof exampleRequest === 'object' && !Array.isArray(exampleRequest)
      && Object.prototype.hasOwnProperty.call(exampleRequest, name));

    params.push({
      name,
      type: type || 'string',
      required: /yes/i.test(requiredCell),
      control: spec.control,
      ...(spec.options ? { options: spec.options } : {}),
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(def !== undefined ? { default: def } : {}),
      description,
      inExample,
    });
  }
  return params;
}

// Normalize a heading for prefix comparison
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// --- subModel name from heading --------------------------------------------
function subModelNameFromHeading(headingText) {
  const dashMatch = headingText.match(/-\s*(.+?)\s*API\s*$/i);
  if (dashMatch) return dashMatch[1].trim();
  return headingText;
}

// --- Step 1: Scrape model slugs from /models/mcp ---------------------------
async function scrapeModelNames(page) {
  log.step('Step 1 - Fetching full model list from /models/mcp');

  const SLUG_BLACKLIST = new Set(['mcp', 'leaderboard', 'undefined', 'models']);

  await page.goto(`${BASE_URL}/models/mcp`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await sleep(2500);

  const slugs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/models\/([a-zA-Z0-9][a-zA-Z0-9_\-.]+?)\/?$/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
  });

  let unique = [...new Set(slugs)].filter(s => !SLUG_BLACKLIST.has(s));
  if (ONLY_MODELS.length) unique = unique.filter(s => ONLY_MODELS.includes(s));

  log.ok(`Found ${unique.length} model slug(s)${ONLY_MODELS.length ? ' (filtered by ONLY_MODELS)' : ''}`);
  return unique;
}

// --- Step 2: Scrape a single model page ------------------------------------
async function scrapeModelPage(page, slug) {
  const pageUrl = `${BASE_URL}/models/${slug}`;
  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await sleep(1500);

    const scraped = await page.evaluate(() => {
      // (a) modality HTTP sections (in document order)
      const modalities = [];
      document.querySelectorAll('.sectionn').forEach(sec => {
        const headingEl = sec.querySelector('.section-heading');
        if (!headingEl) return;
        const copyWrapEl = sec.querySelector('.tab-content.active .copy-wrap');
        if (!copyWrapEl) return;
        const rawText = (copyWrapEl.innerText || copyWrapEl.textContent || '').trim();
        if (!/^(GET|POST|PUT|PATCH|DELETE)\s+https?:\/\//m.test(rawText)) return;
        modalities.push({
          sectionId: sec.id || '',
          headingText: headingEl.innerText.trim(),
          httpText: rawText,
        });
      });

      // (b) parameter tables (in document order)
      const isParamTable = (t) => {
        const ths = Array.from(t.querySelectorAll('thead th')).map(x => x.innerText.trim().toLowerCase());
        return ths.some(h => h.includes('parameter') || h.includes('field'))
          && ths.some(h => h.includes('allowed') || h.includes('type') || h.includes('range'));
      };
      const headingAbove = (el) => {
        let node = el;
        while (node) {
          let sib = node.previousElementSibling;
          while (sib) {
            if (/^H[1-4]$/.test(sib.tagName) || (sib.classList && sib.classList.contains('section-heading'))) return sib.innerText.trim();
            const inner = sib.querySelector && sib.querySelector('h1,h2,h3,h4,.section-heading');
            if (inner) return inner.innerText.trim();
            sib = sib.previousElementSibling;
          }
          node = node.parentElement;
        }
        return '';
      };
      const paramTables = Array.from(document.querySelectorAll('table')).filter(isParamTable).map(t => ({
        heading: headingAbove(t),
        cols: Array.from(t.querySelectorAll('thead th')).map(x => x.innerText.trim()),
        rows: Array.from(t.querySelectorAll('tbody tr')).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())),
      }));

      return { modalities, paramTables };
    });

    if (scraped.modalities.length === 0) throw new Error('No modality sections found on page');

    // Associate param tables to modalities greedily, in document order, by name-prefix.
    const tables = scraped.paramTables.map(pt => ({
      ...pt,
      modalityName: (pt.heading || '').replace(/^request parameters\s*[-–—:]\s*/i, '').trim(),
    }));
    const usedTable = new Array(tables.length).fill(false);
    const tableForModality = (heading) => {
      const h = norm(heading);
      // prefer a prefix / containment match
      let idx = tables.findIndex((pt, i) => !usedTable[i] && pt.modalityName && (h.startsWith(norm(pt.modalityName)) || norm(pt.modalityName).startsWith(h) || h.includes(norm(pt.modalityName))));
      if (idx === -1) idx = tables.findIndex((_, i) => !usedTable[i]); // fallback: next unused, in order
      if (idx === -1) return null;
      usedTable[idx] = true;
      return tables[idx];
    };

    // Group modalities into subModels (by submodel name from heading)
    const subModelMap = new Map();
    for (const raw of scraped.modalities) {
      const { method, endpoint, headers, exampleRequest } = parseHttpBlock(raw.httpText);
      if (!endpoint) continue;

      const matched = tableForModality(raw.headingText);
      const parameters = matched ? buildParameters(matched.cols, matched.rows, exampleRequest) : [];

      const modelType = detectModelType(raw.headingText);
      const subModelName = subModelNameFromHeading(raw.headingText);

      if (!subModelMap.has(subModelName)) subModelMap.set(subModelName, []);
      subModelMap.get(subModelName).push({
        name: raw.headingText,
        modelType,
        method: method || 'POST',
        endpoint,
        headers,
        exampleRequest,
        parameters,
      });
    }

    const subModels = [...subModelMap.entries()].map(([name, modalities]) => ({ name, modalities }));
    return { name: slug, subModels };
  } catch (err) {
    log.err(`  Failed ${slug}: ${err.message}`);
    return { name: slug, error: err.message };
  }
}

// --- Main ------------------------------------------------------------------
async function main() {
  console.log('\n==============================================');
  console.log('     Pixazo.ai Model Scraper  v5.0');
  console.log('  Discovery via /models/mcp + parameter tables');
  console.log('==============================================\n');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    const modelNames = await scrapeModelNames(page);
    if (!modelNames.length) { log.warn('No models found.'); return; }

    log.ok(`Scraping ${modelNames.length} model(s)`);
    fs.writeFileSync(NAMES_FILE, JSON.stringify(modelNames, null, 2));

    log.step('Step 2 - Scraping model pages (+ parameter tables)');
    const modelConfigs = [];

    for (let i = 0; i < modelNames.length; i++) {
      const slug = modelNames[i];
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${modelNames.length}] ${slug.padEnd(36)}`);

      const cfg = await scrapeModelPage(page, slug);
      modelConfigs.push(cfg);

      if (cfg.error) {
        console.log(`ERROR - ${cfg.error}`);
      } else {
        const subCount = cfg.subModels?.length ?? 0;
        const modCount = cfg.subModels?.reduce((s, m) => s + m.modalities.length, 0) ?? 0;
        const paramCount = cfg.subModels?.reduce((s, m) => s + m.modalities.reduce((p, mod) => p + (mod.parameters?.length || 0), 0), 0) ?? 0;
        console.log(`ok - ${subCount} submodel(s), ${modCount} modalities, ${paramCount} params`);
      }

      // Write incrementally so a long run is recoverable / partially usable.
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(modelConfigs, null, 2));

      if (i < modelNames.length - 1) await sleep(REQ_DELAY_MS);
    }

    log.ok(`Config saved -> ${OUTPUT_FILE}`);
    log.ok(`Names saved  -> ${NAMES_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  log.err('Fatal:', err);
  process.exit(1);
});
