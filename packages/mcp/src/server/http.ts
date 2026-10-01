// The MCP HTTP server: protocol endpoint, OAuth authorization server, and the
// discovery documents that let an MCP client find it.
//
// Uses `node:http` directly rather than a framework. The surface is one JSON-RPC
// endpoint plus four OAuth routes, and the SDK already provides the transport
// adapter — a framework would only add a dependency to the container image.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

import { loadMcpConfig } from "../config";
import { CredentialStore } from "../auth/store";
import {
  AuthorizationServer,
  applyOAuthResponse,
  rotateApprovalCode,
  type OAuthResponse,
} from "../auth/oauth";
import { authenticate, type Principal } from "../auth/guard";
import {
  buildResourceIdentifier,
  endpointPathFromHeader,
  resolvePublicBaseUrl,
  wikiBasePathForEndpoint,
} from "../auth/urls";
import { MCP_TOOL_IDS, toolsForScopes } from "../tools/registry";
import { registerTools } from "../tools/handlers";
import type { McpConfig } from "../types";
import { renderStatusPage } from "./html";
import { WikiRegistry } from "../wiki/registry";
import { writeHeartbeat } from "./heartbeat";
import { detectEndpointPath, detectWikiBasePath, normalizeMcpPath } from "../port";

export type StartOptions = {
  port: number;
  host: string;
  /** Overrides the config file, for tests and for the desktop app's dev mode. */
  configOverride?: McpConfig;
};

export type RunningServer = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

export async function startMcpHttpServer(options: StartOptions): Promise<RunningServer> {
  const config = options.configOverride ?? (await loadMcpConfig());
  const store = new CredentialStore();
  const registry = new WikiRegistry(config);

  if (options.configOverride === undefined) {
    // Heartbeat is what tells Settings → MCP that a server is actually up. It
    // is written by the server (not the app) precisely so a "running" badge
    // means something.
    void writeHeartbeat({ port: options.port });
  }

  const mcpHandler = createMcpHandler((ctx) => {
    const principal = ctx.authInfo?.extra?.["principal"] as Principal | undefined;
    // The per-request server instance has to know which URL path it is serving:
    // that path is what selects the wiki (`/research/quantum/mcp`).
    const request = ctx.requestInfo;
    const pathname = request ? new URL(request.url).pathname : "/mcp";
    const mcpPath = request?.headers.get("mcp-path") ?? null;
    const endpointPath = mcpPath ? normalizeMcpPath(mcpPath) : detectEndpointPath(pathname);
    return buildServer(principal, registry, wikiBasePathForEndpoint(endpointPath));
  });

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`请求处理失败：${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: "server_error" }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const baseUrl = resolvePublicBaseUrl(
      req.headers,
      Boolean((req.socket as { encrypted?: boolean }).encrypted),
    );
    const endpointPath = endpointPathFromHeader(req.headers, url.pathname);
    const resourceIdentifier = buildResourceIdentifier(baseUrl, endpointPath);
    const authServer = new AuthorizationServer({
      store,
      config,
      baseUrl,
      endpointPath,
      resourceIdentifier,
    });

    const path = normalize(url.pathname);

    // ---- discovery (unauthenticated by definition) ------------------------
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path.endsWith("/.well-known/oauth-protected-resource")
    ) {
      return send(res, authServer.resourceMetadata());
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return send(res, authServer.metadata());
    }

    // ---- OAuth endpoints --------------------------------------------------
    if (path === "/oauth/register" && req.method === "POST") {
      return send(res, await authServer.register(req));
    }
    if (path === "/oauth/authorize" && req.method === "GET") {
      return send(res, await authServer.authorize(req, url));
    }
    if (path === "/oauth/approve" && req.method === "POST") {
      return send(res, await authServer.approve(req));
    }
    if (path === "/oauth/token" && req.method === "POST") {
      return send(res, await authServer.token(req));
    }
    if (path === "/oauth/revoke" && req.method === "POST") {
      return send(res, await authServer.revoke(req));
    }

    // ---- health ------------------------------------------------------------
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          enabled: config.enabled,
          tools: MCP_TOOL_IDS.filter((id) => config.tools[id]),
          wikis: registry.listWikis().map((w) => w.name),
          authMode: config.authMode,
        }),
      );
      return;
    }

    // ---- MCP protocol ------------------------------------------------------
    if (path === endpointPath) {
      return handleMcp(req, res, baseUrl, endpointPath);
    }

    // A browser opened the origin, or an MCP client used an unexpected path.
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        renderStatusPage({
          endpointUrl: resourceIdentifier,
          enabledTools: MCP_TOOL_IDS.filter((id) => config.tools[id]),
          authMode: config.authMode,
          running: config.enabled,
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `未找到 ${url.pathname}。\nMCP 端点是 ${endpointPath}（例如 ${resourceIdentifier}）。\n`,
    );
  }

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    baseUrl: string,
    endpointPath: string,
  ): Promise<void> {
    if (!config.enabled) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({ error: "mcp_disabled", error_description: "MCP 服务已在设置中关闭。" }),
      );
      return;
    }

    const auth = await authenticate(req, config, store, baseUrl);
    if (!auth.ok) {
      res.writeHead(auth.status, auth.headers);
      res.end(auth.body);
      return;
    }

    const request = toWebRequest(req, baseUrl, endpointPath);
    const response = await mcpHandler.fetch(request, {
      authInfo: {
        // The SDK treats `token` as opaque and only re-checks the expiry; the
        // real credential never leaves the store.
        token: "",
        clientId: auth.principal.label,
        scopes: auth.principal.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { principal: auth.principal },
      },
    });
    await sendNodeResponse(res, response);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  log(`MCP 服务已启动：http://${options.host}:${options.port}${detectWikiBasePath()}mcp`);
  log(`工具：${MCP_TOOL_IDS.filter((id) => config.tools[id]).join(", ") || "（无）"}`);
  log(`认证：${config.authMode}${config.allowRemote ? "（允许远程）" : "（仅本机）"}`);
  if (config.authMode === "oauth" && config.exposedWikis.length > 0) {
    const code = await rotateApprovalCode(store);
    log(`首次授权批准码：${code}（30 分钟内有效，也可在设置页重新生成）`);
  }

  return {
    server: httpServer,
    port: options.port,
    close: async () => {
      registry.closeAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Builds a per-request server instance: tool visibility is per credential. */
function buildServer(
  principal: Principal | undefined,
  registry: WikiRegistry,
  basePath: string,
): McpServer {
  const server = new McpServer(
    { name: "llm-wiki", version: "1.0.0" },
    {
      instructions:
        "这是 LLM Wiki 的只读知识库接口。先用 wiki_search 定位页面，再用 wiki_read_page 读全文；" +
        "长页面先看 wiki_get_toc，再用 wiki_get_section 只取需要的小节，以节省 token。" +
        "引用内容时请用 [[slug]] 标注来源页面。",
    },
  );

  registerTools(server, {
    registry,
    allowedTools: principal?.allowedTools ?? toolsForScopes(["wiki:read"]),
    principalLabel: principal?.label ?? "unknown",
    basePath,
  });
  return server;
}

// ---- helpers ---------------------------------------------------------------

function send(res: ServerResponse, result: OAuthResponse): void {
  applyOAuthResponse(res, result);
}

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** Node request → web-standard Request, which is what the SDK handler takes. */
function toWebRequest(req: IncomingMessage, baseUrl: string, endpointPath: string): Request {
  const url = new URL(req.url ?? endpointPath, baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    // Required by undici whenever a Request carries a stream body.
    duplex: "half",
  } as RequestInit);
}

async function sendNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
  res.end();
}

function log(message: string): void {
  // stdout is reserved for the stdio transport (dist/stdio.js). Logging there
  // would corrupt the protocol framing for a client that pipes it.
  process.stderr.write(`[mcp] ${message}\n`);
}
