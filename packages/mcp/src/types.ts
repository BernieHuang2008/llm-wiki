// Public types for the MCP integration.
//
// Deliberately dependency-free: `apps/web` imports this module (through
// `@llm-wiki/mcp/config`) into Next's server bundle, and the MCP SDK must not
// be dragged along with it.

import type { McpToolId } from "./tools/registry";

/**
 * How a client proves it may call a tool.
 *
 * - `none`   — no credential. Only accepted from loopback unless
 *              `allowRemote` is on; the honest setting for a desktop-only app.
 * - `bearer` — long-lived static tokens created in Settings → MCP. Covers
 *              clients that only speak a static header, which today is most of
 *              them.
 * - `oauth`  — OAuth 2.1 authorization-code + PKCE, RFC 9728 protected
 *              resource metadata and RFC 7591 dynamic client registration.
 *              Static bearer tokens keep working in this mode so existing
 *              clients are not broken by turning OAuth on.
 */
export type McpAuthMode = "none" | "bearer" | "oauth";

export const MCP_AUTH_MODES: readonly McpAuthMode[] = ["none", "bearer", "oauth"] as const;

export type McpToolAccess = Record<McpToolId, boolean>;

export type McpConfig = {
  version: 1;
  /** Master switch. When false the MCP server process is not started at all. */
  enabled: boolean;
  /**
   * Wiki folders exposed over MCP. A path listed here is a database the
   * server may open; anything else is refused before a file is touched.
   */
  exposedWikis: string[];
  authMode: McpAuthMode;
  /**
   * Accept non-loopback connections (Docker `-p`, reverse proxies, LAN).
   * Off by default: the wiki folder is the user's whole knowledge base and
   * it has no other gate.
   */
  allowRemote: boolean;
  /**
   * Token expiry in days for credentials minted through OAuth. `0` means
   * "never expires". Short values plus refresh tokens are the safer default.
   */
  tokenTtlDays: number;
  /** Per-tool switches. A disabled tool is absent from tools/list. */
  tools: McpToolAccess;
};

export const DEFAULT_MCP_CONFIG: McpConfig = {
  version: 1,
  enabled: false,
  exposedWikis: [],
  authMode: "bearer",
  allowRemote: false,
  tokenTtlDays: 30,
  tools: {
    wiki_search: true,
    wiki_read_page: true,
    wiki_list_pages: true,
    wiki_get_toc: true,
    wiki_get_section: true,
    wiki_backlinks: true,
    wiki_get_graph: true,
  },
};

export const MCP_CONFIG_FILENAME = "mcp.json";

/** Tool names shown as OAuth scopes, e.g. `wiki_search` → `wiki:search`. */
export type McpPrincipal = {
  /** Human-readable token or client label, for the audit line in log.md. */
  label: string;
  /** `token` for a static bearer credential, `oauth` for an issued token. */
  kind: "token" | "oauth" | "none";
  scopes: string[];
  allowedTools: McpToolId[];
};

/** A static token as the UI sees it — never includes the secret itself. */
export type McpTokenSummary = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export type McpTokenCreated = McpTokenSummary & {
  /** Returned exactly once, at creation. */
  token: string;
};

export type McpOAuthClientSummary = {
  clientId: string;
  clientName: string;
  registeredAt: string;
  lastAuthorizedAt: string | null;
  /** Tools the most recent consent screen granted this client. */
  tools: McpToolId[];
};

export type McpSessionSummary = {
  clientId: string;
  clientName: string;
  createdAt: string;
};

/** Everything Settings → MCP needs in one round trip. */
export type McpStatus = {
  config: McpConfig;
  port: number;
  endpointPath: string;
  /** Public base URL a client should connect to, e.g. `http://127.0.0.1:3738`. */
  publicBaseUrl: string;
  /** Depth of the wiki path, drives `endpointPath`. */
  basePathDepth: number;
  tokens: McpTokenSummary[];
  oauthClients: McpOAuthClientSummary[];
  sessions: McpSessionSummary[];
  /** True when the server has registered a heartbeat recently. */
  running: boolean;
  /** Last heartbeat line written by the server, or null when never started. */
  lastSeenAt: string | null;
  /** Presigned one-time code the user pastes into the approval page. */
  approvalCode: string | null;
  approvalCodeExpiresAt: string | null;
};

export type McpConfigPatch = Partial<
  Pick<McpConfig, "enabled" | "exposedWikis" | "authMode" | "allowRemote" | "tokenTtlDays">
> & {
  tools?: Partial<McpToolAccess>;
};
