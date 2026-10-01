#!/usr/bin/env node
// Launcher for the MCP server.
//
// The server itself is a bundle (`dist/index.js`) because the shared workspace
// packages ship TypeScript source, which plain `node` cannot import. This
// launcher exists so the desktop app, the container and a curious user all
// start the server the same way, and so a missing build produces a sentence
// instead of a module-resolution stack trace.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = join(PACKAGE_DIR, "dist", "index.js");
const HTTP_ENTRY = join(PACKAGE_DIR, "dist", "server.js");
const STDIO_ENTRY = join(PACKAGE_DIR, "dist", "stdio.js");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`llm-wiki-mcp — LLM Wiki 的 MCP 服务

用法：
  llm-wiki-mcp                 启动 HTTP (Streamable HTTP) 服务
  llm-wiki-mcp stdio           以 stdio 方式运行（客户端自行拉起子进程）
  llm-wiki-mcp config          打印配置路径、端口与 MCP 地址
  llm-wiki-mcp port            只打印端口号

环境变量：
  LLM_WIKI_MCP_PORT       监听端口（默认 5040）
  LLM_WIKI_MCP_HOST       绑定地址（默认 127.0.0.1）
  LLM_WIKI_MCP_BASE_PATH  知识库路径前缀，用于拼接 MCP 地址
  LLM_WIKI_CONFIG_DIR     配置目录（默认 ~/.llm-wiki）
  LLM_WIKI_MCP_FORCE=1    即使设置里未启用也强制启动
`);
  process.exit(0);
}

if (!existsSync(LIBRARY)) {
  process.stderr.write(
    `[mcp] 未找到构建产物 ${LIBRARY}\n` + `[mcp] 请先运行：pnpm --filter @llm-wiki/mcp build\n`,
  );
  process.exit(1);
}

const subcommand = args[0] ?? "start";

// `config` and `port` load the library bundle so there is exactly one
// implementation of "where does the port come from".
if (subcommand === "config" || subcommand === "port") {
  const mod = await import(pathToFileURL(LIBRARY).href);
  const port = mod.resolveMcpPort();
  if (subcommand === "port") {
    process.stdout.write(`${port}\n`);
    process.exit(0);
  }
  const config = await mod.loadMcpConfig();
  const basePath = mod.detectWikiBasePath();
  process.stdout.write(
    [
      `配置目录: ${mod.mcpConfigDir()}`,
      `配置文件: ${mod.mcpConfigPath()}`,
      `凭据文件: ${mod.authStorePath()}`,
      `端口: ${port}`,
      `MCP 地址: http://<当前域名>:${port}${basePath}mcp`,
      `启用: ${config.enabled ? "是" : "否"}`,
      `认证: ${config.authMode}`,
      `开放知识库: ${config.exposedWikis.join(", ") || "（无）"}`,
      `启用工具: ${mod.MCP_TOOL_IDS.filter((id) => config.tools[id]).join(", ") || "（无）"}`,
    ].join("\n") + "\n",
  );
  process.exit(0);
}

const entry = subcommand === "stdio" ? STDIO_ENTRY : HTTP_ENTRY;
if (!existsSync(entry)) {
  process.stderr.write(`[mcp] 未找到 ${entry}，请先构建。\n`);
  process.exit(1);
}

// `stdio` must inherit all three streams: stdout carries the protocol. The HTTP
// mode also inherits so the app's log shows the server's startup line.
const child = spawn(process.execPath, [entry], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
