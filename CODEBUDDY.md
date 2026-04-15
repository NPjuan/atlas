# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

**MECE 知识聚合思维导图** — an Obsidian plugin that scans a Vault's `.md` files, uses AI to extract knowledge points, classifies them into a three-level MECE hierarchy (主题→类别→观点类型), and renders the result as an interactive radial mind map with drill-down to source files.

## Commands

The project has not been initialized yet. Before any other commands, scaffold the project:

```bash
npm init -y
npm install --save-dev obsidian @types/node typescript esbuild builtin-modules
npm install --save d3
npm install --save-dev @types/d3
```

Once `package.json` and `esbuild.config.mjs` exist, the standard Obsidian plugin scripts are:

```bash
npm run dev       # watch mode — incremental build to main.js
npm run build     # production build (minified)
```

To test the plugin, copy the build output to the Obsidian vault's plugin directory:

```bash
cp main.js manifest.json styles.css ~/.obsidian/plugins/obsidian-mece-knowledge/
```

Then enable the plugin in Obsidian → Settings → Community plugins.

There is no automated test suite; validation is manual (see PLAN.md §九).

## Architecture

### Plugin entry points

| File | Role |
|------|------|
| `src/main.ts` | `Plugin` subclass — registers the view, ribbon icon, command palette commands, and settings tab in `onload()` |
| `src/settings.ts` | `PluginSettingTab` subclass — AI provider selector, API key input, scan-scope config, and test-connection button |
| `src/views/MindMapView.ts` | `ItemView` subclass — hosts the D3.js radial tree as an Obsidian tab |

### Core processing pipeline (`src/core/`)

```
scanner.ts  →  extractor.ts  →  categorizer.ts  →  store.ts
(hash diff)    (chunked AI)      (MECE tree)       (JSON r/w)
```

- **scanner.ts** — reads all `.md` files from the Vault, computes content hashes, returns only new/changed files (incremental).
- **extractor.ts** — splits files into ~2000-char chunks (200-char overlap) via `src/ai/chunker.ts`, calls the AI provider per chunk, collects `KnowledgePoint` objects.
- **categorizer.ts** — sends all knowledge points + the existing category tree to AI; AI extends the tree incrementally and returns updated assignments.
- **store.ts** — reads/writes `knowledge-store.json` via Obsidian's `loadData()`/`saveData()`.

### AI abstraction layer (`src/ai/`)

All four providers implement a single `AIProvider` interface (defined in `src/ai/types.ts`). `src/ai/factory.ts` instantiates the correct provider from the user's settings. No AI SDK packages are used — all four providers call their REST APIs directly with the global `fetch()`.

| Provider | Endpoint |
|----------|----------|
| Claude | `https://api.anthropic.com/v1/messages` |
| OpenAI | `https://api.openai.com/v1/chat/completions` (JSON mode) |
| Ollama | `http://localhost:11434/v1/chat/completions` (OpenAI兼容格式, 本地, 免费) |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` (OpenAI兼容格式) |

### Data model

```typescript
KnowledgeStore              // root of knowledge-store.json
├── documents               // filePath → { hash, processedAt } (for incremental detection)
├── knowledgePoints[]       // KnowledgePoint (content, sourceFile, sourceQuote, sourcePosition, categoryIds)
└── categoryTree            // CategoryNode tree (recursive, level: 'theme'|'category'|'viewpoint')
```

### UI (`src/ui/`)

- **mindmap.ts** — D3.js `d3.tree()` radial layout rendered as SVG; supports zoom/pan and click-to-expand per level.
- **detail-panel.ts** — shown on leaf-node click; displays knowledge point summary, original quote, and a link that opens the source note in Obsidian.
- **progress-modal.ts** — progress dialog shown during scan/extraction.

### Build output

esbuild bundles everything (including D3) into a single `main.js`. The three files installed into `.obsidian/plugins/obsidian-mece-knowledge/` are `main.js`, `manifest.json`, and `styles.css`. Runtime data lives in `knowledge-store.json` (same directory) and user settings in `data.json` (managed by Obsidian).
