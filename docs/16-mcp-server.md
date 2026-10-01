# 16 — MCP Server

The wiki as a read-only MCP server, so any MCP-capable LLM client (Claude
Desktop, Cursor, VS Code, Cline, …) can search and read it as long-term memory.

Status: shipped in `packages/mcp`, surfaced in **Settings → MCP**. Read-only by
design — see [Why read-only](#why-read-only).

---

## 1. Shape

```
LLM Wiki (Next.js, :3737)          MCP server (node, :5040)
┌────────────────────────┐         ┌──────────────────────────────────┐
│ Settings → MCP         │  spawn  │ POST /mcp        JSON-RPC (MCP)  │
│  /api/mcp/config  ─────┼────────▶│ GET  /.well-known/…              │
│  /api/mcp/tokens       │         │ GET  /oauth/authorize            │
│                        │         │ POST /oauth/approve | token      │
│ wiki/  ◀─── files ─────┼────┐    │ POST /oauth/register | revoke    │
│ .llm-wiki/meta.sqlite  │    └───▶│ GET  /health                     │
└────────────────────────┘         └──────────────────────────────────┘
        │                                        │
        └────────── ~/.llm-wiki/mcp.json ────────┘
                    ~/.llm-wiki/mcp-auth.json
```

A separate process, not an API route inside Next, because:

- it must keep serving while no browser tab is open;
- a crash in one must not take the other down;
- the process that holds the wiki's SQLite handle should not be the one
  rendering HTML from user-controlled markdown.

The app spawns it lazily (opening Settings → MCP is enough), restarts it when a
setting it reads at startup changes, and holds a lock file so a second app
process cannot start a duplicate.

**Why a separate port.** The app's port is already variable and auto-incremented
when busy (`llm-wiki start` picks 3737 and walks up). A variable port would
break every client the moment it moved, so the MCP port is fixed at **5040**.
The Settings page shows `http://<browser hostname>:5040/<wiki>/mcp` — the domain
half comes from `window.location`, the port from `packages/mcp/src/port.ts`.

---

## 2. Tools

All seven are read-only. Every tool returns `structuredContent` (JSON, for the
model) plus a one-line text summary (for a human reading a client's transcript).

| Tool               | What it returns                          | Notable parameters                                                          |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------------------- |
| `wiki_search`      | path, title, snippet, 0–1 score          | `max_results` (≤50), `snippet_length`, `type`, `tags`                       |
| `wiki_read_page`   | body, frontmatter, out/in links, outline | `path`, `max_chars`                                                         |
| `wiki_list_pages`  | every page, filterable                   | `type`, `tags`, `limit`, `offset`, `overview`                               |
| `wiki_get_toc`     | H1–H6, anchors, line ranges, previews    | `path`                                                                      |
| `wiki_get_section` | one section's body + child headings      | `path`, `heading`, `include_subsections`                                    |
| `wiki_backlinks`   | inbound links + excerpts, plus outbound  | `path`                                                                      |
| `wiki_get_graph`   | nodes and edges, or a subgraph           | `roots`, `depth` (≤4), `types`, `tags`, `max_nodes`, `include_broken_links` |

`wiki_get_toc` → `wiki_get_section` is the pair that matters for cost: a model
reads a page's structure for a few hundred tokens, then pulls only the section it
needs. `wiki_read_page` also falls back to "opening excerpt + outline" when a
body exceeds ~24k characters, so a huge page cannot blow up a context window.

Every tool takes an optional `wiki` argument, which is only consulted when more
than one wiki is exposed _and_ the request URL does not already name one.

### Search strategy

`wiki_search` is a single interface over a list of retrieval channels
(`SEARCH_CHANNELS` in `tools/search.ts`). Today there is exactly one channel: an
FTS5 query using `bm25()` for ranking and `snippet()` for the excerpt. The raw
`bm25()` value is negative and unbounded, so it is mapped monotonically into
(0, 1] before it reaches the model.

The channel interface exists because the roadmap's hybrid search
([`14-roadmap.md`](14-roadmap.md)) is a retrieval change, not a tool-schema
change: adding a vector channel means implementing `SearchChannel` and merging
its hits, with no client-visible difference.

When FTS finds nothing (usually because a page was edited outside the app and
has not been re-indexed yet), the tool falls back to scoring titles and tags, and
says so in `strategy` rather than claiming the wiki has no such page.

---

## 3. Permissions

Three independent gates. A tool call has to pass all of them.

### 3.1 Exposure

`exposedWikis` in `mcp.json` is an allow-list of folders. `WikiRegistry.resolve()`
matches the request path against it and refuses anything else. This is the gate
that makes "which databases are open" a real setting — nothing else in the app
checks inbound credentials.

### 3.2 Tool switches

`tools` in `mcp.json` is a per-tool switch. A disabled tool is **absent from
`tools/list`**, not merely refused: the model never learns it exists.

### 3.3 Credential

| Mode     | Accepts                                        | Use when                                    |
| -------- | ---------------------------------------------- | ------------------------------------------- |
| `none`   | loopback connections only                      | purely local, one user                      |
| `bearer` | static tokens created in Settings              | clients that only understand a fixed header |
| `oauth`  | OAuth 2.1 access tokens, **and** static tokens | clients that support the spec               |

An unauthenticated request gets `401` with a `WWW-Authenticate` challenge
carrying `resource_metadata`, which is how an MCP client discovers where to
authorize.

Effective permission for a request is the intersection of the tool switches, the
OAuth grant, and (for OAuth) the per-tool choices made on the consent screen.
Revoking a tool in Settings takes effect on the next call — no re-authorization
needed.

### 3.4 OAuth

The MCP spec points an Authorization Server at any OAuth AS that speaks
authorization-code + PKCE. The desktop app has exactly one user and its own
consent UI, so the authorization server lives in `packages/mcp/src/auth/oauth.ts`
rather than behind a third-party IdP.

| Endpoint                                      | Purpose                                               |
| --------------------------------------------- | ----------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource`   | RFC 9728; names the AS                                |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata                                     |
| `POST /oauth/register`                        | RFC 7591 dynamic client registration (public clients) |
| `GET /oauth/authorize`                        | the page the client's browser is sent to              |
| `POST /oauth/approve`                         | the consent form target                               |
| `POST /oauth/token`                           | `authorization_code` and `refresh_token`              |
| `POST /oauth/revoke`                          | RFC 7009                                              |

Deliberately absent: client secrets (a desktop client cannot keep one), implicit
flow, and password grants. Access tokens are opaque, stored only as SHA-256
digests, and revocable — worth more here than a JWT that cannot be withdrawn.
Refresh tokens rotate on every use.

**Bootstrapping trust.** The server is reached on its own port, so a cookie from
the app would only be sent if the ports matched. Instead, approves are gated by a
short-lived **approval code** (`设置 → MCP → 生成批准码`): the browser lands on the
server's consent page, the user pastes the code once, and the server sets its own
`HttpOnly` session cookie so later clients need only the checkbox step. Codes are
stored hashed, expire in 30 minutes, and are cleared on first successful use.

### 3.5 Remote access

`allowRemote` is off by default, and `none` mode requires loopback **and**
`allowRemote === false`. Binding to `0.0.0.0` (a container) must never silently
turn a wiki into a public endpoint.

---

## 4. Storage

| File                             | Contents                                                   | Committable         |
| -------------------------------- | ---------------------------------------------------------- | ------------------- |
| `~/.llm-wiki/mcp.json`           | enable flag, exposed wikis, auth mode, tool switches, TTL  | no (machine config) |
| `~/.llm-wiki/mcp-auth.json`      | clients, hashed tokens, hashed codes, sessions (mode 0600) | **never**           |
| `~/.llm-wiki/mcp-heartbeat.json` | pid + timestamp, written by the server                     | no                  |

Global rather than per-wiki, for two reasons: one server serves the process, so
"which tools" cannot sensibly depend on which wiki the app happens to have active;
and `.llm-wiki/mcp.json` inside a wiki folder is committable by design
([`03-data-model.md`](03-data-model.md)), which credential material must not be.

Credential writes are serialised through an in-process queue, written
write-then-rename, and re-read when the file's mtime changes — two
`CredentialStore` instances in one process (the server's and the settings API's)
must see each other's writes.

---

## 5. Why read-only

`docs/14-roadmap.md` scoped MCP as "read-only initially; write access for ingest
later". Write tools are deferred for concrete reasons, not just scope:

- `withWriteLock` is an in-process `AsyncLocalStorage` mutex. A second process
  writing pages would not be serialised by it, so page + `index.md` + `log.md`
  read-modify-write cycles would race — WAL protects SQLite, not markdown.
- An MCP client is a remote caller by definition. `POST /api/pages` is already
  unauthenticated but only reachable from the same machine and the same browser
  session; an MCP write tool would need per-tool write scopes, an audit trail,
  and a conflict story before it is worth having.

Read-only also makes the permission model auditable: every scope is a read.

---

## 6. Layout

```
packages/mcp/
├── bin/llm-wiki-mcp.mjs      launcher (http | stdio | config | port)
├── build.mjs                 esbuild bundle → dist/
├── scripts/smoke.mjs         end-to-end HTTP test
└── src/
    ├── index.ts              library barrel (safe to import)
    ├── config.ts             mcp.json read/write          ← imported by the app
    ├── types.ts              shared types                 ← imported by the app
    ├── port.ts               port + endpoint-path rules
    ├── auth/
    │   ├── crypto.ts         hashing, PKCE, id generation
    │   ├── guard.ts          request → principal | challenge
    │   ├── oauth.ts          authorization server
    │   ├── store.ts          credential store
    │   └── urls.ts           public-URL and discovery URLs
    ├── server/
    │   ├── http.ts           routes + per-request server factory
    │   ├── html.ts           approval + status pages
    │   └── heartbeat.ts      liveness file
    ├── tools/
    │   ├── registry.ts       tool ids, scopes (single source of truth)
    │   ├── handlers.ts       zod schemas + tool registration
    │   ├── search.ts         retrieval channels
    │   └── pages.ts          shared page/graph reads
    └── wiki/
        ├── registry.ts       wiki allow-list + connection pool
        └── outline.ts        heading extraction
```

### Why the server is a bundle

Workspace packages ship TypeScript source with no `dist/` — the Next app
transpiles them. A plain `node` process cannot import that, so `build.mjs` uses
esbuild to compile `packages/mcp` **and the `@llm-wiki/core` code it uses** into
`dist/index.js` (library), `dist/server.js` (HTTP) and `dist/stdio.js`. The three
outputs stay separate so the launcher can inspect configuration without starting
a server. Only what must exist as real files is external: `better-sqlite3`,
`keytar`, `chokidar`, and the MCP SDK itself.

Consequences worth knowing:

- `pnpm --filter @llm-wiki/mcp build` must run before `next build`; the app's
  `build` and `dev` scripts do this first.
- `dist/` is gitignored. A missing bundle produces a sentence telling you to
  build, not a module-resolution stack trace.
- `apps/web/scripts/copy-standalone-assets.mjs` copies `bin`, `dist` and
  `package.json` into the standalone output at `packages/mcp/`, because file
  tracing never sees a process the app spawns by path.

### What the app is allowed to import

`@llm-wiki/mcp/config`, `/types` and `/port` only — the barrel and the MCP SDK
must not reach the Next bundle. Client components mirror the types locally, the
same way `wikis-tab.tsx` mirrors the schema templates.

---

## 7. Configuration reference

| Env var                  | Default                                    | Meaning                                                              |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `LLM_WIKI_MCP_PORT`      | `5040`                                     | Port to bind. Both sides read it, so the displayed URL cannot drift. |
| `LLM_WIKI_MCP_HOST`      | `127.0.0.1` (`0.0.0.0` when `allowRemote`) | Interface to bind.                                                   |
| `LLM_WIKI_MCP_BASE_PATH` | empty                                      | Wiki path prefix the app displays, e.g. `/quantum/`.                 |
| `LLM_WIKI_MCP_FORCE`     | unset                                      | Start even when `mcp.json` says disabled.                            |
| `LLM_WIKI_CONFIG_DIR`    | `~/.llm-wiki`                              | Where `mcp.json` / `mcp-auth.json` live.                             |

CLI: `llm-wiki start --mcp` forces the server on, `--no-mcp` forces it off;
without either, the saved setting decides. `llm-wiki-mcp config` prints the
resolved paths and URL.

---

## 8. Docker

`EXPOSE 3000 5040`, and `docker/entrypoint.sh` runs the app and the MCP server as
two processes with a shared shutdown trap. Publish both ports:

```bash
docker run -p 3000:3000 -p 5040:5040 -v ~/my-wiki:/data/wiki llm-wiki
```

Inside the container the wiki lives at `/data/wiki`, so the endpoint is
`/data/wiki/mcp` while the browser sees `http://host:5040/data/wiki/mcp`. Set
`LLM_WIKI_MCP_BASE_PATH` to advertise a friendlier path, and remember that
`allowRemote` must be on before an unauthenticated request is accepted.

---

## 9. Verifying

```bash
pnpm --filter @llm-wiki/mcp test               # pure units: outline, URLs, PKCE, scopes
pnpm --filter @llm-wiki/mcp build
node packages/mcp/scripts/smoke.mjs            # boots the server and drives it over HTTP
node packages/mcp/scripts/supervisor-probe.mjs # the app-side spawn contract
```

`scripts/smoke.mjs` checks discovery documents, the MCP handshake, `tools/list`,
every tool, the error paths, the `401` challenge, and the full OAuth code exchange
including a rejected PKCE verifier. Set `SMOKE_AUTH_MODE=bearer` to run it against
bearer auth, and `LLM_WIKI_MCP_SMOKE_KEEP=1` to keep the throwaway wiki it creates.

`scripts/supervisor-probe.mjs` covers the other half: it spawns the launcher with
exactly the environment `apps/web/src/lib/server-mcp.ts` builds, then checks that
the wiki named in the URL path is the one that gets read. That source file cannot
be imported outside Next (it uses the `@/` alias), so this probe is what pins the
contract — if an env var name or the launcher path drifts, it fails.

It needs a built `better-sqlite3`. On a machine without a C++ toolchain,
`scripts/better-sqlite3-shim.cjs` adapts `node:sqlite` to the same API; drop it in
as `packages/mcp/node_modules/better-sqlite3/index.js` with a one-line
`package.json` pointing at it. This is test scaffolding only — never loaded by the
product.

---

## 10. Known gaps

- **No write tools.** See [Why read-only](#why-read-only).
- **No vector channel.** The interface is ready; the embeddings are not.
- **`findBacklinks` is O(N) disk reads** per call. Fine for the personal-wiki
  scale the project targets; a `page_links` table is the fix if it stops being
  fine.
- **stdio transport ignores `authMode`.** A piped child process has no headers to
  carry a token; the parent already has the user's privileges, so the transport
  is trusted by construction. It is off by default — `--help` documents it, and
  only for clients that cannot launch an HTTP server.
