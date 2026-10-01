// Which wiki a tool call reads, and the SQLite connection it reads through.
//
// Two rules keep this safe and cheap:
//   1. A wiki folder is opened only if it is on the allow-list in
//      `~/.llm-wiki/mcp.json`. Nothing else in the app checks inbound
//      credentials, so the allow-list is the boundary that makes "which
//      databases are open" a real setting rather than a label.
//   2. Connections are pooled per process (better-sqlite3 is synchronous, so a
//      per-call open/close cycle would fsync on every tool call). A wiki that
//      stops being used is closed after `IDLE_MS`, which also releases the WAL
//      handle so the desktop app can compact it.

import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { openDb, readPage, syncWikiToDb, wikiSettingsPath, type Db } from "@llm-wiki/core";

import type { McpConfig } from "../types";

export type WikiRef = {
  path: string;
  /** Directory name — the label shown to the model. */
  name: string;
};

export type WikiConnection = {
  ref: WikiRef;
  db: Db;
  /** Frontmatter topic from settings.json, or null when unset. */
  topic: string | null;
};

/** How long an opened wiki stays warm after its last tool call. */
const IDLE_MS = 5 * 60 * 1000;
/** Skip the disk → SQLite reconcile if we already ran it this recently. */
const SYNC_TTL_MS = 5 * 1000;

type Entry = {
  db: Db;
  lastSyncMs: number;
  lastUsedMs: number;
  topic: string | null;
};

export class WikiRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly aliases = new Map<string, string>();

  constructor(private readonly config: McpConfig) {
    for (const path of config.exposedWikis) {
      // A folder name is the ergonomic handle, but two wikis can share one
      // ("~/work/notes" and "~/home/notes"). An ambiguous name is removed from
      // the alias table so it can only be addressed by full path.
      const name = basename(path);
      if (this.aliases.has(name)) this.aliases.set(name, "");
      else this.aliases.set(name, path);
    }
  }

  listWikis(): WikiRef[] {
    return this.config.exposedWikis.map((path) => ({ path, name: basename(path) }));
  }

  /**
   * The wiki this call should read, or an error explaining the ambiguity.
   *
   * `basePath` comes from the request URL (`/research/quantum/mcp` → the client
   * is asking for the `quantum` wiki). It is matched as a path suffix so a
   * nested install works without the user having to pass `wiki` on every call.
   */
  resolve(requested?: string | null, basePath?: string | null): WikiRef | { error: string } {
    const exposed = this.config.exposedWikis;
    if (exposed.length === 0) {
      return {
        error: "没有开放任何知识库。请在 LLM Wiki 的「设置 → MCP」里勾选要开放的数据库。",
      };
    }

    const fromPath = matchByBasePath(exposed, basePath);
    if (fromPath) return { path: fromPath, name: basename(fromPath) };

    const wanted = requested?.trim();
    if (wanted) {
      if (isAbsolute(wanted)) {
        const normalized = normalizePath(wanted);
        const hit = exposed.find((p) => normalizePath(p) === normalized);
        if (hit) return { path: hit, name: basename(hit) };
      }
      const byAlias = this.aliases.get(wanted);
      if (byAlias) return { path: byAlias, name: basename(byAlias) };
      return {
        error:
          `未开放名为 '${wanted}' 的知识库。可用：` + exposed.map((p) => basename(p)).join(", "),
      };
    }

    // No explicit choice: prefer whatever the desktop app has active, so a
    // client configured without arguments follows the user's current wiki.
    const active = readActiveWikiPath();
    if (active) {
      const hit = exposed.find((p) => normalizePath(p) === normalizePath(active));
      if (hit) return { path: hit, name: basename(hit) };
    }
    if (exposed.length === 1) {
      const only = exposed[0];
      if (only !== undefined) return { path: only, name: basename(only) };
    }
    return {
      error:
        "开放了多个知识库，请用 wiki 参数指定其中之一：" +
        exposed.map((p) => basename(p)).join(", "),
    };
  }

  /** Opens (or reuses) a connection, reconciling disk → SQLite when stale. */
  async open(ref: WikiRef): Promise<WikiConnection> {
    this.evictIdle();
    let entry = this.entries.get(ref.path);
    if (!entry) {
      entry = {
        db: openDb(ref.path),
        lastSyncMs: 0,
        lastUsedMs: Date.now(),
        topic: await readTopic(ref.path),
      };
      this.entries.set(ref.path, entry);
    }
    entry.lastUsedMs = Date.now();
    if (Date.now() - entry.lastSyncMs > SYNC_TTL_MS) {
      // `syncWikiToDb` is idempotent and mtime-gated, so this is cheap when
      // nothing changed — and it is what makes an edit made in Obsidian
      // visible to the model without restarting anything.
      try {
        await syncWikiToDb(ref.path, entry.db);
        entry.lastSyncMs = Date.now();
      } catch {
        // A read tool must still answer from the index it already has rather
        // than fail because one page on disk is malformed.
      }
    }
    return { ref, db: entry.db, topic: entry.topic };
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.db.close();
      } catch {
        // Closing is best-effort during shutdown.
      }
    }
    this.entries.clear();
  }

  private evictIdle(): void {
    const cutoff = Date.now() - IDLE_MS;
    for (const [path, entry] of this.entries) {
      if (entry.lastUsedMs >= cutoff) continue;
      try {
        entry.db.close();
      } catch {
        // ignore
      }
      this.entries.delete(path);
    }
  }
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Matches a request's wiki path prefix against the exposed folders.
 *
 * Suffix, not prefix: `/research/quantum` is a prefix match on the request URL
 * but a suffix match on the folder `/home/me/research/quantum`, and the folder
 * is the side we know.
 */
function matchByBasePath(exposed: string[], basePath: string | null | undefined): string | null {
  const wanted = (basePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (wanted === "") return null;

  const hits = exposed.filter((path) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
    return normalized === wanted || normalized.endsWith(`/${wanted}`);
  });
  // An ambiguous prefix resolves to nothing rather than to a coin flip; the
  // tool then reports the candidate list.
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * `activeWiki` from `~/.llm-wiki/config.json`.
 *
 * Read synchronously on purpose: `resolve()` sits on the argument-parsing path
 * of every tool call and this is a small, OS-cached JSON file. The same
 * resolution order as `apps/web`'s `resolveWikiPath()` — env, then the config
 * file — minus the `~/llm-wiki-default` fallback, because MCP only ever reads
 * wikis the user explicitly exposed.
 */
function readActiveWikiPath(): string | null {
  const fromEnv = process.env["LLM_WIKI_PATH"];
  if (fromEnv) return fromEnv;
  try {
    const dir = process.env["LLM_WIKI_CONFIG_DIR"] ?? join(homedir(), ".llm-wiki");
    const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      activeWiki?: unknown;
    };
    return typeof parsed.activeWiki === "string" && parsed.activeWiki.length > 0
      ? parsed.activeWiki
      : null;
  } catch {
    return null;
  }
}

async function readTopic(wikiPath: string): Promise<string | null> {
  try {
    const raw = await readFile(wikiSettingsPath(wikiPath), "utf8");
    const parsed = JSON.parse(raw) as { topic?: unknown };
    return typeof parsed.topic === "string" && parsed.topic.trim().length > 0
      ? parsed.topic.trim()
      : null;
  } catch {
    return null;
  }
}

/** Page body from disk — the file is the source of truth, not the index. */
export async function loadPageBody(wikiPath: string, slug: string): Promise<string | null> {
  try {
    const page = await readPage(wikiPath, slug);
    return page.content;
  } catch {
    return null;
  }
}

/** Cheap existence check that does not read the file. */
export function pageFileExists(wikiPath: string, slug: string): boolean {
  try {
    statSync(join(wikiPath, "wiki", `${slug}.md`));
    return true;
  } catch {
    return false;
  }
}
