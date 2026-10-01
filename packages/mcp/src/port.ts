/**
 * Network constants for the MCP server.
 *
 * The port is **hard-coded on purpose**. Settings → MCP shows clients the URL
 * to paste, and that URL has to be stable across restarts, workspace folders
 * and Docker port mappings. A port that drifts — or that is auto-incremented
 * when the preferred one is busy — would silently break every configured
 * client, so the port is fixed and a conflict is reported instead.
 *
 * `LLM_WIKI_MCP_PORT` exists only so a Docker `-p 5040:5040` mapping, or a
 * second instance on one machine, can be pointed elsewhere. Both sides read it
 * through `resolveMcpPort()`, so the URL shown in Settings and the port the
 * server binds cannot disagree.
 */
export const DEFAULT_MCP_PORT = 5040;

/** Default endpoint, for a single-wiki install. */
export const MCP_ENDPOINT_PATH = "/mcp";

/** Header the desktop app uses to state the endpoint path it displays. */
export const MCP_PATH_HEADER = "mcp-path";

export function resolveMcpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LLM_WIKI_MCP_PORT"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MCP_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return DEFAULT_MCP_PORT;
  return parsed;
}

export function normalizeMcpPath(path: string | null | undefined): string {
  const trimmed = (path ?? "").trim();
  if (trimmed === "" || trimmed === "/") return MCP_ENDPOINT_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/**
 * The wiki path prefix a request path implies.
 *
 * `/research/quantum/mcp` → `/research/quantum`; `/mcp` → ``.
 */
export function wikiBasePathFromMcpPath(mcpPath: string): string {
  const normalized = normalizeMcpPath(mcpPath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments[segments.length - 1] === "mcp") segments.pop();
  return segments.join("/");
}

/**
 * Works out the endpoint path from a request when the client did not say.
 *
 * Anything ending in `/mcp` is taken at face value — that is the documented
 * shape and it needs no guessing. Otherwise the server is serving the default
 * endpoint at the origin root, which is what a client that was given
 * `http://host:5040` (no path) expects.
 */
export function detectEndpointPath(pathname: string): string {
  const normalized = normalizeMcpPath(pathname);
  return normalized.endsWith("/mcp") ? normalized : MCP_ENDPOINT_PATH;
}

/**
 * Wiki-path depth for this machine, read from the environment.
 *
 * The desktop app knows the path exactly and passes it through
 * `LLM_WIKI_MCP_BASE_PATH`, so the endpoint it displays and the path the server
 * serves cannot disagree.
 */
export function detectWikiBasePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["LLM_WIKI_MCP_BASE_PATH"];
  if (raw === undefined) return "";
  return wikiBasePathFromMcpPath(`${normalizeMcpPath(raw)}/mcp`);
}
