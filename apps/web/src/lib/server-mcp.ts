// Owns the MCP server child process.
//
// The MCP server is a separate process on purpose: it has to keep serving while
// the browser is closed, it must not be able to take the UI down, and the
// credential boundary is easier to reason about when the process that holds the
// wiki's SQLite handle is not the one rendering HTML.
//
// Lifecycle rules:
//   - started lazily by the first API route that needs it, so `next dev` does
//     not fork a process nobody asked for
//   - restarted when Settings → MCP changes something the server reads at
//     startup (enable flag, port, auth mode, exposed wikis, tool switches)
//   - a lock file keeps a second app process from spawning a duplicate

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isServerRunning, loadMcpConfig, readHeartbeat, type McpConfig } from "@llm-wiki/mcp";
import { resolveWikiPath } from "@/lib/server-wiki";

export type McpSupervisorStatus = {
  /** True when a server answered its heartbeat recently. */
  running: boolean;
  /** True when this process owns the spawn lock. */
  owned: boolean;
  pid: number | null;
};

type Spawned = {
  child: ChildProcess;
  config: McpConfig;
  port: number;
  host: string;
  basePath: string;
};

let current: Spawned | null = null;
let lockHeld = false;

function configDir(): string {
  return process.env["LLM_WIKI_CONFIG_DIR"] ?? join(homedir(), ".llm-wiki");
}

function lockPath(): string {
  return join(configDir(), "mcp-supervisor.lock");
}

/**
 * Where the MCP launcher lives, for both layouts this repo has to support:
 *
 *   - workspace / dev: the server runs from the repo, so the package is two
 *     levels up from the app.
 *   - standalone bundle (Docker, `npm install -g`): the app runs as
 *     `<root>/apps/web/server.js` with `cwd` set to `<root>`, and Next copies
 *     the traced workspace packages under `<root>/packages/...`, so the same
 *     relative path still resolves.
 *
 * Returns null when neither exists, which is the signal to report a helpful
 * error instead of spawning something that fails with a module trace.
 */
function resolveLauncher(): string | null {
  const candidates = [
    resolve(process.cwd(), "..", "..", "packages", "mcp", "bin", "llm-wiki-mcp.mjs"),
    resolve(process.cwd(), "packages", "mcp", "bin", "llm-wiki-mcp.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Claims the spawn lock, or reports that another process holds it.
 *
 * `wx` makes the create atomic, so two concurrent requests cannot both win. A
 * lock whose owner is gone is taken over rather than blocking startup forever.
 */
async function acquireLock(): Promise<boolean> {
  const path = lockPath();
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
        encoding: "utf8",
        flag: "wx",
      });
      lockHeld = true;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const owner = await readLockOwner(path);
      if (owner !== null && isProcessAlive(owner)) return false;
      // Stale lock (previous run crashed or was killed).
      await rm(path, { force: true });
    }
  }
  return false;
}

async function readLockOwner(path: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  if (!lockHeld) return;
  lockHeld = false;
  await rm(lockPath(), { force: true }).catch(() => undefined);
}

/**
 * Starts the server if the user has enabled it, and does nothing otherwise.
 *
 * Called from the MCP API routes so that opening Settings → MCP is enough to
 * bring the server up — no separate command, no app restart. Failures are
 * logged rather than thrown: a broken MCP server must not break the settings
 * page that exists to fix it.
 */
export async function startMcpServerIfConfigured(): Promise<void> {
  try {
    await ensureMcpServer();
  } catch (err) {
    console.warn(`[mcp] 启动 MCP 服务失败：${(err as Error).message}`);
  }
}

export type EnsureOptions = {
  /** Force a restart even if the configuration looks unchanged. */
  restart?: boolean;
};

/**
 * Makes the running server match the saved configuration.
 *
 * Called from the MCP API routes, so it runs at most once per request and is a
 * no-op when nothing changed.
 */
export async function ensureMcpServer(options: EnsureOptions = {}): Promise<McpSupervisorStatus> {
  const config = await loadMcpConfig();
  const port = resolvePort();

  if (!config.enabled) {
    await stopMcpServer();
    return { running: false, owned: lockHeld, pid: current?.child.pid ?? null };
  }

  const basePath = process.env["LLM_WIKI_MCP_BASE_PATH"] ?? detectBasePath(resolveWikiPath());
  const host = config.allowRemote ? "0.0.0.0" : "127.0.0.1";

  if (!options.restart && current && current.child.exitCode === null) {
    const unchanged =
      current.port === port &&
      current.host === host &&
      current.basePath === basePath &&
      sameConfig(current.config, config);
    if (unchanged) {
      return { running: await isServerRunning(), owned: true, pid: current.child.pid ?? null };
    }
  }

  if (!(await acquireLock())) {
    // Another process owns the server. Report its state rather than fighting it.
    const beat = await readHeartbeat();
    return { running: await isServerRunning(), owned: false, pid: beat?.pid ?? null };
  }

  await stopMcpServer({ keepLock: true });

  const launcher = resolveLauncher();
  if (!launcher) {
    console.warn("[mcp] 未找到 packages/mcp/bin/llm-wiki-mcp.mjs，无法启动 MCP 服务。");
    await releaseLock();
    return { running: false, owned: false, pid: null };
  }

  const child = spawn(process.execPath, [launcher], {
    // `inherit` keeps the server's startup line in the app's log. Piping would
    // also work, but then nobody reads it and the pipe buffer can fill.
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LLM_WIKI_MCP_PORT: String(port),
      LLM_WIKI_MCP_HOST: host,
      LLM_WIKI_MCP_BASE_PATH: basePath,
      // The server must not inherit the app's forced wiki: it resolves each
      // exposed wiki from the config file instead.
      LLM_WIKI_MCP_FORCE: "1",
    },
    windowsHide: true,
  });

  current = { child, config, port, host, basePath };

  child.on("exit", (code, signal) => {
    if (current?.child === child) current = null;
    if (code !== 0 && signal === null) {
      console.warn(`[mcp] MCP 服务退出，代码 ${code}`);
    }
  });

  // Give it a moment to bind, so the first status read after a toggle is
  // accurate instead of "starting".
  for (let i = 0; i < 20; i++) {
    await delay(100);
    if (await isServerRunning()) break;
  }

  return { running: await isServerRunning(), owned: true, pid: child.pid ?? null };
}

export async function stopMcpServer(options: { keepLock?: boolean } = {}): Promise<void> {
  if (current && current.child.exitCode === null) {
    const child = current.child;
    current = null;
    child.kill("SIGTERM");
    // Escalate if it ignores the signal; a stuck server would hold the port and
    // make the next start fail.
    const killed = await Promise.race([
      new Promise<boolean>((resolvePromise) => child.once("exit", () => resolvePromise(true))),
      delay(2000).then(() => false),
    ]);
    if (!killed) child.kill("SIGKILL");
  }
  if (!options.keepLock) await releaseLock();
}

export async function mcpSupervisorStatus(): Promise<McpSupervisorStatus> {
  const beat = await readHeartbeat();
  return {
    running: await isServerRunning(),
    owned: lockHeld,
    pid: beat?.pid ?? current?.child.pid ?? null,
  };
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LLM_WIKI_MCP_PORT"];
  if (raw === undefined || raw.trim() === "") return 5040;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 5040;
}

/**
 * Path prefix the server must strip to find the wiki root.
 *
 * The app passes the active wiki's directory name, so the Settings page and the
 * server agree on the endpoint even before the user pastes anything. `cwd` is
 * the app root here, not the wiki.
 */
function detectBasePath(wikiPath: string): string {
  const segments = wikiPath.split(/[\\/]+/).filter(Boolean);
  const name = segments[segments.length - 1];
  return name ? `/${name}/` : "/";
}

function sameConfig(a: McpConfig, b: McpConfig): boolean {
  return (
    a.authMode === b.authMode &&
    a.allowRemote === b.allowRemote &&
    a.tokenTtlDays === b.tokenTtlDays &&
    a.exposedWikis.join("\u0000") === b.exposedWikis.join("\u0000") &&
    JSON.stringify(a.tools) === JSON.stringify(b.tools)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
