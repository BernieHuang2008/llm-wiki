// Meilisearch-backed page search.
//
// The app stays usable without Meilisearch: when no instance is configured (or
// the configured one is down) every call falls back to matching the query
// against page titles + tags. That fallback is deliberately *not* FTS5 — the
// SQLite index is still maintained for internal callers, but the product-level
// search contract is "Meilisearch, else title/tag matching".
//
// One index per wiki. The index uid is derived from the absolute wiki path, so
// moving a wiki folder produces a new index rather than mixing two wikis
// together. Reindexing is idempotent and safe to call on startup.

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import type { Db } from "./db";
import { readPage, listPages, WIKI_PATHS } from "./wiki";

export type WikiSearchHit = {
  slug: string;
  path: string;
  title: string;
  snippet: string;
  /** 0–1. Comparable only within one response. */
  score: number;
  channel: "meili" | "metadata";
  type: string | null;
  tags: string[];
};

export type WikiSearchOptions = {
  query: string;
  limit?: number;
  type?: string | null;
  tags?: string[];
  /** Character budget for the snippet. */
  snippetLength?: number;
};

export type WikiSearchResult = {
  hits: WikiSearchHit[];
  strategy: "meili" | "metadata";
};

type MeiliConfig = {
  url: string;
  apiKey: string | null;
  indexPrefix: string;
};

type MeiliDocument = {
  id: string;
  slug: string;
  title: string;
  type: string;
  tags: string[];
  content: string;
  updated_at: string;
  wikiPath: string;
};

type MeiliHit = {
  slug: string;
  title: string;
  type?: string;
  tags?: string[];
  _formatted?: { content?: string; title?: string };
  _rankingScore?: number;
};

const MAX_RESULTS_CAP = 50;
const SNIPPET_MAX = 2000;
const SNIPPET_MIN = 40;
const REQUEST_TIMEOUT_MS = 3000;
const REINDEX_DEBOUNCE_MS = 1500;
const REINDEX_RETRY_MS = 10_000;

// Set of index uids whose settings have been written this process. Avoids a
// settings round-trip before every document write.
const ensuredIndexes = new Set<string>();
const warned = new Set<string>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function meiliConfig(env: NodeJS.ProcessEnv = process.env): MeiliConfig | null {
  const raw = env["MEILISEARCH_URL"]?.trim();
  if (!raw) return null;
  return {
    url: raw.replace(/\/+$/, ""),
    apiKey: env["MEILISEARCH_API_KEY"]?.trim() || null,
    indexPrefix: env["MEILISEARCH_INDEX_PREFIX"]?.trim() || "llm_wiki",
  };
}

export function meiliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return meiliConfig(env) !== null;
}

/** Stable, Meilisearch-safe index uid for one wiki folder. */
export function wikiIndexUid(wikiPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const absolute = resolve(wikiPath);
  const prefix = (meiliConfig(env)?.indexPrefix ?? "llm_wiki")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "llm_wiki";
  const name = basename(absolute)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "wiki";
  const hash = createHash("sha1").update(absolute).digest("hex").slice(0, 10);
  return `${prefix}_${name}_${hash}`;
}

async function meiliFetch(
  cfg: MeiliConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cfg.apiKey) headers.set("authorization", `Bearer ${cfg.apiKey}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Meilisearch ${init.method ?? "GET"} ${path} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function warnOnce(key: string, err: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[search] ${key}: ${(err as Error).message ?? String(err)}`);
}

async function ensureIndex(cfg: MeiliConfig, uid: string): Promise<void> {
  if (ensuredIndexes.has(uid)) return;
  try {
    await meiliFetch(cfg, "/indexes", {
      method: "POST",
      body: JSON.stringify({ uid, primaryKey: "id" }),
    });
  } catch (err) {
    // The index already exists — that's the common path.
    if (!/already.?exists|index_already_exists/i.test(String(err))) throw err;
  }
  await meiliFetch(cfg, `/indexes/${encodeURIComponent(uid)}/settings`, {
    method: "PATCH",
    body: JSON.stringify({
      searchableAttributes: ["title", "content", "tags"],
      filterableAttributes: ["type", "tags", "wikiPath"],
      sortableAttributes: ["updated_at"],
      displayedAttributes: [
        "id",
        "slug",
        "title",
        "type",
        "tags",
        "content",
        "updated_at",
        "wikiPath",
      ],
    }),
  });
  ensuredIndexes.add(uid);
}

function docFromPage(
  wikiPath: string,
  page: { slug: string; frontmatter: { title: string; type: string; updated: string; tags?: string[] }; content: string },
): MeiliDocument {
  return {
    id: page.slug,
    slug: page.slug,
    title: page.frontmatter.title,
    type: page.frontmatter.type,
    tags: page.frontmatter.tags ?? [],
    content: page.content,
    updated_at: page.frontmatter.updated,
    wikiPath: resolve(wikiPath),
  };
}

/**
 * Upsert a single page. Best-effort: indexing must never make a page write
 * fail. Callers can `void` this.
 */
export async function indexPageInMeili(
  wikiPath: string,
  page: { slug: string; frontmatter: { title: string; type: string; updated: string; tags?: string[] }; content: string },
): Promise<void> {
  const cfg = meiliConfig();
  if (!cfg) return;
  const uid = wikiIndexUid(wikiPath);
  try {
    await ensureIndex(cfg, uid);
    await meiliFetch(
      cfg,
      `/indexes/${encodeURIComponent(uid)}/documents?primaryKey=id`,
      { method: "POST", body: JSON.stringify([docFromPage(wikiPath, page)]) },
    );
  } catch (err) {
    warnOnce(`index ${uid}`, err);
  }
}

export async function removePageFromMeili(wikiPath: string, slug: string): Promise<void> {
  const cfg = meiliConfig();
  if (!cfg) return;
  const uid = wikiIndexUid(wikiPath);
  try {
    await meiliFetch(
      cfg,
      `/indexes/${encodeURIComponent(uid)}/documents/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    warnOnce(`delete ${uid}`, err);
  }
}

async function listDocumentIds(cfg: MeiliConfig, uid: string): Promise<string[] | null> {
  const ids: string[] = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    let res: Response;
    try {
      res = await meiliFetch(
        cfg,
        `/indexes/${encodeURIComponent(uid)}/documents?fields=id&limit=${limit}&offset=${offset}`,
      );
    } catch {
      return null; // index doesn't exist yet
    }
    const rows = (await res.json()) as Array<{ id: string }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    ids.push(...rows.map((r) => r.id));
    if (rows.length < limit) break;
    offset += limit;
  }
  return ids;
}

/**
 * Rebuild one wiki's index from the page files on disk. Upserts every page
 * first, then removes documents whose slug is no longer present, so search
 * stays populated during the rebuild.
 */
export async function reindexWikiInMeili(
  wikiPath: string,
): Promise<{ indexed: number; removed: number } | null> {
  const cfg = meiliConfig();
  if (!cfg) return null;

  // Fail before reading every page when the instance is still booting.
  await meiliFetch(cfg, "/health");
  const uid = wikiIndexUid(wikiPath);

  const summaries = await listPages(wikiPath);
  const docs: MeiliDocument[] = [];
  for (const summary of summaries) {
    try {
      docs.push(docFromPage(wikiPath, await readPage(wikiPath, summary.slug)));
    } catch {
      // Malformed page — skip, matching listPages' own tolerance.
    }
  }

  await ensureIndex(cfg, uid);

  for (let i = 0; i < docs.length; i += 200) {
    await meiliFetch(
      cfg,
      `/indexes/${encodeURIComponent(uid)}/documents?primaryKey=id`,
      { method: "POST", body: JSON.stringify(docs.slice(i, i + 200)) },
    );
  }

  const wanted = new Set(docs.map((d) => d.id));
  const existing = await listDocumentIds(cfg, uid);
  const stale = existing ? existing.filter((id) => !wanted.has(id)) : [];
  if (stale.length > 0) {
    await meiliFetch(cfg, `/indexes/${encodeURIComponent(uid)}/documents/delete-batch`, {
      method: "POST",
      body: JSON.stringify(stale),
    });
  }

  return { indexed: docs.length, removed: stale.length };
}

/**
 * Debounced full reindex. Called from the request path after the disk→SQLite
 * sync, so page edits made outside the app reach Meilisearch without a
 * per-write hook. Deliberately does not capture a `Db` handle: the caller's DB
 * is closed at the end of the request.
 */
export function scheduleWikiIndexSync(wikiPath: string): void {
  if (!meiliEnabled()) return;
  if (debounceTimers.has(wikiPath)) return;
  const timer = setTimeout(() => {
    debounceTimers.delete(wikiPath);
    void reindexWikiInMeili(wikiPath).catch((err) => {
      warnOnce("reindex", err);
      // The container may still be starting. Retry until the index is built;
      // the health check above keeps this from re-reading pages while down.
      if (!meiliEnabled()) return;
      const retry = setTimeout(() => scheduleWikiIndexSync(wikiPath), REINDEX_RETRY_MS);
      retry.unref?.();
    });
  }, REINDEX_DEBOUNCE_MS);
  timer.unref?.();
  debounceTimers.set(wikiPath, timer);
}

function buildFilter(options: WikiSearchOptions): string | undefined {
  const clauses: string[] = [];
  if (options.type) clauses.push(`type = ${JSON.stringify(options.type)}`);
  for (const tag of options.tags ?? []) clauses.push(`tags = ${JSON.stringify(tag)}`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

function clampSnippet(text: string, length: number): string {
  const budget = Math.min(SNIPPET_MAX, Math.max(SNIPPET_MIN, length));
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Query Meilisearch. Returns null when Meilisearch isn't configured or the
 * request failed — the caller decides how to fall back.
 */
export async function searchWikiInMeili(
  wikiPath: string,
  options: WikiSearchOptions,
): Promise<WikiSearchHit[] | null> {
  const cfg = meiliConfig();
  if (!cfg) return null;
  const query = options.query.trim();
  if (query.length === 0) return [];

  const uid = wikiIndexUid(wikiPath);
  const limit = Math.min(MAX_RESULTS_CAP, Math.max(1, options.limit ?? 10));
  const snippetLength = Math.min(SNIPPET_MAX, Math.max(SNIPPET_MIN, options.snippetLength ?? 240));

  try {
    const res = await meiliFetch(cfg, `/indexes/${encodeURIComponent(uid)}/search`, {
      method: "POST",
      body: JSON.stringify({
        q: query,
        limit,
        attributesToRetrieve: ["slug", "title", "type", "tags", "content"],
        attributesToCrop: ["content"],
        cropLength: Math.max(20, Math.ceil(snippetLength / 6)),
        cropMarker: "…",
        attributesToHighlight: ["title", "content", "tags"],
        highlightPreTag: "**",
        highlightPostTag: "**",
        showRankingScore: true,
        ...(buildFilter(options) ? { filter: buildFilter(options) } : {}),
      }),
    });
    const json = (await res.json()) as { hits?: MeiliHit[] };
    const hits = Array.isArray(json.hits) ? json.hits : [];
    return hits.map((hit) => {
      const snippet = clampSnippet(
        stripHighlightPadding(hit._formatted?.content ?? ""),
        snippetLength,
      );
      return {
        slug: hit.slug,
        path: `wiki/${hit.slug}.md`,
        title: hit._formatted?.title
          ? stripHighlightPadding(hit._formatted.title)
          : hit.title,
        snippet,
        score: typeof hit._rankingScore === "number" ? round4(hit._rankingScore) : 0,
        channel: "meili" as const,
        type: hit.type ?? null,
        tags: Array.isArray(hit.tags) ? hit.tags : [],
      };
    });
  } catch (err) {
    warnOnce(`search ${uid}`, err);
    return null;
  }
}

function stripHighlightPadding(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Title/tag matching used when Meilisearch is unavailable or stale. */
export function searchByMetadata(
  db: Db,
  options: WikiSearchOptions,
): WikiSearchHit[] {
  const terms = options.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const rows = db
    .prepare(`SELECT slug, title, type, tags FROM pages ORDER BY updated_at DESC LIMIT 500`)
    .all() as Array<{ slug: string; title: string; type: string; tags: string | null }>;

  const wantedTags = (options.tags ?? []).map((t) => t.toLowerCase());
  const hits: WikiSearchHit[] = [];
  for (const row of rows) {
    const tags = parseTags(row.tags);
    if (options.type && row.type !== options.type) continue;
    if (wantedTags.length > 0 && !wantedTags.every((t) => tags.includes(t))) continue;

    const haystack = `${row.title} ${tags.join(" ")}`.toLowerCase();
    const matched = terms.filter((t) => haystack.includes(t)).length;
    if (matched === 0) continue;

    hits.push({
      slug: row.slug,
      path: `wiki/${row.slug}.md`,
      title: row.title,
      snippet: "",
      score: round4((matched / terms.length) * 0.5),
      channel: "metadata",
      type: row.type,
      tags,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.min(MAX_RESULTS_CAP, Math.max(1, options.limit ?? 10)));
}

/**
 * Product-level search: Meilisearch first, title/tag matching second. Also
 * falls back when Meilisearch is reachable but the index hasn't caught up yet
 * (zero hits), so a page edited outside the app is still findable.
 */
export async function searchWikiPages(
  wikiPath: string,
  db: Db,
  options: WikiSearchOptions,
): Promise<WikiSearchResult> {
  const meiliHits = await searchWikiInMeili(wikiPath, options);
  if (meiliHits && meiliHits.length > 0) {
    return { hits: meiliHits, strategy: "meili" };
  }
  return { hits: searchByMetadata(db, options), strategy: "metadata" };
}

/**
 * Drop-in async replacement for `searchPages` used by the ingest/query/chat
 * RAG paths. Keeps the old `{slug,title,snippet}` shape so callers only need
 * to add `await`.
 */
export async function searchPagesUnified(
  wikiPath: string,
  db: Db,
  query: string,
  limit = 20,
): Promise<Array<{ slug: string; title: string; snippet: string }>> {
  const { hits } = await searchWikiPages(wikiPath, db, { query, limit });
  return hits.map((h) => ({ slug: h.slug, title: h.title, snippet: h.snippet }));
}

/** Index name shown in Settings / diagnostics. */
export function wikiIndexName(wikiPath: string): string {
  return wikiIndexUid(wikiPath);
}

/** The per-wiki Meilisearch storage path, for docs and compose comments. */
export function meiliStorageSubdir(): string {
  return `${WIKI_PATHS.tooling}/meili`;
}
