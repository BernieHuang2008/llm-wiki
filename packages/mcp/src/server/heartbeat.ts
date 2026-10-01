// Liveness bookkeeping shared with the desktop app.
//
// The app needs to answer "is the MCP server actually up?" for the Settings →
// MCP badge, and the answer has to come from the server itself — the app
// spawns it and would otherwise have to track the child process, which it
// cannot do after its own restart. A heartbeat file is the smallest thing that
// works across both.

import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { mcpConfigDir, writeJsonAtomic } from "../config";

export type McpHeartbeat = {
  pid: number;
  port: number;
  startedAt: string;
  lastSeenAt: string;
};

/** Considered running while the stamp is this fresh. */
export const HEARTBEAT_STALE_MS = 30_000;
const REFRESH_MS = 10_000;

export function heartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${mcpConfigDir(env)}/mcp-heartbeat.json`;
}

export async function writeHeartbeat(
  info: { port: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = heartbeatPath(env);
  await mkdir(dirname(path), { recursive: true });
  const now = new Date().toISOString();
  const existing = await readHeartbeat(env);
  const beat: McpHeartbeat = {
    pid: process.pid,
    port: info.port,
    startedAt: existing?.startedAt ?? now,
    lastSeenAt: now,
  };
  await writeJsonAtomic(path, beat);

  // A single interval is enough; `unref` keeps it from holding the process
  // open, so a crash or a SIGTERM still lets the server exit.
  const timer = setInterval(() => {
    void writeJsonAtomic(path, { ...beat, lastSeenAt: new Date().toISOString() }).catch(() => {
      // A read-only config directory must not take the server down.
    });
  }, REFRESH_MS);
  timer.unref();
}

export async function readHeartbeat(
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpHeartbeat | null> {
  try {
    const raw = await readFile(heartbeatPath(env), "utf8");
    const parsed = JSON.parse(raw) as Partial<McpHeartbeat>;
    if (typeof parsed.lastSeenAt !== "string") return null;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      port: typeof parsed.port === "number" ? parsed.port : 0,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : parsed.lastSeenAt,
      lastSeenAt: parsed.lastSeenAt,
    };
  } catch {
    return null;
  }
}

/** True when a server wrote a heartbeat recently enough to still be alive. */
export async function isServerRunning(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const beat = await readHeartbeat(env);
  if (!beat) return false;
  return Date.now() - Date.parse(beat.lastSeenAt) < HEARTBEAT_STALE_MS;
}

export async function clearHeartbeat(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await unlink(heartbeatPath(env));
  } catch {
    // Already gone.
  }
}
