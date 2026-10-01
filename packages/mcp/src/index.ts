// Public entry points for the MCP integration.
//
// `apps/web` imports the config module by subpath (`@llm-wiki/mcp/config`) so it
// never pulls the MCP SDK into the Next bundle. Nothing should import this
// barrel from a client component.

export * from "./types";
export * from "./port";
export * from "./config";
export { emptyAuthStore, CredentialStore, type AuthStore, type StoredToken } from "./auth/store";
export {
  authenticate,
  intersectTools,
  isLoopback,
  SESSION_COOKIE,
  type Principal,
} from "./auth/guard";
export {
  AuthorizationServer,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  rotateApprovalCode,
  scopeTools,
} from "./auth/oauth";
export { verifyPkce, sha256, randomApprovalCode, randomToken } from "./auth/crypto";
export {
  buildAuthorizationServerMetadataUrl,
  buildResourceIdentifier,
  buildResourceMetadataUrl,
  endpointPathFromHeader,
  resolvePublicBaseUrl,
  wikiBasePathForEndpoint,
} from "./auth/urls";
export {
  ALL_TOOL_SCOPES,
  MCP_TOOLS,
  MCP_TOOL_IDS,
  SCOPE_ALL,
  SUPPORTED_SCOPES,
  isMcpToolId,
  toolScope,
  toolsForScopes,
  type McpToolId,
  type McpToolMeta,
} from "./tools/registry";
export { search, sanitizeFtsQuery, type SearchHit } from "./tools/search";
export { extractHeadings, findHeading, sliceLines, type Heading } from "./wiki/outline";
export { WikiRegistry, type WikiConnection, type WikiRef } from "./wiki/registry";
export { startMcpHttpServer, type RunningServer, type StartOptions } from "./server/http";
export {
  HEARTBEAT_STALE_MS,
  clearHeartbeat,
  heartbeatPath,
  isServerRunning,
  readHeartbeat,
  writeHeartbeat,
  type McpHeartbeat,
} from "./server/heartbeat";
