// OAuth 2.1 authorization server for the MCP endpoint.
//
// The MCP spec points an Authorization Server at any OAuth AS that speaks
// authorization-code + PKCE. The desktop app has exactly one user and its own
// UI, so standing up a separate identity provider would be theatre; this module
// implements the parts an MCP client actually exercises:
//
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
//   POST /oauth/register                           RFC 7591 dynamic registration
//   GET  /oauth/authorize                          consent, then redirect with code
//   POST /oauth/approve                            the consent form's target
//   POST /oauth/token                              code / refresh exchange
//   POST /oauth/revoke                             RFC 7009
//
// Deliberately *not* implemented: client secrets (public clients only — a
// desktop client cannot keep one), implicit flow, and password grants. Access
// tokens are opaque, hashed at rest and revocable, which is worth more here
// than a JWT that cannot be withdrawn.

import type { IncomingMessage } from "node:http";

import { MCP_TOOLS, SCOPE_ALL, SUPPORTED_SCOPES, type McpToolId } from "../tools/registry";
import type { McpConfig } from "../types";
import { renderApprovalPage } from "../server/html";
import { randomApprovalCode, verifyPkce } from "./crypto";
import { SESSION_COOKIE, checkSession, readCookie } from "./guard";
import { CredentialStore, SESSION_TTL_MS } from "./store";

export type AuthorizationServerOptions = {
  store: CredentialStore;
  config: McpConfig;
  /** Public base URL as the client reached it. */
  baseUrl: string;
  /** Endpoint path, e.g. `/mcp`. */
  endpointPath: string;
  resourceIdentifier: string;
};

export type OAuthResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Issues a fresh approval code and returns it in clear text, once. */
export async function rotateApprovalCode(store: CredentialStore): Promise<string> {
  const code = randomApprovalCode();
  await store.setApprovalCode(code);
  return code;
}

export function buildAuthorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
  };
}

export function buildProtectedResourceMetadata(
  baseUrl: string,
  resourceIdentifier: string,
): Record<string, unknown> {
  return {
    resource: resourceIdentifier,
    resource_name: "LLM Wiki",
    authorization_servers: [baseUrl],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    // Legacy clients ignore `authorization_servers` and read these directly
    // from the resource metadata document.
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
  };
}

type AuthorizeParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  scope: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
};

export class AuthorizationServer {
  constructor(private readonly options: AuthorizationServerOptions) {}

  private get store(): CredentialStore {
    return this.options.store;
  }

  metadata(): OAuthResponse {
    return json(200, buildAuthorizationServerMetadata(this.options.baseUrl));
  }

  resourceMetadata(): OAuthResponse {
    return json(
      200,
      buildProtectedResourceMetadata(this.options.baseUrl, this.options.resourceIdentifier),
    );
  }

  /** RFC 7591 dynamic client registration (public clients). */
  async register(req: IncomingMessage): Promise<OAuthResponse> {
    const body = await readForm(req);
    const redirectUris = parseRedirectUris(body);
    if (redirectUris.length === 0) {
      return json(400, {
        error: "invalid_redirect_uri",
        error_description: "At least one redirect_uri is required.",
      });
    }
    const client = await this.store.registerClient(
      body["client_name"] ?? "MCP client",
      redirectUris,
    );
    return json(201, {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SUPPORTED_SCOPES.join(" "),
      client_id_issued_at: Math.floor(Date.parse(client.registeredAt) / 1000),
    });
  }

  /** `GET /oauth/authorize` — the entry point a browser is redirected to. */
  async authorize(req: IncomingMessage, url: URL): Promise<OAuthResponse> {
    const params = validateParams(Object.fromEntries(url.searchParams.entries()));
    if (typeof params === "string") return html(400, renderApprovalError(params));

    const client = await this.store.getClient(params.clientId);
    if (!client) {
      return html(400, renderApprovalError(`未知的客户端 ID：${params.clientId}。`));
    }
    if (!client.redirectUris.includes(params.redirectUri)) {
      return html(400, renderApprovalError("回调地址与注册信息不一致，已拒绝该请求。"));
    }
    return this.consentResponse(req, params, client.clientName, undefined);
  }

  /**
   * `POST /oauth/approve` — the consent form's target. Three outcomes:
   * back to the consent page (code missing/wrong, no tool selected), a
   * `access_denied` redirect, or a redirect carrying the authorization code.
   */
  async approve(req: IncomingMessage): Promise<OAuthResponse> {
    const body = await readForm(req);
    const params = validateParams(body);
    if (typeof params === "string") return html(400, renderApprovalError(params));

    const client = await this.store.getClient(params.clientId);
    if (!client || !client.redirectUris.includes(params.redirectUri)) {
      return html(400, renderApprovalError("客户端或回调地址无效，已拒绝该请求。"));
    }

    const session = await checkSession(readCookie(req, SESSION_COOKIE), this.store);
    const submitted = (body["approval_code"] ?? "").trim();

    if (!session.ok) {
      if (submitted === "") {
        return this.consentResponse(req, params, client.clientName, "请输入批准码。");
      }
      if (!(await this.store.checkApprovalCode(submitted))) {
        // Deliberately vague: distinguishing "no code set" from "wrong code"
        // tells an attacker whether guessing is worth continuing.
        return this.consentResponse(req, params, client.clientName, "批准码不正确或已过期。");
      }
      await this.store.clearApprovalCode();
    }

    if (body["decision"] === "deny") {
      return redirectTo(
        params.redirectUri,
        {
          error: "access_denied",
          error_description: "The user denied the request.",
        },
        params.state,
      );
    }

    const chosen = this.chosenTools(body, params.scope);
    if (chosen.length === 0) {
      return this.consentResponse(req, params, client.clientName, "请至少选择一个工具。");
    }

    const code = await this.store.createCode({
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      scopes: params.scope,
      tools: chosen,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      resource: params.resource,
    });

    const headers: Record<string, string> = {};
    if (!session.ok) {
      // The session cookie is what makes the *next* client this browser adds
      // skip the code step. The code exists to bootstrap trust in a browser the
      // server has never seen.
      const secret = await this.store.issueToken({
        kind: "session",
        clientId: params.clientId,
        label: client.clientName,
        scopes: params.scope,
        tools: chosen,
        ttlDays: Math.round(SESSION_TTL_MS / (24 * 60 * 60 * 1000)),
      });
      headers["set-cookie"] =
        `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(SESSION_TTL_MS / 1000)}`;
    }

    const redirect = redirectTo(params.redirectUri, { code }, params.state);
    return { ...redirect, headers: { ...redirect.headers, ...headers } };
  }

  /** `POST /oauth/token` — authorization_code and refresh_token grants. */
  async token(req: IncomingMessage): Promise<OAuthResponse> {
    const body = await readForm(req);
    const grantType = body["grant_type"] ?? "";

    if (grantType === "authorization_code") {
      const code = body["code"] ?? "";
      if (code === "") {
        return json(400, { error: "invalid_request", error_description: "code is required" });
      }
      const row = await this.store.consumeCode(code);
      if (!row) {
        return json(400, {
          error: "invalid_grant",
          error_description: "Unknown or already-used authorization code.",
        });
      }
      if (Date.parse(row.expiresAt) <= Date.now()) {
        return json(400, { error: "invalid_grant", error_description: "The code has expired." });
      }
      if (body["redirect_uri"] && body["redirect_uri"] !== row.redirectUri) {
        return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch." });
      }
      const verifier = body["code_verifier"] ?? "";
      if (verifier === "" || !verifyPkce(row.codeChallenge, row.codeChallengeMethod, verifier)) {
        return json(400, {
          error: "invalid_grant",
          error_description: "PKCE verification failed.",
        });
      }
      return this.issuePair({
        clientId: row.clientId,
        scopes: row.scopes,
        tools: row.tools,
      });
    }

    if (grantType === "refresh_token") {
      const presented = body["refresh_token"] ?? "";
      if (presented === "") {
        return json(400, {
          error: "invalid_request",
          error_description: "refresh_token is required",
        });
      }
      const row = await this.store.findToken(presented, ["refresh"]);
      if (!row) {
        return json(400, {
          error: "invalid_grant",
          error_description: "Unknown or expired refresh token.",
        });
      }
      // Rotate: an old refresh token stops working the moment a new one is
      // issued, so a stolen copy has a bounded window.
      await this.store.revokeToken(row.id);
      return this.issuePair({
        clientId: row.clientId ?? "",
        scopes: row.scopes,
        tools: row.tools,
      });
    }

    return json(400, {
      error: "unsupported_grant_type",
      error_description: "Only authorization_code and refresh_token are supported.",
    });
  }

  /** RFC 7009 revocation. Always answers 200, as the spec requires. */
  async revoke(req: IncomingMessage): Promise<OAuthResponse> {
    const body = await readForm(req);
    const token = body["token"] ?? "";
    if (token !== "") await this.store.revokeBySecret(token);
    return { status: 200, headers: { "content-type": "application/json" }, body: "" };
  }

  /** Revokes a client and every credential it holds. Used by Settings → MCP. */
  async revokeClient(clientId: string): Promise<boolean> {
    return this.store.revokeClient(clientId);
  }

  // ---- internals ----------------------------------------------------------

  private async issuePair(row: {
    clientId: string;
    scopes: string[];
    tools: string[];
  }): Promise<OAuthResponse> {
    const client = row.clientId ? await this.store.getClient(row.clientId) : null;
    const label = client?.clientName ?? "MCP client";
    const ttlDays = this.options.config.tokenTtlDays;

    const accessToken = await this.store.issueToken({
      kind: "access",
      clientId: row.clientId || null,
      label,
      scopes: row.scopes,
      tools: row.tools,
      ttlDays,
    });
    const refreshToken = await this.store.issueToken({
      kind: "refresh",
      clientId: row.clientId || null,
      label,
      scopes: row.scopes,
      tools: row.tools,
      // A refresh token must outlive the access token it renews, otherwise the
      // client silently loses access while the user believes it is connected.
      ttlDays: ttlDays > 0 ? Math.max(ttlDays, 30) : 0,
    });

    return json(200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ttlDays > 0 ? ttlDays * 24 * 60 * 60 : undefined,
      refresh_token: refreshToken,
      scope: row.scopes.join(" "),
    });
  }

  /** Renders the code prompt or the tool picker, depending on the session. */
  private consentResponse(
    req: IncomingMessage,
    params: AuthorizeParams,
    clientName: string,
    error: string | undefined,
  ): OAuthResponse {
    const hasSession = readCookie(req, SESSION_COOKIE) !== null;
    const grantedScopes = scopeTools(params.scope);
    const htmlBody = renderApprovalPage({
      step: hasSession ? "consent" : "code",
      clientName,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      requestedScopes: params.scope,
      tools: MCP_TOOLS.map((tool) => ({
        id: tool.id,
        label: tool.label,
        summary: tool.summary,
        checked: grantedScopes.includes(tool.id) && this.options.config.tools[tool.id],
      })),
      params: formParams(params),
      ...(error ? { error } : {}),
    });
    return html(200, htmlBody);
  }

  private chosenTools(body: Record<string, string>, scopes: string[]): McpToolId[] {
    const raw = body["tool"];
    // No `tool` field at all means the client asked for a scope set and the
    // user did not narrow it; fall back to that scope's own tool list.
    const candidates =
      raw === undefined
        ? scopeTools(scopes)
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is McpToolId => MCP_TOOLS.some((t) => t.id === s));
    // Intersect with the Settings switches: a tool switched off in the UI must
    // not become grantable through the consent screen.
    return candidates.filter((id) => this.options.config.tools[id]);
  }
}

/** Tools a scope set unlocks, honouring `wiki:read` as "everything". */
export function scopeTools(scopes: string[]): McpToolId[] {
  if (scopes.includes(SCOPE_ALL)) return MCP_TOOLS.map((t) => t.id);
  const wanted = new Set(scopes.map((s) => s.slice("wiki:".length).replace(/-/g, "_")));
  return MCP_TOOLS.map((t) => t.id).filter((id) => wanted.has(id.slice("wiki_".length)));
}

function formParams(params: AuthorizeParams): Record<string, string> {
  return {
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    ...(params.state ? { state: params.state } : {}),
    scope: params.scope.join(" "),
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    ...(params.resource ? { resource: params.resource } : {}),
  };
}

function parseScopes(raw: string | null): string[] {
  const requested = (raw ?? "").trim();
  if (requested === "") return [SCOPE_ALL];
  const known = new Set(SUPPORTED_SCOPES);
  const accepted = requested.split(/\s+/).filter((s) => known.has(s));
  return accepted.length > 0 ? accepted : [SCOPE_ALL];
}

/** `string` is an error message; `AuthorizeParams` is success. */
function validateParams(raw: Record<string, string | undefined>): AuthorizeParams | string {
  const responseType = raw["response_type"] ?? "code";
  if (responseType !== "code") {
    return "不支持的 response_type，仅支持 response_type=code。";
  }
  const clientId = raw["client_id"] ?? "";
  if (clientId === "") return "缺少 client_id。";
  const redirectUri = raw["redirect_uri"] ?? "";
  if (redirectUri === "") return "缺少 redirect_uri。";
  const codeChallenge = raw["code_challenge"] ?? "";
  if (codeChallenge === "") return "缺少 code_challenge：本服务要求 PKCE。";
  const codeChallengeMethod = raw["code_challenge_method"] ?? "S256";
  if (codeChallengeMethod !== "S256" && codeChallengeMethod !== "plain") {
    return "不支持的 code_challenge_method，仅支持 S256。";
  }
  return {
    responseType,
    clientId,
    redirectUri,
    state: raw["state"] ?? null,
    scope: parseScopes(raw["scope"] ?? null),
    codeChallenge,
    codeChallengeMethod,
    resource: raw["resource"] ?? null,
  };
}

function parseRedirectUris(body: Record<string, string>): string[] {
  const single = body["redirect_uris"] ?? body["redirect_uri"] ?? "";
  return single
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s === "") return false;
      try {
        const url = new URL(s);
        // Loopback is how native clients come back; a custom scheme
        // (`vscode://`, `cursor://`) is the other supported shape.
        return url.protocol.length > 1;
      } catch {
        return false;
      }
    });
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] ?? "";
  const out: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
        else if (Array.isArray(value))
          out[key] = value.filter((v) => typeof v === "string").join(",");
        else if (value !== null && value !== undefined) out[key] = String(value);
      }
      return out;
    } catch {
      return {};
    }
  }

  const params = new URLSearchParams(raw);
  for (const [key, value] of params) out[key] = value;
  // Repeated `tool` checkboxes: keep every value, comma-joined.
  const tools = params.getAll("tool");
  if (tools.length > 0) out["tool"] = tools.join(",");
  return out;
}

function redirectTo(
  redirectUri: string,
  params: Record<string, string>,
  state: string | null,
): OAuthResponse {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state) url.searchParams.set("state", state);
  return {
    status: 302,
    headers: { location: url.toString(), "cache-control": "no-store" },
    body: "",
  };
}

function json(status: number, body: Record<string, unknown>): OAuthResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function html(status: number, body: string): OAuthResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body,
  };
}

function renderApprovalError(message: string): string {
  return renderApprovalPage({
    step: "code",
    clientName: "—",
    clientId: "—",
    redirectUri: "—",
    requestedScopes: [],
    tools: [],
    params: {},
    error: message,
  });
}

/** Writes a response produced by the authorization server. */
export function applyOAuthResponse(
  res: import("node:http").ServerResponse,
  result: OAuthResponse,
): void {
  if (result.status === 0) return;
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}
