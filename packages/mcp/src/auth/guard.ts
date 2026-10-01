// Tool-facing view of the credential store: turn an incoming HTTP request into
// a `McpPrincipal`, or into the OAuth challenge the client needs to start the
// authorization flow.
//
// Deliberately independent of the MCP SDK so the rules can be unit-tested and
// reviewed on their own. `server.ts` feeds the resulting principal into the SDK's
// tool handlers.

import type { IncomingMessage } from "node:http";

import type { McpConfig } from "../types";
import { SCOPE_ALL, toolsForScopes, type McpToolId } from "../tools/registry";
import { CredentialStore } from "./store";
import { buildResourceMetadataUrl } from "./urls";

export type AuthOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; status: number; headers: Record<string, string>; body: string };

export type Principal = {
  label: string;
  kind: "token" | "oauth" | "none";
  scopes: string[];
  allowedTools: McpToolId[];
  /** Present so the tool layer can stamp `lastUsedAt` without a second lookup. */
  tokenId: string | null;
};

export const SESSION_COOKIE = "llm_wiki_mcp_session";

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function readBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Is this connection allowed to skip credentials?
 *
 * Loopback only. A request that arrives through a proxy is *not* loopback even
 * though it may look local: `req.socket.remoteAddress` is the proxy's.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/** Advertised to a client that must authenticate: RFC 9728 discovery. */
function challenge(config: McpConfig, baseUrl: string, error?: string): AuthOutcome {
  const resourceMetadataUrl = buildResourceMetadataUrl(baseUrl);
  const params = [`realm="llm-wiki-mcp"`, `resource_metadata="${resourceMetadataUrl}"`];
  if (error) params.push(`error="${error}"`);
  return {
    ok: false,
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer ${params.join(", ")}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      error: error ?? "invalid_token",
      error_description: "Provide an OAuth access token or a static MCP token.",
      resource_metadata: resourceMetadataUrl,
    }),
  };
}

/**
 * Resolves the principal for one request.
 *
 * `none` mode still refuses remote traffic unless `allowRemote` is set — the
 * mode is "no credential on this machine", not "no security".
 */
export async function authenticate(
  req: IncomingMessage,
  config: McpConfig,
  store: CredentialStore,
  baseUrl: string,
): Promise<AuthOutcome> {
  const bearer = readBearer(req);

  if (bearer) {
    const row = await store.findToken(bearer, ["static", "access"]);
    if (!row) return challenge(config, baseUrl, "invalid_token");
    // A static token carries no scopes of its own; it is a full grant by
    // definition, which is what makes it the escape hatch for clients that
    // cannot run the OAuth flow.
    const scopes = row.kind === "static" ? [SCOPE_ALL] : row.scopes;
    const allowedTools =
      row.kind === "static" ? toolsForScopes(scopes) : intersectTools(config, row.tools, scopes);
    if (row.kind === "access" && allowedTools.length === 0) {
      return challenge(config, baseUrl, "insufficient_scope");
    }
    store.touchToken(row.id);
    return {
      ok: true,
      principal: {
        label: row.label,
        kind: row.kind === "static" ? "token" : "oauth",
        scopes,
        allowedTools,
        tokenId: row.id,
      },
    };
  }

  // Unauthenticated access is permitted only from this machine, and only while
  // the deployment has not opted into remote traffic. Binding to 0.0.0.0 (a
  // container) must not silently turn the wiki into a public endpoint.
  if (config.authMode === "none" && isLoopback(req) && !config.allowRemote) {
    return {
      ok: true,
      principal: {
        label: "本机未认证访问",
        kind: "none",
        scopes: [SCOPE_ALL],
        allowedTools: toolsForScopes([SCOPE_ALL]),
        tokenId: null,
      },
    };
  }

  return challenge(config, baseUrl);
}

/**
 * Tools a token may actually call: the OAuth grant, narrowed by the switches in
 * Settings. Both have to say yes — revoking a tool in the UI must take effect
 * immediately, without waiting for the client to re-authorize.
 */
export function intersectTools(
  config: McpConfig,
  granted: string[],
  scopes: string[],
): McpToolId[] {
  const byScope = new Set(toolsForScopes(scopes));
  const byGrant = granted.length > 0 ? new Set(granted as McpToolId[]) : byScope;
  return toolsForScopes([SCOPE_ALL]).filter(
    (id) => byScope.has(id) && byGrant.has(id) && config.tools[id],
  );
}

/** The session cookie proves the user approved a client in this browser. */
export async function checkSession(
  cookieValue: string | null,
  store: CredentialStore,
): Promise<{ ok: true; label: string } | { ok: false }> {
  if (!cookieValue) return { ok: false };
  const row = await store.findToken(cookieValue, ["session"]);
  if (!row) return { ok: false };
  store.touchToken(row.id);
  return { ok: true, label: row.label };
}
