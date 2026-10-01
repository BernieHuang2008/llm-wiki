#!/usr/bin/env node
// MCP server entry point (stdio transport).
//
// For clients that can only launch a subprocess — the original MCP integration
// shape, and the only one some editors support. stdio carries no HTTP headers,
// so there is no way to present a bearer token: the server trusts the parent
// process, which by construction already has the user's own privileges. That is
// why `authMode` is ignored here rather than enforced.
//
// stdout belongs to the protocol. All logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadMcpConfig } from "../config";
import { registerTools } from "../tools/handlers";
import { toolsForScopes } from "../tools/registry";
import { WikiRegistry } from "../wiki/registry";

async function main(): Promise<void> {
  const config = await loadMcpConfig();
  if (!config.enabled) {
    process.stderr.write("[mcp] 服务未启用（设置 → MCP）。\n");
    process.exit(1);
  }

  const registry = new WikiRegistry(config);
  const allowedTools = toolsForScopes(["wiki:read"]);

  // One server instance for the life of the connection: stdio has exactly one
  // client, so there is nothing to vary per request.
  const server = new McpServer(
    { name: "llm-wiki", version: "1.0.0" },
    {
      instructions:
        "这是 LLM Wiki 的只读知识库接口。先用 wiki_search 定位页面，再用 wiki_read_page 读全文；" +
        "长页面先看 wiki_get_toc，再用 wiki_get_section 只取需要的小节。",
    },
  );
  registerTools(server, { registry, allowedTools, principalLabel: "stdio" });

  await serveStdio(() => server);

  const stop = (): void => {
    registry.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`[mcp] stdio 启动失败：${(err as Error).message}\n`);
  process.exit(1);
});
