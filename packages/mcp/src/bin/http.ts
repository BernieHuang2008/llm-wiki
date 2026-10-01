#!/usr/bin/env node
// MCP server entry point (HTTP / Streamable HTTP transport).
//
// Started by the desktop app and by the container image. Everything it needs
// comes from the environment, because both callers already know the answers:
//
//   LLM_WIKI_MCP_PORT      port to bind (default 3738)
//   LLM_WIKI_MCP_HOST      interface to bind (default 127.0.0.1, or 0.0.0.0
//                          when the config allows remote access)
//   LLM_WIKI_MCP_BASE_PATH wiki path prefix, for the log line and for clients
//                          that discover the endpoint without the app's help
//   LLM_WIKI_CONFIG_DIR    where mcp.json / mcp-auth.json live

import { loadMcpConfig } from "../config";
import { resolveMcpPort } from "../port";
import { startMcpHttpServer } from "../server/http";
import { clearHeartbeat } from "../server/heartbeat";

async function main(): Promise<void> {
  const config = await loadMcpConfig();
  const port = resolveMcpPort();
  const host = process.env["LLM_WIKI_MCP_HOST"] ?? (config.allowRemote ? "0.0.0.0" : "127.0.0.1");

  if (!config.enabled && process.env["LLM_WIKI_MCP_FORCE"] !== "1") {
    process.stderr.write(
      "[mcp] 服务未启用（设置 → MCP）。设置 LLM_WIKI_MCP_FORCE=1 可强制启动。\n",
    );
    process.exit(0);
  }

  const running = await startMcpHttpServer({ port, host });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[mcp] 收到 ${signal}，正在停止…\n`);
    void running
      .close()
      .then(() => clearHeartbeat())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // The desktop app kills the child on its own exit; without these a detached
  // child could outlive the app and keep holding the wiki's SQLite handle.
  process.on("disconnect", () => shutdown("disconnect"));
}

main().catch((err: unknown) => {
  process.stderr.write(`[mcp] 启动失败：${(err as Error).message}\n`);
  process.exit(1);
});
