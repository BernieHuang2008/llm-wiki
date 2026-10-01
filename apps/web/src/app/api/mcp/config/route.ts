// Settings → MCP: read and write `/api/mcp/config`.

import { NextResponse } from "next/server";

import {
  CredentialStore,
  loadMcpConfig,
  mcpConfigPath,
  MCP_TOOL_IDS,
  patchMcpConfig,
  rotateApprovalCode,
  SCOPE_ALL,
  SUPPORTED_SCOPES,
  toolsForScopes,
  type McpAuthMode,
  type McpConfigPatch,
} from "@llm-wiki/mcp";

import { mcpSupervisorStatus, resolvePort, startMcpServerIfConfigured } from "@/lib/server-mcp";
import { resolveWikiPath } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

const AUTH_MODES: readonly McpAuthMode[] = ["none", "bearer", "oauth"];

export async function GET() {
  // Opening this tab is what starts the server, so the URL it displays is
  // immediately usable instead of requiring a second visit.
  void startMcpServerIfConfigured();

  const config = await loadMcpConfig();
  const store = new CredentialStore();
  const [summaries, status] = await Promise.all([store.summaries(), mcpSupervisorStatus()]);

  return NextResponse.json({
    config,
    port: resolvePort(),
    toolIds: MCP_TOOL_IDS,
    scopes: SUPPORTED_SCOPES,
    allScope: SCOPE_ALL,
    tokens: summaries.tokens,
    oauthClients: summaries.oauthClients,
    sessions: summaries.sessions,
    running: status.running,
    pid: status.pid,
    owned: status.owned,
    configPath: mcpConfigPath(),
    wikiPath: resolveWikiPath(),
    /** The seven tools the shipped default enables; used by "restore defaults". */
    defaultTools: toolsForScopes([SCOPE_ALL]),
  });
}

type PutBody = McpConfigPatch;

export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }

  if (body.authMode !== undefined && !AUTH_MODES.includes(body.authMode)) {
    return NextResponse.json(
      { error: `未知的认证方式：${String(body.authMode)}` },
      { status: 400 },
    );
  }

  const config = await patchMcpConfig(body);
  const status = await mcpSupervisorStatus();

  return NextResponse.json({ ok: true, config, running: status.running, pid: status.pid });
}

/**
 * Regenerates the one-time approval code shown on this tab.
 *
 * POST rather than part of GET because the clear-text code must not end up in a
 * response body that anything might cache — and because the user asks for it
 * explicitly, right before pasting it into the approval page.
 */
export async function POST() {
  const store = new CredentialStore();
  const code = await rotateApprovalCode(store);
  const summaries = await store.summaries();
  return NextResponse.json({
    approvalCode: code,
    sessions: summaries.sessions,
  });
}
