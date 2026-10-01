// Persistent credential store for the MCP server: static bearer tokens, OAuth
// clients, authorization codes, issued access/refresh tokens and approval
// sessions.
//
// One JSON file (`~/.llm-wiki/mcp-auth.json`, written 0600) rather than a
// second SQLite database: the volume here is a handful of rows, the desktop
// app already owns the wiki's SQLite file and two writers on it would be a
// worse problem than the file lock this store takes on every mutation.

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { authStorePath, writeJsonAtomic } from "../config";
import type { McpOAuthClientSummary, McpSessionSummary, McpTokenSummary } from "../types";
import { randomClientId, randomId, randomToken, sha256 } from "./crypto";

export type StoredClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  registeredAt: string;
  lastAuthorizedAt: string | null;
  /** Tools granted by the most recent consent screen. */
  tools: string[];
};

/**
 * One row for every credential, static or OAuth-issued. `kind` is what the UI
 * groups by; `secretHash` is the only copy of the secret that exists anywhere
 * after it has been shown once.
 */
export type StoredToken = {
  id: string;
  kind: "static" | "access" | "refresh" | "session";
  secretHash: string;
  clientId: string | null;
  label: string;
  scopes: string[];
  tools: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export type StoredCode = {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  tools: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  createdAt: string;
  expiresAt: string;
};

export type AuthStore = {
  version: 1;
  /** SHA-256 of the one-time code shown in Settings for first-time approval. */
  approvalCodeHash: string | null;
  approvalCodeExpiresAt: string | null;
  clients: StoredClient[];
  codes: StoredCode[];
  tokens: StoredToken[];
};

export function emptyAuthStore(): AuthStore {
  return {
    version: 1,
    approvalCodeHash: null,
    approvalCodeExpiresAt: null,
    clients: [],
    codes: [],
    tokens: [],
  };
}

const CODE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const APPROVAL_CODE_TTL_MS = 30 * 60 * 1000;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseStore(raw: unknown): AuthStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyAuthStore();
  const data = raw as Record<string, unknown>;
  const store = emptyAuthStore();

  if (typeof data["approvalCodeHash"] === "string")
    store.approvalCodeHash = data["approvalCodeHash"];
  if (typeof data["approvalCodeExpiresAt"] === "string") {
    store.approvalCodeExpiresAt = data["approvalCodeExpiresAt"];
  }

  if (Array.isArray(data["clients"])) {
    for (const entry of data["clients"]) {
      if (typeof entry !== "object" || entry === null) continue;
      const c = entry as Record<string, unknown>;
      if (typeof c["clientId"] !== "string" || typeof c["clientName"] !== "string") continue;
      store.clients.push({
        clientId: c["clientId"],
        clientName: c["clientName"],
        redirectUris: asStringArray(c["redirectUris"]),
        registeredAt:
          typeof c["registeredAt"] === "string" ? c["registeredAt"] : new Date().toISOString(),
        lastAuthorizedAt: typeof c["lastAuthorizedAt"] === "string" ? c["lastAuthorizedAt"] : null,
        tools: asStringArray(c["tools"]),
      });
    }
  }

  if (Array.isArray(data["codes"])) {
    for (const entry of data["codes"]) {
      if (typeof entry !== "object" || entry === null) continue;
      const c = entry as Record<string, unknown>;
      if (typeof c["codeHash"] !== "string" || typeof c["clientId"] !== "string") continue;
      store.codes.push({
        codeHash: c["codeHash"],
        clientId: c["clientId"],
        redirectUri: typeof c["redirectUri"] === "string" ? c["redirectUri"] : "",
        scopes: asStringArray(c["scopes"]),
        tools: asStringArray(c["tools"]),
        codeChallenge: typeof c["codeChallenge"] === "string" ? c["codeChallenge"] : "",
        codeChallengeMethod:
          typeof c["codeChallengeMethod"] === "string" ? c["codeChallengeMethod"] : "S256",
        resource: typeof c["resource"] === "string" ? c["resource"] : null,
        createdAt: typeof c["createdAt"] === "string" ? c["createdAt"] : new Date().toISOString(),
        expiresAt: typeof c["expiresAt"] === "string" ? c["expiresAt"] : new Date().toISOString(),
      });
    }
  }

  if (Array.isArray(data["tokens"])) {
    for (const entry of data["tokens"]) {
      if (typeof entry !== "object" || entry === null) continue;
      const t = entry as Record<string, unknown>;
      const kind = t["kind"];
      if (
        typeof t["secretHash"] !== "string" ||
        (kind !== "static" && kind !== "access" && kind !== "refresh" && kind !== "session")
      ) {
        continue;
      }
      store.tokens.push({
        id: typeof t["id"] === "string" ? t["id"] : randomId(),
        kind,
        secretHash: t["secretHash"],
        clientId: typeof t["clientId"] === "string" ? t["clientId"] : null,
        label: typeof t["label"] === "string" ? t["label"] : "token",
        scopes: asStringArray(t["scopes"]),
        tools: asStringArray(t["tools"]),
        createdAt: typeof t["createdAt"] === "string" ? t["createdAt"] : new Date().toISOString(),
        expiresAt: typeof t["expiresAt"] === "string" ? t["expiresAt"] : null,
        lastUsedAt: typeof t["lastUsedAt"] === "string" ? t["lastUsedAt"] : null,
      });
    }
  }

  return store;
}

/**
 * The store is read on every request and written on every credential change.
 * Concurrent requests are normal (a client retries while the consent screen is
 * open), so all mutations are funnelled through this in-process queue: without
 * it, two `await load(); mutate(); save()` cycles interleave and the second
 * write silently drops the first credential.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  // Keep the chain alive after a rejection so one failed mutation does not
  // wedge every later one.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export class CredentialStore {
  private cache: AuthStore | null = null;
  /** mtime of the file the cache was built from, for change detection. */
  private cacheMtimeMs = 0;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private get path(): string {
    return authStorePath(this.env);
  }

  /**
   * Reads the store, re-reading from disk when the file changed underneath us.
   *
   * The mtime check is not an optimisation — it is required for correctness.
   * Two `CredentialStore` instances can exist in one process (the HTTP server
   * creates one; the approval flow and the settings API create their own), and
   * without it the second instance keeps answering from a snapshot taken before
   * the first one wrote anything. The user-visible failure was an approved
   * client being told its authorization code was "unknown".
   */
  async read(): Promise<AuthStore> {
    const mtimeMs = await mtimeOf(this.path);
    if (this.cache && mtimeMs !== null && mtimeMs === this.cacheMtimeMs) return this.cache;

    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = emptyAuthStore();
        this.cacheMtimeMs = 0;
        return this.cache;
      }
      throw err;
    }
    try {
      this.cache = parseStore(JSON.parse(raw));
    } catch {
      // Corrupt store: start clean rather than crashing the server. Issued
      // credentials stop working, which the user fixes by re-approving.
      this.cache = emptyAuthStore();
    }
    this.cacheMtimeMs = mtimeMs ?? 0;
    return this.cache;
  }

  async mutate<T>(fn: (store: AuthStore) => T | Promise<T>): Promise<T> {
    return serialize(async () => {
      const store = await this.read();
      const result = await fn(store);
      pruneStore(store);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeJsonAtomic(this.path, store);
        // Record our own write so the next read on this instance does not treat
        // it as an external change and re-parse.
        this.cacheMtimeMs = (await mtimeOf(this.path)) ?? this.cacheMtimeMs;
      } catch {
        // A read-only config directory (a container started without a writable
        // home) must not take the server down. The in-memory store still serves
        // this process, and losing a token beats throwing on every request.
      }
      return result;
    });
  }

  /** Drops a cached copy — used by tests and after external edits. */
  invalidate(): void {
    this.cache = null;
    this.cacheMtimeMs = 0;
  }

  // ---- static bearer tokens ------------------------------------------------

  async createStaticToken(
    label: string,
    ttlDays: number,
    env: NodeJS.ProcessEnv = this.env,
  ): Promise<{ token: string; row: StoredToken }> {
    const secret = `lwm_${randomToken(24)}`;
    const now = new Date();
    const row: StoredToken = {
      id: randomId(),
      kind: "static",
      secretHash: sha256(secret),
      clientId: null,
      label: label.trim() || "MCP client",
      scopes: ["wiki:read"],
      tools: [],
      createdAt: now.toISOString(),
      expiresAt: addDays(now, ttlDays),
      lastUsedAt: null,
    };
    void env;
    await this.mutate((store) => {
      store.tokens.push(row);
    });
    return { token: secret, row };
  }

  // ---- OAuth ---------------------------------------------------------------

  async registerClient(clientName: string, redirectUris: string[]): Promise<StoredClient> {
    const client: StoredClient = {
      clientId: randomClientId(),
      clientName: clientName.trim() || "MCP client",
      redirectUris,
      registeredAt: new Date().toISOString(),
      lastAuthorizedAt: null,
      tools: [],
    };
    await this.mutate((store) => {
      store.clients.push(client);
    });
    return client;
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const store = await this.read();
    return store.clients.find((c) => c.clientId === clientId) ?? null;
  }

  async createCode(
    input: Omit<StoredCode, "codeHash" | "createdAt" | "expiresAt">,
  ): Promise<string> {
    const secret = randomToken(32);
    const now = new Date();
    const row: StoredCode = {
      ...input,
      codeHash: sha256(secret),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    };
    await this.mutate((store) => {
      store.codes.push(row);
    });
    return secret;
  }

  /** Single-use: the code is removed whether or not the exchange succeeds. */
  async consumeCode(code: string): Promise<StoredCode | null> {
    const hash = sha256(code);
    return this.mutate((store) => {
      const index = store.codes.findIndex((c) => c.codeHash === hash);
      if (index === -1) return null;
      const [row] = store.codes.splice(index, 1);
      return row ?? null;
    });
  }

  async issueToken(input: {
    kind: "access" | "refresh" | "session";
    clientId: string | null;
    label: string;
    scopes: string[];
    tools: string[];
    ttlDays: number;
  }): Promise<string> {
    const secret = input.kind === "session" ? `lws_${randomToken(24)}` : `lwo_${randomToken(32)}`;
    const now = new Date();
    const row: StoredToken = {
      id: randomId(),
      kind: input.kind,
      secretHash: sha256(secret),
      clientId: input.clientId,
      label: input.label,
      scopes: input.scopes,
      tools: input.tools,
      createdAt: now.toISOString(),
      // Sessions outlive access tokens on purpose: the browser tab approving a
      // client should not expire while the client is still retrying.
      expiresAt:
        input.kind === "session"
          ? new Date(now.getTime() + SESSION_TTL_MS).toISOString()
          : addDays(now, input.ttlDays),
      lastUsedAt: null,
    };
    await this.mutate((store) => {
      store.tokens.push(row);
      if (input.clientId) {
        const client = store.clients.find((c) => c.clientId === input.clientId);
        if (client && input.kind === "access") {
          client.lastAuthorizedAt = now.toISOString();
          client.tools = input.tools;
        }
      }
    });
    return secret;
  }

  async findToken(secret: string, kinds: StoredToken["kind"][]): Promise<StoredToken | null> {
    const hash = sha256(secret);
    const store = await this.read();
    const row = store.tokens.find((t) => t.secretHash === hash && kinds.includes(t.kind));
    if (!row) return null;
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;
    return row;
  }

  /** Fire-and-forget "last used" stamp; never blocks the tool call. */
  touchToken(id: string): void {
    void this.mutate((store) => {
      const row = store.tokens.find((t) => t.id === id);
      if (row) row.lastUsedAt = new Date().toISOString();
    }).catch(() => {
      // Usage bookkeeping is best-effort by design.
    });
  }

  async revokeToken(id: string): Promise<boolean> {
    return this.mutate((store) => {
      const index = store.tokens.findIndex((t) => t.id === id);
      if (index === -1) return false;
      store.tokens.splice(index, 1);
      return true;
    });
  }

  /** Revokes by secret, for the RFC 7009 endpoint (which takes the token). */
  async revokeBySecret(secret: string): Promise<boolean> {
    const hash = sha256(secret);
    return this.mutate((store) => {
      const index = store.tokens.findIndex((t) => t.secretHash === hash);
      if (index === -1) return false;
      store.tokens.splice(index, 1);
      return true;
    });
  }

  async revokeClient(clientId: string): Promise<boolean> {
    return this.mutate((store) => {
      store.clients = store.clients.filter((c) => c.clientId !== clientId);
      store.tokens = store.tokens.filter((t) => t.clientId !== clientId);
      return true;
    });
  }

  // ---- approval code -------------------------------------------------------

  async setApprovalCode(code: string): Promise<void> {
    const hash = sha256(code);
    await this.mutate((store) => {
      store.approvalCodeHash = hash;
      store.approvalCodeExpiresAt = new Date(Date.now() + APPROVAL_CODE_TTL_MS).toISOString();
    });
  }

  async clearApprovalCode(): Promise<void> {
    await this.mutate((store) => {
      store.approvalCodeHash = null;
      store.approvalCodeExpiresAt = null;
    });
  }

  async checkApprovalCode(code: string): Promise<boolean> {
    const store = await this.read();
    if (!store.approvalCodeHash) return false;
    if (store.approvalCodeExpiresAt && Date.parse(store.approvalCodeExpiresAt) <= Date.now()) {
      return false;
    }
    return sha256(code.trim()) === store.approvalCodeHash;
  }

  // ---- summaries for Settings ---------------------------------------------

  async summaries(): Promise<{
    tokens: McpTokenSummary[];
    oauthClients: McpOAuthClientSummary[];
    sessions: McpSessionSummary[];
  }> {
    const store = await this.read();
    const tokens: McpTokenSummary[] = store.tokens
      .filter((t) => t.kind === "static")
      .map((t) => ({
        id: t.id,
        label: t.label,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
      }));

    const oauthClients: McpOAuthClientSummary[] = store.clients.map((c) => ({
      clientId: c.clientId,
      clientName: c.clientName,
      registeredAt: c.registeredAt,
      lastAuthorizedAt: c.lastAuthorizedAt,
      tools: c.tools as McpOAuthClientSummary["tools"],
    }));

    const sessions: McpSessionSummary[] = store.tokens
      .filter((t) => t.kind === "session" && (!t.expiresAt || Date.parse(t.expiresAt) > Date.now()))
      .map((t) => ({
        clientId: t.clientId ?? "",
        clientName: t.label,
        createdAt: t.createdAt,
      }));

    return { tokens, oauthClients, sessions };
  }
}

function addDays(from: Date, days: number): string | null {
  if (days <= 0) return null;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** mtime in ms, or null when the file does not exist yet. */
async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Drops expired codes/tokens so the file cannot grow without bound. */
function pruneStore(store: AuthStore): void {
  const now = Date.now();
  store.codes = store.codes.filter((c) => Date.parse(c.expiresAt) > now);
  store.tokens = store.tokens.filter((t) => !t.expiresAt || Date.parse(t.expiresAt) > now);
  if (store.approvalCodeExpiresAt && Date.parse(store.approvalCodeExpiresAt) <= now) {
    store.approvalCodeHash = null;
    store.approvalCodeExpiresAt = null;
  }
}
