// URL construction for the MCP endpoints.
//
// The server has no idea how the outside world reaches it: behind a Docker
// `-p 3738:3738` mapping the browser talks to a different hostname than the
// container sees, and a reverse proxy adds another layer. The client already
// knows the correct origin — it is the URL the user pasted — so the server
// echoes that origin back in the two places the specification makes it
// authoritative: the RFC 9728 `resource` value and resource-metadata URL, and
// the OAuth issuer/endpoint URLs in the authorization-server metadata.

import {
  MCP_PATH_HEADER,
  detectEndpointPath,
  normalizeMcpPath,
  wikiBasePathFromMcpPath,
} from "../port";

/**
 * Absolute origin of this server as the client reached it.
 *
 * Prefers `X-Forwarded-*` over `Host`, because a proxied request's `Host` is
 * the internal name.
 */
export function resolvePublicBaseUrl(
  headers: Record<string, string | string[] | undefined>,
  socketEncrypted: boolean,
): string {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const withoutPort = (host: string): string => host.replace(/:\d+$/, "");

  const forwardedProto = first(headers["x-forwarded-proto"]);
  const forwardedHost = first(headers["x-forwarded-host"]);
  const forwardedPort = first(headers["x-forwarded-port"]);
  const rawHost = forwardedHost ?? first(headers["host"]) ?? "127.0.0.1";

  const scheme = forwardedProto?.split(",")[0]?.trim() || (socketEncrypted ? "https" : "http");
  const port = forwardedPort?.split(",")[0]?.trim();
  const host = forwardedHost ? rawHost : withoutPort(rawHost);
  const hostWithPort = port ? `${host}:${port}` : rawHost;
  return `${scheme}://${hostWithPort}`;
}

/** RFC 9728 document lives under `/.well-known/oauth-protected-resource`. */
export function buildResourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl}/.well-known/oauth-protected-resource`;
}

export function buildAuthorizationServerMetadataUrl(baseUrl: string): string {
  return `${baseUrl}/.well-known/oauth-authorization-server`;
}

/** The `resource` value this server claims: its origin plus endpoint path. */
export function buildResourceIdentifier(baseUrl: string, endpointPath: string): string {
  return `${baseUrl}${normalizeMcpPath(endpointPath)}`;
}

/**
 * `mcp-path` header: the desktop app knows the path exactly and sends it, so a
 * nested or renamed wiki works without the server guessing.
 */
export function endpointPathFromHeader(
  headers: Record<string, string | string[] | undefined>,
  pathname: string,
): string {
  const raw = headers[MCP_PATH_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && value.trim().length > 0) return normalizeMcpPath(value);
  return detectEndpointPath(pathname);
}

/**
 * Wiki path prefix implied by an endpoint path, for `WikiRegistry` to resolve
 * against the wiki folders the user exposed.
 */
export function wikiBasePathForEndpoint(endpointPath: string): string {
  return wikiBasePathFromMcpPath(endpointPath);
}
