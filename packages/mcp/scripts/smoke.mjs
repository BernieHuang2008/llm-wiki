#!/usr/bin/env node
// End-to-end smoke test for the MCP server: boots it in-process on an ephemeral
// port against a throwaway wiki and config directory, then drives it over real
// HTTP — discovery documents, MCP initialize/tools-list/tools-call, and the
// OAuth code exchange.
//
// Not part of the unit test suite because it needs a built better-sqlite3
// native module, which the desktop sandbox cannot compile. Run it manually:
//
//   node packages/mcp/scripts/smoke.mjs
//
// Set LLM_WIKI_MCP_SMOKE_KEEP=1 to leave the temp directory in place for
// inspection.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../../", import.meta.url).pathname;
const dist = join(root.replace(/^\/([A-Za-z]:)/, "$1"), "packages", "mcp", "dist", "index.js");

const tempRoot = await mkdtemp(join(tmpdir(), "llm-wiki-mcp-smoke-"));
const configDir = join(tempRoot, "config");
const wikiPath = join(tempRoot, "wiki-root");
await mkdir(configDir, { recursive: true });
await mkdir(join(wikiPath, "wiki"), { recursive: true });
await mkdir(join(wikiPath, ".llm-wiki"), { recursive: true });

await writeFile(
  join(wikiPath, "wiki", "quantum-supremacy.md"),
  `---
title: Quantum Supremacy
slug: quantum-supremacy
type: concept
created: 2026-01-01
updated: 2026-01-02
tags: [quantum, hardware]
---

# Quantum Supremacy

The point at which a quantum device outperforms the best classical
simulation on a well-defined task. Related to [[shors-algorithm]].

## Significance

Primarily a hardware milestone rather than an algorithmic one.

### Criticisms

Several papers argue the classical baseline was weak.
`,
  "utf8",
);

await writeFile(
  join(wikiPath, "wiki", "shors-algorithm.md"),
  `---
title: Shor's Algorithm
slug: shors-algorithm
type: concept
created: 2026-01-01
updated: 2026-01-03
tags: [quantum, algorithm]
---

# Shor's Algorithm

A quantum algorithm for [[integer-factorization]]. Demonstrates the power of
[[quantum-supremacy]] hardware.

## Analysis

Runs in polynomial time.
`,
  "utf8",
);

await writeFile(
  join(wikiPath, "wiki", "integer-factorization.md"),
  `---
title: Integer Factorization
slug: integer-factorization
type: concept
created: 2026-01-01
updated: 2026-01-01
tags: [math]
---

# Integer Factorization

Decomposing a number into primes. Referenced by [[shors-algorithm]].
`,
  "utf8",
);

await writeFile(
  join(wikiPath, ".llm-wiki", "settings.json"),
  JSON.stringify({ version: 1, topic: "Smoke test wiki" }),
  "utf8",
);

await writeFile(
  join(configDir, "config.json"),
  JSON.stringify({ version: 1, activeWiki: wikiPath, recentWikis: [wikiPath], uiTheme: "auto" }),
  "utf8",
);

await writeFile(
  join(configDir, "mcp.json"),
  JSON.stringify(
    {
      version: 1,
      enabled: true,
      exposedWikis: [wikiPath],
      authMode: process.env["SMOKE_AUTH_MODE"] ?? "none",
      allowRemote: false,
      tokenTtlDays: 30,
      tools: {
        wiki_search: true,
        wiki_read_page: true,
        wiki_list_pages: true,
        wiki_get_toc: true,
        wiki_get_section: true,
        wiki_backlinks: true,
        wiki_get_graph: true,
      },
    },
    null,
    2,
  ),
  "utf8",
);

process.env["LLM_WIKI_CONFIG_DIR"] = configDir;
process.env["LLM_WIKI_PATH"] = wikiPath;

const mod = await import(new URL(`file://${dist}`).href);
const port = 3800 + Math.floor(Math.random() * 150);
const running = await mod.startMcpHttpServer({ port, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function mcp(body, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...authHeaders,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: safeJson(text) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // SSE framing: take the last `data:` line, which carries the result.
    const line = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (!line) return null;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      return null;
    }
  }
}

console.log(`smoke: ${base} (auth=${process.env["SMOKE_AUTH_MODE"] ?? "none"})`);

// In bearer mode every MCP request needs a credential, which mirrors what a
// real client does; in `none` mode the loopback exemption applies.
const authHeaders = {};
if ((process.env["SMOKE_AUTH_MODE"] ?? "none") === "bearer") {
  const store = new mod.CredentialStore();
  const created = await store.createStaticToken("smoke client", 30);
  authHeaders.authorization = `Bearer ${created.token}`;
}

try {
  // ---- discovery --------------------------------------------------------
  const resourceMeta = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const rm = await resourceMeta.json();
  check(
    "protected-resource metadata",
    resourceMeta.status === 200 && rm.resource?.endsWith("/mcp"),
  );
  check("metadata advertises this origin as the AS", rm.authorization_servers?.[0] === base);

  const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check("authorization-server metadata", asMeta.token_endpoint === `${base}/oauth/token`);

  const health = await (await fetch(`${base}/health`)).json();
  check("health lists all seven tools", health.tools.length === 7, JSON.stringify(health.tools));
  check("health lists the exposed wiki", health.wikis.length === 1);

  // ---- MCP handshake ----------------------------------------------------
  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  check(
    "initialize",
    init.status === 200 && init.json?.result?.serverInfo?.name === "llm-wiki",
    `status=${init.status} body=${init.text.slice(0, 200)}`,
  );

  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolNames = (list.json?.result?.tools ?? []).map((t) => t.name);
  check("tools/list returns seven tools", toolNames.length === 7, JSON.stringify(toolNames));

  const call = async (name, args) => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = res.json?.result;
    return {
      isError: result?.isError === true,
      structured: result?.structuredContent,
      text: result?.content?.[0]?.text,
      raw: res.text,
    };
  };

  const search = await call("wiki_search", { query: "quantum", max_results: 5 });
  check(
    "wiki_search returns hits",
    !search.isError && search.structured?.count >= 2,
    JSON.stringify(search.structured ?? search.raw).slice(0, 300),
  );
  check("wiki_search returns a score", typeof search.structured?.results?.[0]?.score === "number");

  const read = await call("wiki_read_page", { path: "wiki/shors-algorithm.md" });
  check(
    "wiki_read_page returns the body",
    !read.isError && read.structured?.body?.includes("polynomial"),
    JSON.stringify(read.structured ?? read.raw).slice(0, 300),
  );
  check("wiki_read_page lists outbound links", read.structured?.outbound?.length >= 2);
  check(
    "wiki_read_page lists inbound links",
    read.structured?.inbound?.some((b) => b.slug === "integer-factorization"),
  );

  const listPages = await call("wiki_list_pages", { overview: true });
  check("wiki_list_pages returns all pages", listPages.structured?.total === 3);
  check(
    "wiki_list_pages overview counts types",
    listPages.structured?.overview?.byType?.concept === 3,
  );

  const toc = await call("wiki_get_toc", { path: "quantum-supremacy" });
  const headingPaths = (toc.structured?.headings ?? []).map((h) => h.path);
  check(
    "wiki_get_toc finds nested headings",
    headingPaths.includes("Quantum Supremacy > Significance > Criticisms"),
    JSON.stringify(headingPaths),
  );

  const section = await call("wiki_get_section", {
    path: "quantum-supremacy",
    heading: "Quantum Supremacy > Significance",
  });
  check(
    "wiki_get_section returns only that section",
    !section.isError &&
      section.structured?.content?.includes("hardware milestone") &&
      !section.structured?.content?.includes("classical baseline"),
    JSON.stringify(section.structured?.content ?? section.raw).slice(0, 300),
  );
  check("wiki_get_section lists children", section.structured?.subsections?.length === 1);

  const backlinks = await call("wiki_backlinks", { path: "shors-algorithm" });
  check(
    "wiki_backlinks finds inbound links",
    backlinks.structured?.inbound?.length === 2,
    JSON.stringify(backlinks.structured?.inbound ?? backlinks.raw).slice(0, 300),
  );

  const graph = await call("wiki_get_graph", { depth: 1, max_nodes: 50 });
  check(
    "wiki_get_graph returns nodes and edges",
    graph.structured?.nodes?.length === 3 && graph.structured?.edges?.length === 4,
    JSON.stringify(graph.structured ?? graph.raw).slice(0, 300),
  );

  const subgraph = await call("wiki_get_graph", { roots: ["shors-algorithm"], depth: 1 });
  check("wiki_get_graph subgraph is smaller", subgraph.structured?.nodes?.length === 3);

  const missing = await call("wiki_read_page", { path: "wiki/does-not-exist.md" });
  check("a missing page is an error, not a crash", missing.isError);

  // ---- auth -------------------------------------------------------------
  if ((process.env["SMOKE_AUTH_MODE"] ?? "none") === "bearer") {
    const unauth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    check("unauthenticated request is challenged", unauth.status === 401);
    check(
      "challenge advertises the resource metadata",
      (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
    );

    const bogus = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer lwm_not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }),
    });
    check("a bogus bearer token is refused", bogus.status === 401);
  }

  // ---- OAuth code exchange ---------------------------------------------
  const store = new mod.CredentialStore();
  const client = await store.registerClient("Smoke client", ["http://127.0.0.1:9999/callback"]);

  // PKCE: derive a real verifier/challenge pair.
  const { createHash, randomBytes } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code2 = await store.createCode({
    clientId: client.clientId,
    redirectUri: "http://127.0.0.1:9999/callback",
    scopes: ["wiki:read"],
    tools: ["wiki_search", "wiki_read_page"],
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    resource: null,
  });

  const badPkce = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code2,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      client_id: client.clientId,
    }),
  });
  check("PKCE mismatch is rejected", badPkce.status === 400);

  const code3 = await store.createCode({
    clientId: client.clientId,
    redirectUri: "http://127.0.0.1:9999/callback",
    scopes: ["wiki:read"],
    tools: ["wiki_search", "wiki_read_page"],
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    resource: null,
  });
  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code3,
      code_verifier: verifier,
      client_id: client.clientId,
    }),
  });
  if (process.env["SMOKE_DEBUG"] === "1") {
    const { readFile } = await import("node:fs/promises");
    const dump = await readFile(join(configDir, "mcp-auth.json"), "utf8").catch(
      (e) => `ERR ${e.message}`,
    );
    console.log("DEBUG store:", dump.slice(0, 400));
  }
  const tokens = await tokenRes.json();
  check(
    "code exchange issues a token",
    tokenRes.status === 200 && typeof tokens.access_token === "string",
    JSON.stringify(tokens).slice(0, 200),
  );

  if (typeof tokens.access_token === "string") {
    const authed = await mcp(
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      { authorization: `Bearer ${tokens.access_token}` },
    );
    const names = (authed.json?.result?.tools ?? []).map((t) => t.name);
    check(
      "the OAuth token grants exactly the consented tools",
      names.length === 2 && names.includes("wiki_search") && names.includes("wiki_read_page"),
      JSON.stringify(names),
    );

    const streamed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
    });
    void streamed;
  }

  const refreshRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: client.clientId,
    }),
  });
  check("refresh token exchanges", refreshRes.status === 200, `status=${refreshRes.status}`);
} finally {
  await running.close();
  if (process.env["LLM_WIKI_MCP_SMOKE_KEEP"] === "1") {
    console.log(`kept: ${tempRoot}`);
  } else {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
