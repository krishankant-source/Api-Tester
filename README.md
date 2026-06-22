# Pixazo API Tester

A web app to test the [pixazo.ai](https://pixazo.ai) generative-AI model endpoints (image / video / audio / 3D). Pick a model, inspect and tweak its request parameters, fire the request, and watch live status + results. Includes an on-demand scraper that rebuilds the model catalog (endpoints + per-parameter allowed values) from pixazo.ai.

## Structure

```
Backend/          Express + SSE API server (model catalog, test runner, scraper trigger)
  scraper/        Playwright scraper → pixazo_config.json (run on demand only)
Frontend/         React + Vite + Tailwind UI
```

## Setup

### 1. Backend

```bash
cd Backend
npm install
export PIXAZO_KEY=your_pixazo_subscription_key   # see Backend/.env.example
node server.js                                    # → http://localhost:3001
```

The API key is read from the `PIXAZO_KEY` environment variable — it is **not** stored in the repo. Copy `Backend/.env.example` and fill in your key (or export it in your shell).

### 2. Frontend

```bash
cd Frontend
npm install
npm run dev          # → http://localhost:5173 (proxies /api to :3001)
```

### 3. Scraper (optional, on demand)

The scraper never runs automatically. Trigger it from the **Run Scraper** button in the UI, or manually:

```bash
cd Backend/scraper
npm install
npx playwright install chromium
node scrapper.js                       # full catalog → Backend/pixazo_config.json
ONLY_MODELS=nano-banana node scrapper.js   # limit to specific models
```

## Features

- **Model & modality selector** with search across the full catalog
- **Change Parameters** — guided form (dropdowns / toggles / number inputs) built from each model's documented allowed values, or raw JSON editing
- **Live status feed** over Server-Sent Events
- **Results** with inline media preview and the returned `media_url`
- **Test All Models** sequentially
- **History** of previous runs
- **Run Scraper** to refresh the model catalog and parameters on demand
