// Probe for the app-side supervisor: replicate exactly what
// `apps/web/src/lib/server-mcp.ts` does (resolve the launcher, spawn it with the
// env it builds) and then talk to the server over HTTP.
//
// `server-mcp.ts` itself cannot be imported outside Next (it uses the `@/`
// alias), so this script pins the contract instead: if the env var names or the
// launcher path change, this fails.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const PACKAGE_DIR = join(REPO_ROOT, "packages", "mcp");

const tempRoot = await mkdtemp(join(tmpdir(), "llm-wiki-supervisor-"));
const configDir = join(tempRoot, "config");
const wikiPath = join(tempRoot, "my-wiki");
await mkdir(join(wikiPath, "wiki"), { recursive: true });
await mkdir(join(wikiPath, ".llm-wiki"), { recursive: true });
await mkdir(configDir, { recursive: true });
await writeFile(
  join(wikiPath, "wiki", "hello.md"),
  "---\ntitle: Hello\nslug: hello\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Hello\n\nBody text about widgets.\n",
  "utf8",
);
await writeFile(
  join(configDir, "mcp.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    exposedWikis: [wikiPath],
    authMode: "none",
    allowRemote: false,
    tokenTtlDays: 30,
    tools: {
      wiki_search: true,
      wiki_read_page: true,
      wiki_list_pages: true,
      wiki_get_toc: true,
      wiki_get_section: true,
      wiki_backlinks: true,
      wiki_get_graph: false,
    },
  }),
  "utf8",
);

// Mirrors resolveLauncher() in server-mcp.ts.
const launcher = [resolve(REPO_ROOT, "packages", "mcp", "bin", "llm-wiki-mcp.mjs")].find(
  (candidate) => existsSync(candidate),
);
if (!launcher) throw new Error("launcher not found");

const port = 3900 + Math.floor(Math.random() * 90);
const baseName = wikiPath
  .split(/[\\/]+/)
  .filter(Boolean)
  .pop();
const env = {
  ...process.env,
  LLM_WIKI_MCP_PORT: String(port),
  LLM_WIKI_MCP_HOST: "127.0.0.1",
  LLM_WIKI_MCP_BASE_PATH: `/${baseName}/`,
  LLM_WIKI_MCP_FORCE: "1",
  LLM_WIKI_CONFIG_DIR: configDir,
  LLM_WIKI_PATH: wikiPath,
};

const child = spawn(process.execPath, [launcher], {
  cwd: PACKAGE_DIR,
  env,
  stdio: ["ignore", "inherit", "inherit"],
  detached: process.platform !== "win32",
});

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

try {
  let health = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        health = await res.json();
        break;
      }
    } catch {
      // not up yet
    }
  }
  check("launcher boots and answers /health", health !== null);
  check("tool switches are honoured", health?.tools?.length === 6, JSON.stringify(health?.tools));
  check(
    "the exposed wiki is visible",
    health?.wikis?.[0] === baseName,
    JSON.stringify(health?.wikis),
  );

  const res = await fetch(`http://127.0.0.1:${port}/${baseName}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-path": `/${baseName}/mcp`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wiki_list_pages", arguments: { overview: true } },
    }),
  });
  const text = await res.text();
  const payload = (() => {
    try {
      return JSON.parse(text);
    } catch {
      const line = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .pop();
      return line ? JSON.parse(line.slice(5).trim()) : null;
    }
  })();
  const structured = payload?.result?.structuredContent;
  check("the wiki path in the URL selects the wiki", structured?.total === 1, text.slice(0, 300));
  check("overview reflects the wiki topic directory", structured?.wiki === baseName);
} finally {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures === 0 ? "\nsupervisor contract ok" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
