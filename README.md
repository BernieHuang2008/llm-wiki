<p align="center">
  <img src="apps/web/public/logo-hero.svg" alt="LLM Wiki" width="600">
</p>

<h1 align="center">LLM Wiki</h1>

<p align="center">
  <strong>A personal Wikipedia an LLM maintains for you.</strong><br>
  Feed it sources, ask questions, and let it build a cross-linked knowledge base that remains yours.
</p>

<p align="center">
  Open source · Local-first · Bring your own key · MIT
</p>

<p align="center">
  <a href="https://github.com/BernieHuang2008/llm-wiki"><img src="https://img.shields.io/github/stars/BernieHuang2008/llm-wiki?style=flat&color=991b1b" alt="GitHub stars"></a>
  <a href="https://www.npmjs.com/package/@syasas/llm-wiki"><img src="https://img.shields.io/npm/v/@syasas/llm-wiki?color=991b1b&label=npm" alt="npm version"></a>
  <a href="https://github.com/BernieHuang2008/llm-wiki/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://github.com/BernieHuang2008/llm-wiki/blob/main/CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome"></a>
</p>

LLM Wiki is a from-scratch implementation of [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): raw sources, an LLM-maintained wiki, and a schema that keeps the system coherent.

Unlike a disposable RAG chat, the result is a folder of Markdown files you can inspect, edit, version, sync, or open in another tool. Unlike a traditional notes app, the LLM performs the ingestion, linking, refactoring, and health checks.

## What this implementation adds

The original pattern is intentionally small. This project turns it into a complete local application with:

- **Three first-class operations** — ingest, query, and lint, with streaming progress, citations, cost previews, usage tracking, and recoverable errors.
- **Broad source ingestion** — pasted text, URLs, Markdown, HTML, TXT, PDF, DOCX, PPTX, XLSX, PNG, and JPG.
- **A maintained wiki UI** — typed page cards, rendered Markdown, backlinks, source lineage, search, filters, inline editing, page history, soft-delete, undo, and index rebuilding.
- **Chat threads that become knowledge** — persistent Markdown conversations, folders, pins, search, per-message promotion, and whole-chat “Ingest → wiki”.
- **A 3D knowledge graph** — every page is a node and every `[[wikilink]]` is an edge; inspect neighbors, focus nodes, and share deep links.
- **Lint with one-click fixes** — find broken links, orphans, contradictions, gaps, stale claims, and missing pages, then apply safe or LLM-assisted repairs.
- **Approval and diff workflows** — preview proposed ingest changes, apply or discard them, and inspect line-by-line page history.
- **Multiple wikis** — keep separate topics in separate folders and switch them from Settings, the header, or the command palette without restarting the server.
- **Local model support** — choose OpenRouter or Ollama independently for ingest, query, chat, lint, and vision.
- **Fast search when available** — optional Meilisearch indexes each wiki separately, with a transparent title/tag fallback when it is unavailable.
- **MCP memory server** — expose selected wikis to Claude Desktop, Cursor, VS Code, Cline, and other MCP clients through seven read-only tools with OAuth 2.1 or static tokens.
- **Cross-platform distribution** — a global `llm-wiki` CLI, standalone npm tarball, Docker support, and macOS, Linux, Windows, and WSL compatibility.

## Screenshots

![Wiki landing page](docs/screenshots/02-wiki-landing.png)

![3D knowledge graph](docs/screenshots/03-graph.png)

![Chat thread](docs/screenshots/05-chat.png)

More screens are available in [`docs/screenshots/`](docs/screenshots/).

## Quick start

### Install the CLI
![Schema editor — split-pane markdown editor with live preview](docs/screenshots/06-schema-editor.png)
_`/schema` — edit `CLAUDE.md` (the LLM's operating contract) with a split-pane markdown editor + live preview. Auto-backup to `.llm-wiki/schema-history/` on every save._

### Settings + multi-wiki

![Settings General — topic, approval gate, default folder](docs/screenshots/07-settings-general.png)
_`/settings` — one-line wiki topic (the LLM reads this on every operation), optional approval gate for ingest, theme picker, default models per operation slot._

![Settings Costs — per-model cumulative usage breakdown](docs/screenshots/08-settings-costs.png)
_`/settings → Costs` — cumulative tokens + spend per (model, operation) pair. The `Cost (recorded)` column populates as new LLM calls land; historical rows get backfilled from the pricing table on next startup._

![Active wiki dropdown in the header](docs/screenshots/09-wiki-switcher.png)
_Header chip → dropdown with the active wiki (topic + folder path), plus quick links to Create / Manage. Same actions are reachable from `⌘K` ("Switch to…" group) and `/dashboard` (per-wiki cards with Switch buttons)._

---

## What's in v1.2

> **Recent patches:**
>
> - **v1.2.3** _(2026-05-27)_ — **free OpenRouter models** added to the Settings → Models dropdown (Llama 3.3 70B, Nemotron Super 120B, DeepSeek V4 Flash, Gemma 4 31B). Settings banner explains rate-limit + data-retention tradeoffs. First-run wizard gained a one-click _"Use free models by default"_ toggle so the cost-to-first-ingest is zero. ([release](https://github.com/ddsyasas/llm-wiki/releases/tag/v1.2.3))
> - **v1.2.2** _(2026-05-26)_ — CLI now prints an update-available banner on `llm-wiki start` when a newer version is on npm. Cached on disk, refreshed in the background, silenced by `NO_UPDATE_NOTIFIER=1` or `--quiet`. ([release](https://github.com/ddsyasas/llm-wiki/releases/tag/v1.2.2))
> - **v1.2.1** _(2026-05-26)_ — fixes two regressions from the v1.2.0 Ollama refactor: the Sources/Query pages crashed the moment text was typed/pasted, and PDF ingest failed with `Cannot read properties of undefined (reading '0')`. PDFs now ride OpenRouter's `type: "file"` contract; settings types match runtime. ([release](https://github.com/ddsyasas/llm-wiki/releases/tag/v1.2.1) · [known-issues thread](https://github.com/ddsyasas/llm-wiki/issues/3))

### The three operations (Karpathy's pattern)

- **Ingest** — Drop a source (text / file / URL / PDF / image) → the LLM reads it + your existing wiki and relevant `raw/` originals, writes new pages, updates older pages where context shifts, refreshes the index, logs the change. Each ingest is a _refactor pass_, not an append.
- **Query** — One-shot Q&A against the whole wiki and `raw/` originals with cited pages. "Save as wiki page" promotes useful answers into permanent entries.
- **Lint** — Two-pass health check: local scan (broken links, orphans) + LLM pass (contradictions, gaps, stale claims, missing pages). Every issue ships with **one-click fixes** — including LLM-powered ones that write the page edit for you.

### Workflow features

- **Sources page** — Add via paste, drag-and-drop, or URL. Auto-detects format. Cost preview before every ingest. Per-source detail view shows the raw text, contributing wiki pages, and metadata.
- **Wiki landing** — Cards grouped by type (Overviews → Concepts → Entities → Comparisons → Sources). Search/filter sidebar. Click any card → page view with backlinks + source lineage + inline edit.
- **3D Graph view** _(new in v1.0)_ — Force-directed graph of every page and every `[[wikilink]]`. Same engine as Obsidian's 3D Graph plugin, but colored by **page type** (not free-form tag), so the structure of your knowledge is visible at a glance. Click-to-focus reveals neighbors; drag/scroll to orbit; URL-state for deep links. Spec: [`docs/12-graph-view.md`](docs/12-graph-view.md).
- **Chats** — Agentic multi-turn conversations saved as `.md` files in folders. The model searches/reads wiki pages and `raw/` sources with tools; thinking, tool calls and results are visible in the thread, and **停止** aborts the turn at any time. Per-message "Save as wiki page" + whole-chat "Ingest → wiki" buttons close the loop from exploratory thinking back into the permanent layer.
- **Schema editor** — Edit the `CLAUDE.md` contract the LLM reads on every operation. Split-pane preview, auto-backup to `.llm-wiki/schema-history/`.
- **Log timeline** — `/log` shows every ingest / edit / lint / schema-save in chronological order. Wikilinks inside log entries are clickable.
- **Multiple wikis** — keep separate wikis for separate topics (e.g. "Physics", "ML research", "Personal KB"). Switch from the active-wiki chip in the header, the `Cmd+K` palette, or **Settings → Wikis** (full CRUD). Switching is in-place — you stay on whatever page you're on, the data refreshes around you. Spec: [`docs/13-multi-wiki.md`](docs/13-multi-wiki.md).
- **Wiki health dashboard** at `/dashboard` _(new in v1.x)_ — cross-wiki overview: per-wiki page / source / chat counts, cumulative LLM spend, last-touched timestamps, sortable by recency. Roll-up totals at the top. One-click switch into any wiki.

### Quality / safety

- **First-run gate** — A real wizard collects the wiki topic + an LLM provider (OpenRouter API key OR a local Ollama install — see below) before letting you wander. No silent failures on first ingest.
- **Local models support (Ollama)** _(new in v1.2)_ — first-class per-slot provider option in Settings → Models. Run any operation (ingest / query / chat / lint / vision) against a model on your own machine instead of OpenRouter. Free per query after the one-time model download, fully private (data never leaves your laptop). Dedicated `/local-models` setup guide in-app covers install + a hardware-requirements table mapping common models (llama3, mistral, phi3, llava, mixtral, llama3:70b, etc.) to RAM / disk / expected tokens-per-sec on Apple Silicon and CPU-only.
- **Page-history backups** — Every page edit (manual or LLM-driven) backs up the prior version to `.llm-wiki/page-history/`.
- **Cost transparency** — Estimated cost shown before every LLM operation; running cumulative tally in Settings → Costs.
- **Source lineage** — Every wiki page lists which raw sources it was compiled from; every source lists which wiki pages it contributed to. Bidirectional graph traversal.
- **Index integrity** — `index.md` auto-refreshes on every page edit. Click "Rebuild index" anytime for a full re-sweep.

### Settings

Five model slots tunable per-operation: `ingest` / `query` / `chat` / `lint` / `vision`. **Per-slot provider picker** _(new in v1.2)_: choose **OpenRouter** (cloud, BYOK, pay-as-you-go) or **Ollama (Local)** (your own machine, free) per slot — mix and match. Curated model dropdowns for each provider plus a custom-slug field for anything else. If any slot uses Ollama, a heads-up banner appears with a link to the `/local-models` setup guide. Light / dark / auto theme. OpenRouter key stored in OS keychain when available.

---

## The on-disk shape

```
~/llm-wiki-default/                  # your wiki folder (set with LLM_WIKI_PATH)
├── CLAUDE.md                        # the schema you edit at /schema
├── index.md                         # auto-maintained catalog of pages
├── log.md                           # every operation, browsable at /log
├── raw/                             # original source files, untouched
├── wiki/                            # LLM-maintained pages (Markdown + frontmatter)
├── chats/                           # chat threads as .md files
└── .llm-wiki/                       # SQLite metadata + page-history + schema-history
```

Everything is plain markdown. Delete the app, open the folder in Obsidian / VS Code / vim — your wiki still works.

---

## Install + run

Three paths. Pick one.

### Hosted — try without installing

The hosted version lives at **[llmwiki.cc](https://llmwiki.cc)**. No install, no Node, no OpenRouter account required to look around — sign up, click around, start ingesting. Currently in waitlist: hosted product launches as paid tiers when the waitlist signals demand. Join the list on the site if you want an email when it goes live.

For everyone who'd rather run it themselves (the local-first promise this project was built on stays untouched), the two install paths below are the canonical way:

### Quick start — install the CLI (recommended)

```bash
npm install -g @syasas/llm-wiki
llm-wiki start
```

The CLI initializes a wiki folder, chooses an available port starting at `3737`, and opens the browser. The first-run wizard asks for a topic and an LLM provider.

Choose either:

- **OpenRouter** — bring an API key and use hosted models.
- **Ollama** — run models locally; no OpenRouter key is required.

### Run from source

```bash
git clone https://github.com/BernieHuang2008/llm-wiki.git
cd llm-wiki
pnpm install
pnpm dev
```

Open `http://localhost:3000`. To select a specific wiki folder:

```bash
LLM_WIKI_PATH=~/my-research-wiki pnpm dev
```

On Windows PowerShell:

```powershell
$env:LLM_WIKI_PATH = "C:\Users\you\my-research-wiki"
pnpm dev
```

### CLI commands

```bash
llm-wiki start [folder]  # start the app
llm-wiki init [folder]   # initialize a wiki without starting
llm-wiki doctor          # check Node, configuration, and connectivity
llm-wiki help            # show commands and flags
```

Node.js 20+ is required. `pnpm` is required when running from source.

## The on-disk contract

```text
my-wiki/
├── CLAUDE.md                 # the LLM's editable operating contract
├── index.md                  # maintained page catalog
├── log.md                    # operation timeline
├── raw/                      # original sources, never replaced by summaries
├── wiki/                     # Markdown pages with frontmatter
├── chats/                    # saved chat threads
└── .llm-wiki/
    ├── meta.sqlite           # metadata, usage, and search indexes
    ├── page-history/         # backups before page edits
    ├── schema-history/       # CLAUDE.md backups
    └── trash/                # recoverable deleted content
```

The Markdown files are the source of truth. SQLite is metadata only. Uninstalling the app does not take the wiki with it.

## Core workflow

1. **Ingest** a source. The LLM reads the source, your existing wiki, and `CLAUDE.md`, then creates or updates pages, cross-links them, refreshes the index, and records the operation.
2. **Query** the accumulated wiki. Answers include page citations and can be saved as permanent wiki pages.
3. **Lint** the structure and content. Local checks catch broken links and orphans; an LLM pass finds contradictions, gaps, stale claims, and missing pages.
4. **Review and explore** with page history, source lineage, chat threads, the log timeline, and the 3D graph.

## MCP server

Settings → MCP can run a separate MCP server on port `5040`. It can expose an allow-list of wiki folders and individual read-only tools:

`wiki_search`, `wiki_read_page`, `wiki_list_pages`, `wiki_get_toc`, `wiki_get_section`, `wiki_backlinks`, and `wiki_get_graph`.

Authentication supports loopback-only mode, static bearer tokens, and OAuth 2.1 with PKCE. See [`docs/16-mcp-server.md`](docs/16-mcp-server.md) for configuration, security boundaries, and Docker usage.

## Docker

```bash
MEILISEARCH_API_KEY=change-me docker compose up -d --build
```

The Compose setup runs the app and an optional private Meilisearch sidecar. Publish ports `3000` and `5040` if you want browser access and MCP access from outside the container.

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/01-vision.md`](docs/01-vision.md) | Product goals and non-goals |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Stack and repository layout |
| [`docs/03-data-model.md`](docs/03-data-model.md) | Filesystem and SQLite model |
| [`docs/04-features-v1.md`](docs/04-features-v1.md) | Feature scope and shipped status |
| [`docs/05-llm-integration.md`](docs/05-llm-integration.md) | Providers, prompts, and JSON contracts |
| [`docs/06-ingest-pipeline.md`](docs/06-ingest-pipeline.md) | Source extraction and page writing |
| [`docs/07-chat-threads.md`](docs/07-chat-threads.md) | Chat storage and promotion |
| [`docs/12-graph-view.md`](docs/12-graph-view.md) | 3D graph design |
| [`docs/13-multi-wiki.md`](docs/13-multi-wiki.md) | Multi-wiki switching |
| [`docs/14-roadmap.md`](docs/14-roadmap.md) | Remaining V2/V3 work |
| [`docs/16-mcp-server.md`](docs/16-mcp-server.md) | MCP server and authentication |
| [`docs/dev-setup.md`](docs/dev-setup.md) | Development and troubleshooting |
| [`docs/dev-log.md`](docs/dev-log.md) | Dated implementation history |

The app also includes `/about`, `/help`, and `/developers` pages.

## Development

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The project is a pnpm workspace using TypeScript strict mode, Next.js App Router, Tailwind, `better-sqlite3`, `openai`-compatible providers, Zod, Vitest, and named exports for shared modules.

## Privacy and safety

- API keys use the OS keychain when available, with a `chmod 600` file fallback.
- Every LLM page edit creates a backup first.
- Cost estimates appear before paid operations.
- MCP is read-only by design; write tools are not enabled.

**All P0 features shipped.** All three Karpathy operations (ingest / query / lint) wired end-to-end with cost previews, error recovery, and one-click fixes. Chats, schema editor, settings, log timeline, source-lineage UI, and the 3D graph view all live.

**Test suite**: ~158 core + 25 llm + 11 ingestion ≈ **194 passing tests**. (One chokidar live-watch test is a known flake.)

**Cross-platform install**: verified end-to-end on macOS / Linux / Windows. v1.2.3 ships as a single ~28MB tarball; native deps (`better-sqlite3`, `keytar`) install fresh per-platform via npm.

**Distribution**: published on npm as [`@syasas/llm-wiki`](https://www.npmjs.com/package/@syasas/llm-wiki). `npm install -g @syasas/llm-wiki` is the canonical install. [GitHub Releases](https://github.com/ddsyasas/llm-wiki/releases/latest) mirror the same tarball for direct download.

**Deferred to V2 / V3** (tracked in [`docs/14-roadmap.md`](docs/14-roadmap.md)):

- **Tauri desktop installer** (V2)
- **Embeddings-based search** + **2D graph toggle** + persistent camera state (V2)
- **Ollama / local-model support** (V2)
- **Scheduled lint runs** (V2)

**MCP server** — shipped. Any MCP-capable client (Claude Desktop, Cursor, VS Code, …) can search and read the wiki as memory: nine read-only tools (including direct access to the `raw/` originals), OAuth 2.1 + static tokens, its own process on port 5040. Turn it on in **Settings → MCP**. See [`docs/16-mcp-server.md`](docs/16-mcp-server.md).

The full V1.x sprint (14 items across sections P + Q + R — mobile sidebar, diff view, approval gate, export-to-zip, wiki templates, cross-wiki search, setup gate completion, wiki health dashboard, replay-tour fix, LLM cost calculation, production build, publish pipeline, cross-platform tarball) shipped on 2026-05-24 — see [`docs/dev-log.md`](docs/dev-log.md).

---

## Stack

| Layer             | Choice                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Language          | TypeScript strict                                                                                                      |
| Framework         | Next.js 14 (App Router)                                                                                                |
| UI                | React, Tailwind, shadcn-style primitives, Fraunces / Crimson Pro / Inter / JetBrains Mono                              |
| Storage           | Plain markdown + SQLite (`better-sqlite3`) for metadata, FTS5 for search                                               |
| LLM               | OpenRouter (cloud, BYOK) and/or local Ollama — both via the `openai` npm SDK against their OpenAI-compatible endpoints |
| Schema validation | `zod`                                                                                                                  |
| Frontmatter       | `gray-matter`                                                                                                          |
| File watch        | `chokidar`                                                                                                             |
| Source extractors | `mammoth` (DOCX), `officeparser` (XLSX/PPTX), `@mozilla/readability` (HTML/URL), vision models for PDF/image           |
| Graph view        | `react-force-graph-3d` + `three.js`                                                                                    |
| Secrets           | OS keychain via `keytar`, with chmod-600 file fallback                                                                 |
| Tests             | `vitest`                                                                                                               |
| Package manager   | `pnpm` workspaces                                                                                                      |

Hard rules from the design contract: **TypeScript everywhere** (no Python sidecars), **cross-platform from day one** (Mac, Windows, Linux), **no Electron / Tauri / React Native in V1** (the app is a local Next.js server you run yourself).

---

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CLAUDE.md`](CLAUDE.md), and [`docs/contributor-walkthrough.md`](docs/contributor-walkthrough.md) before opening a pull request. Security issues should follow [`SECURITY.md`](SECURITY.md).

## Credits and license

Built by **Yasas** as an independent implementation of the pattern described by **Andrej Karpathy**. It is not affiliated with Andrej Karpathy or Anthropic.

MIT. See [`LICENSE`](LICENSE).
