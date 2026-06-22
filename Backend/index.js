/**
 * index.js
 * ─────────────────────────────────────────────────────────────
 * Main entry point for the Pixazo API Model Tester.
 * Usage:
 *   node index.js <model-slug>
 * Example:
 *   node index.js happy-horse
 */

import readline from 'readline';
import { listModels, getModalities } from './configLoader.js';
import { runModel } from './Runner.js';

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

async function main() {
    const args = process.argv.slice(2);
    const models = listModels();

    if (models.length === 0) {
        console.error('No models found in the configuration file.');
        process.exit(1);
    }

    let modelSlug = args[0];

    if (!modelSlug) {
        console.log('\n=== Pixazo API Model Tester ===');
        console.log('Available models:');
        models.forEach((m, idx) => {
            console.log(`  ${idx + 1}. ${m}`);
        });
        console.log('');

        const answer = await askQuestion('Select a model number or type a model name: ');
        const num = parseInt(answer, 10);
        if (!isNaN(num) && num >= 1 && num <= models.length) {
            modelSlug = models[num - 1];
        } else if (models.includes(answer)) {
            modelSlug = answer;
        } else {
            console.error(`Invalid selection: "${answer}". Exiting.`);
            process.exit(1);
        }
    }

    if (!models.includes(modelSlug)) {
        console.error(`Error: Model "${modelSlug}" not found.`);
        console.error(`Available models: ${models.join(', ')}`);
        process.exit(1);
    }

    console.log(`\nStarting tests for model: ${modelSlug}...`);
    try {
        const modalities = getModalities(modelSlug);
        console.log(`Found ${modalities.length} modality/modalities to test.`);

        const startTime = Date.now();
        const results = await runModel(modelSlug, {
            onProgress: (label, message) => {
                console.log(`${label}: ${message}`);
            },
            onResult: (res) => {
                console.log(`\n[RESULT] ${res.label} -> ${res.success ? 'SUCCESS' : 'FAILED'}`);
                if (!res.success) {
                    console.log(`  Error: ${res.error}`);
                } else if (res.result && res.result.output && res.result.output.media_url) {
                    console.log(`  Media URL: ${res.result.output.media_url}`);
                }
                console.log('');
            }
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('=============================================');
        console.log(`Finished testing ${modelSlug} in ${duration}s`);
        console.log('Summary of results:');
        results.forEach(res => {
            const statusStr = res.success ? '✓ SUCCESS' : '✗ FAILED';
            let mediaInfo = '';
            if (res.success && res.result && res.result.output && res.result.output.media_url) {
                mediaInfo = ` (Media URL: ${res.result.output.media_url})`;
            }
            console.log(`  - ${res.label}: ${statusStr} (Phase: ${res.phase})${mediaInfo}`);
        });
        console.log('=============================================');
    } catch (err) {
        console.error(`An error occurred running the model: ${err.message}`);
    }
}

main();
