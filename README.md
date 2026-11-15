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

- No telemetry, analytics, authentication, or remote storage is required.
- API keys use the OS keychain when available, with a `chmod 600` file fallback.
- Every LLM page edit creates a backup first.
- Cost estimates appear before paid operations.
- MCP is read-only by design; write tools are not enabled.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CLAUDE.md`](CLAUDE.md), and [`docs/contributor-walkthrough.md`](docs/contributor-walkthrough.md) before opening a pull request. Security issues should follow [`SECURITY.md`](SECURITY.md).

## Credits and license

Built by **Yasas** as an independent implementation of the pattern described by **Andrej Karpathy**. It is not affiliated with Andrej Karpathy or Anthropic.

MIT. See [`LICENSE`](LICENSE).
