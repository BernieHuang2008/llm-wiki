// Read/write of `~/.llm-wiki/mcp.json` — the MCP server's own configuration.
//
// Dependency-free by design (see types.ts): `apps/web` bundles this module, so
// it may only use `node:*` builtins.
//
// The file lives in the *global* config directory, not inside a wiki folder,
// for two reasons:
//   1. One MCP server serves one process. Splitting "which tools" across
//      several wikis would mean a client's permissions depended on which wiki
//      the desktop app happened to have active, which is not a thing a user
//      can reason about.
//   2. `.llm-wiki/mcp.json` inside a wiki folder is committable by design
//      (docs/03), and this file will hold credential material once OAuth is
//      enabled. Credentials must never be committable.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { MCP_TOOL_IDS, isMcpToolId } from "./tools/registry";
import {
  DEFAULT_MCP_CONFIG,
  MCP_AUTH_MODES,
  MCP_CONFIG_FILENAME,
  type McpAuthMode,
  type McpConfig,
  type McpConfigPatch,
  type McpToolAccess,
} from "./types";

export function mcpConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["LLM_WIKI_CONFIG_DIR"] ?? join(homedir(), ".llm-wiki");
}

export function mcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpConfigDir(env), MCP_CONFIG_FILENAME);
}

export function defaultMcpConfig(): McpConfig {
  return { ...DEFAULT_MCP_CONFIG, tools: { ...DEFAULT_MCP_CONFIG.tools } };
}

function parseTools(raw: unknown): McpToolAccess {
  const tools: McpToolAccess = { ...DEFAULT_MCP_CONFIG.tools };
  if (typeof raw !== "object" || raw === null) return tools;
  const data = raw as Record<string, unknown>;
  for (const id of MCP_TOOL_IDS) {
    // Unknown keys are ignored rather than rejected: a config written by a
    // newer build must still load on an older one instead of wiping the file.
    const value = data[id];
    if (typeof value === "boolean") tools[id] = value;
  }
  return tools;
}

function parseConfig(raw: unknown): McpConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultMcpConfig();
  }
  const data = raw as Record<string, unknown>;
  const out = defaultMcpConfig();

  if (typeof data["enabled"] === "boolean") out.enabled = data["enabled"];
  if (Array.isArray(data["exposedWikis"])) {
    out.exposedWikis = dedupePaths(
      data["exposedWikis"].filter((v): v is string => typeof v === "string"),
    );
  }
  const authMode = data["authMode"];
  if (typeof authMode === "string" && MCP_AUTH_MODES.includes(authMode as McpAuthMode)) {
    out.authMode = authMode as McpAuthMode;
  }
  if (typeof data["allowRemote"] === "boolean") out.allowRemote = data["allowRemote"];
  if (typeof data["tokenTtlDays"] === "number" && Number.isFinite(data["tokenTtlDays"])) {
    out.tokenTtlDays = clampTokenTtl(data["tokenTtlDays"]);
  }
  out.tools = parseTools(data["tools"]);
  return out;
}

export const MIN_TOKEN_TTL_DAYS = 0;
export const MAX_TOKEN_TTL_DAYS = 3650;

export function clampTokenTtl(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_MCP_CONFIG.tokenTtlDays;
  return Math.min(MAX_TOKEN_TTL_DAYS, Math.max(MIN_TOKEN_TTL_DAYS, Math.floor(days)));
}

export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (trimmed.length === 0) continue;
    // Windows paths are case-insensitive; POSIX ones are not. Normalising here
    // keeps a duplicated entry from showing up twice in the UI.
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export async function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): Promise<McpConfig> {
  const path = mcpConfigPath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultMcpConfig();
    throw err;
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch {
    // A corrupt config must not brick the settings page — the user needs the
    // page to fix it. Fall back to defaults and leave the file untouched so
    // they can inspect it by hand.
    return defaultMcpConfig();
  }
}

export async function saveMcpConfig(
  config: McpConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = mcpConfigDir(env);
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(mcpConfigPath(env), config);
}

/**
 * Applies a partial patch and returns the merged config.
 *
 * Field-by-field, so a stale tab that only knows about `tools` cannot clobber
 * `exposedWikis` written by another tab. Same contract as `/api/settings`.
 */
export async function patchMcpConfig(
  patch: McpConfigPatch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfig> {
  const current = await loadMcpConfig(env);
  const next: McpConfig = { ...current, tools: { ...current.tools } };

  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.allowRemote === "boolean") next.allowRemote = patch.allowRemote;
  if (typeof patch.tokenTtlDays === "number") next.tokenTtlDays = clampTokenTtl(patch.tokenTtlDays);
  if (typeof patch.authMode === "string" && MCP_AUTH_MODES.includes(patch.authMode)) {
    next.authMode = patch.authMode;
  }
  if (Array.isArray(patch.exposedWikis)) {
    next.exposedWikis = dedupePaths(
      patch.exposedWikis.filter((v): v is string => typeof v === "string"),
    );
  }
  if (patch.tools !== undefined && patch.tools !== null) {
    for (const [key, value] of Object.entries(patch.tools)) {
      if (isMcpToolId(key) && typeof value === "boolean") next.tools[key] = value;
    }
  }

  await saveMcpConfig(next, env);
  return next;
}

/**
 * Write-then-rename. A crash mid-write leaves the previous file intact, which
 * matters because this file holds credential material: a truncated JSON file
 * would otherwise silently invalidate every issued token.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export function authStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpConfigDir(env), "mcp-auth.json");
}
