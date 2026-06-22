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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _data = null;

function load() {
    if (_data) return _data;
    const filePath = path.resolve(__dirname, cfg.configFile);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Config file not found: ${filePath}\nRun the scraper first.`);
    }
    _data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return _data;
}

/**
 * Clears the in-memory cache so the next access re-reads pixazo_config.json
 * from disk. Called after the scraper regenerates the config.
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
            });
        }
    }

    return result;
}