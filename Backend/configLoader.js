/**
 * configLoader.js
 * ─────────────────────────────────────────────────────────────
 * Loads pixazo_config.json and provides helpers to look up
 * models and their modalities.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cfg from './config.js';
import { buildModelsConfig } from './modelsLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _data = null;

// Three config sources the tester can run against:
//   scraped → pixazo_config.json        (from the HTML scraper — full example bodies + params)
//   spec    → pixazo_config.spec.json   (built from OpenAPI specs — endpoints + curl, thinner bodies)
//   models  → Backend/Models/*.html     (parsed on the fly from hand-dropped model doc files)
const SOURCES = {
    scraped: cfg.configFile,            // './pixazo_config.json'
    spec: './pixazo_config.spec.json',
    models: './Models',                 // a directory, parsed by modelsLoader (not a single file)
};
let _source = 'scraped';

function load() {
    if (_data) return _data;
    // The "models" source isn't a single JSON file — it's parsed from the HTML
    // doc files in Backend/Models/ at access time (offline, no network).
    if (_source === 'models') {
        _data = buildModelsConfig();
        return _data;
    }
    const filePath = path.resolve(__dirname, SOURCES[_source]);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Config file not found: ${filePath}\n${_source === 'spec' ? 'Run "Build from Specs" first.' : 'Run the scraper first.'}`);
    }
    _data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return _data;
}

/** Which source is active ('scraped' | 'spec' | 'models'). */
export function getSource() { return _source; }

/** All selectable config sources (for the UI's source switch). */
export function listSources() { return Object.keys(SOURCES); }

// Re-exported so the server can report which Models/*.html files were parsed
// (and which were skipped) without importing the loader separately.
export { getModelsReport } from './modelsLoader.js';

/** Switch the active config source and reload from disk (transactional). */
export function setSource(src) {
    if (!SOURCES[src]) throw new Error(`Unknown config source "${src}". Use: ${Object.keys(SOURCES).join(', ')}`);
    const prev = _source;
    _source = src;
    _data = null;
    try {
        return load();
    } catch (e) {
        // Roll back to the last-known-good source so the tester isn't bricked.
        _source = prev;
        _data = null;
        throw e;
    }
}

/**
 * Clears the in-memory cache so the next access re-reads the active config file
 * from disk. Called after the scraper / spec-builder regenerates the config.
 */
export function reloadConfig() {
    _data = null;
    return load();
}

/**
 * Returns a sorted list of all model names.
 */
export function listModels() {
    return load().map(m => m.name).sort();
}

/**
 * Returns the full model object for a given slug.
 * Throws if not found.
 */
export function getModel(slug) {
    const model = load().find(m => m.name === slug);
    if (!model) {
        throw new Error(
            `Model "${slug}" not found.\nAvailable: ${listModels().join(', ')}`
        );
    }
    return model;
}

/**
 * Flattens a model's subModels → modalities into a single array
 * so callers don't have to walk the nested structure.
 *
 * Returns:
 * [{ subModelName, modalityName, modelType, method, endpoint, headers, exampleRequest, parameters }]
 */
export function getModalities(slug) {
    const model = getModel(slug);
    const result = [];

    for (const sub of model.subModels || []) {
        for (const mod of sub.modalities || []) {
            result.push({
                subModelName: sub.name,
                modalityName: mod.name,
                modelType: mod.modelType,
                method: mod.method,
                endpoint: mod.endpoint,
                headers: mod.headers || {},
                exampleRequest: mod.exampleRequest || {},
                parameters: mod.parameters || [],
                curl: mod.curl || null,
                hasExample: mod.hasExample,
            });
        }
    }

    return result;
}