/**
 * config.js
 * ─────────────────────────────────────────────────────────────
 * Central config — edit these values before running the tester.
 * The subscription key can also be set via environment variable:
 *   PIXAZO_KEY=your_key node index.js
 */

const config = {
    // Your Pixazo API subscription key — provide it via the PIXAZO_KEY environment
    // variable, set in Backend/.env (PIXAZO_KEY=your_key) or exported in your shell.
    // Never commit a real key to source control.
    subscriptionKey: process.env.PIXAZO_KEY || '',

    // Path to the scraped config file
    configFile: './pixazo_config.json',

    polling: {
        intervalMs: 4000,   // how often to poll (ms)
        timeoutMs: 300000, // max wait per modality before giving up (5 min)
        // Status field values that mean "done"
        completedStatuses: ['completed', 'succeeded', 'success', 'done'],
        failedStatuses: ['failed', 'error', 'cancelled'],
    },

    // How many modalities to run in parallel per model test
    concurrency: 5,
};

export default config;