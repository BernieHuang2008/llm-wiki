// Settings → MCP: token and client management.
//
// POST   create a static bearer token (returns the secret exactly once)
// DELETE revoke one token (`?id=`) or one OAuth client (`?client=`)

import { NextResponse } from "next/server";

import { CredentialStore, loadMcpConfig } from "@llm-wiki/mcp";

export const dynamic = "force-dynamic";

type PostBody = {
  label?: unknown;
  ttlDays?: unknown;
};

export async function POST(req: Request) {
  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    // An empty body is fine: the defaults apply.
  }

  const config = await loadMcpConfig();
  const label = typeof body.label === "string" ? body.label : "MCP client";
  const ttlDays =
    typeof body.ttlDays === "number" && Number.isFinite(body.ttlDays)
      ? Math.max(0, Math.floor(body.ttlDays))
      : config.tokenTtlDays;

  const store = new CredentialStore();
  const created = await store.createStaticToken(label, ttlDays);

  return NextResponse.json({
    id: created.row.id,
    label: created.row.label,
    createdAt: created.row.createdAt,
    expiresAt: created.row.expiresAt,
    // The only time the secret is ever transmitted. It is not recoverable.
    token: created.token,
  });
}

export async function DELETE(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  const clientId = params.get("client");
  if (!id && !clientId) {
    return NextResponse.json({ error: "id 或 client 参数必填" }, { status: 400 });
  }

  const store = new CredentialStore();
  if (clientId) {
    await store.revokeClient(clientId);
  } else if (id) {
    const removed = await store.revokeToken(id);
    if (!removed) return NextResponse.json({ error: "未找到该凭据" }, { status: 404 });
  }

  const summaries = await store.summaries();
  return NextResponse.json({
    ok: true,
    tokens: summaries.tokens,
    oauthClients: summaries.oauthClients,
    sessions: summaries.sessions,
  });
}
