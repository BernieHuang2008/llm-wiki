// `wiki_search` — the retrieval entry point.
//
// The tool contract is intentionally strategy-agnostic: the model sends a query
// and gets back paths, titles, snippets and a relevance score. How the score is
// produced is the server's business, so a future vector channel can be added
// behind `SearchChannel` without changing the tool schema or any client.

import { buildExcerpt, type Db } from "@llm-wiki/core";

export type SearchHit = {
  path: string;
  title: string;
  snippet: string;
  /** 0–1, higher is better. Comparable only within one response. */
  score: number;
  /** Which channel produced the hit. `bm25` today; `vector` when added. */
  channel: SearchChannelName;
  type: string | null;
  tags: string[];
};

export type SearchChannelName = "bm25" | "vector";

export type SearchOptions = {
  query: string;
  maxResults: number;
  /** Character budget per snippet. */
  snippetLength: number;
  /** Restrict to a page type (`entity`, `concept`, …). */
  type?: string | null;
  /** Restrict to pages carrying all of these tags. */
  tags?: string[];
};

const MAX_RESULTS_CAP = 50;
const SNIPPET_MAX = 2000;
const SNIPPET_MIN = 40;

/**
 * A retrieval channel. BM25 is the only implementation today; the interface
 * exists so the hybrid mode promised by the tool can land without a contract
 * change (see docs/16-mcp-server.md § search strategy).
 */
export type SearchChannel = {
  name: SearchChannelName;
  search(db: Db, options: SearchOptions): SearchHit[];
};

type Bm25Row = {
  slug: string;
  title: string;
  snippet: string;
  score: number;
  type: string | null;
  tags: string | null;
};

/**
 * FTS5 treats hyphens, colons and parens as operators. For a tool call we want
 * plain word matching, so every token is quoted — the same policy as the app's
 * search box, deliberately, so the model and the user see the same ranking.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * Parses an FTS5 `snippet()` result.
 *
 * `snippet()` (unlike `highlight()`) takes an ellipsis argument, so without one
 * there is no delimiter to split on. We pass a private-use sentinel around the
 * match instead of `[`/`]` so a snippet that legitimately contains brackets is
 * not mangled, then convert it to `**…**` for the model.
 */
const HL_OPEN = "\u0001";
const HL_CLOSE = "\u0002";

export function parseSnippet(raw: string): { text: string; truncated: boolean } {
  const text = raw.replaceAll(HL_OPEN, "**").replaceAll(HL_CLOSE, "**").replace(/\s+/g, " ").trim();
  // A leading or trailing ellipsis means FTS5 cut the surrounding text.
  return { text, truncated: /^\s*(\.\.\.|…)/.test(raw) || /(\.\.\.|…)\s*$/.test(raw) };
}

const bm25Channel: SearchChannel = {
  name: "bm25",
  search(db, options) {
    const match = sanitizeFtsQuery(options.query);
    if (match.length === 0) return [];

    // Rows are pulled generously, then filtered, so that a `type`/`tags` filter
    // cannot empty a result set that had matches further down the ranking.
    const limit = Math.min(MAX_RESULTS_CAP * 4, Math.max(options.maxResults * 4, 20));
    let rows: Bm25Row[];
    try {
      rows = db
        .prepare(
          `SELECT pages_fts.slug AS slug,
                  pages_fts.title AS title,
                  snippet(pages_fts, 2, char(1), char(2), '...', 32) AS snippet,
                  bm25(pages_fts) AS score,
                  pages.type AS type,
                  pages.tags AS tags
             FROM pages_fts
             LEFT JOIN pages ON pages.slug = pages_fts.slug
            WHERE pages_fts MATCH ?
            ORDER BY score
            LIMIT ?`,
        )
        .all(match, limit) as Bm25Row[];
    } catch {
      // A malformed FTS query is a user error, not a server error: report no
      // hits rather than failing the tool call.
      return [];
    }

    const wantedTags = (options.tags ?? []).map((t) => t.toLowerCase());
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const tags = parseTags(row.tags);
      if (options.type && row.type !== options.type) continue;
      if (wantedTags.length > 0 && !wantedTags.every((t) => tags.includes(t))) continue;

      const parsed = parseSnippet(row.snippet);
      hits.push({
        path: `wiki/${row.slug}.md`,
        title: row.title,
        snippet: clampSnippet(parsed.text, options.snippetLength),
        // FTS5's bm25() is negative and unbounded; map it monotonically into
        // (0,1] so the model gets a number it can threshold on. Ranking order
        // is unchanged, which is what matters.
        score: round4(bm25ToUnit(row.score)),
        channel: "bm25",
        type: row.type,
        tags,
      });
      if (hits.length >= options.maxResults) break;
    }
    return hits;
  },
};

/** The channel list, in the order results are merged. */
export const SEARCH_CHANNELS: readonly SearchChannel[] = [bm25Channel];

export function search(
  db: Db,
  options: SearchOptions,
): {
  hits: SearchHit[];
  mode: "bm25" | "hybrid";
} {
  const merged: SearchHit[] = [];
  for (const channel of SEARCH_CHANNELS) {
    merged.push(...channel.search(db, options));
  }
  merged.sort((a, b) => b.score - a.score);
  return {
    hits: merged.slice(0, options.maxResults),
    // Told to the model so it can explain a miss ("keyword-only index").
    mode: SEARCH_CHANNELS.length > 1 ? "hybrid" : "bm25",
  };
}

/**
 * Turns a raw bm25 score into 0–1. bm25() returns a negative number; `1/(1-x)`
 * maps 0 → 1 and grows monotonically as the score becomes more negative, which
 * is exactly the ordering we want to preserve.
 */
function bm25ToUnit(raw: number): number {
  const value = Number.isFinite(raw) ? raw : 0;
  return 1 / (1 + Math.abs(value));
}

function clampSnippet(text: string, length: number): string {
  const budget = Math.min(SNIPPET_MAX, Math.max(SNIPPET_MIN, length));
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
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

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Fallback used when FTS5 finds nothing: a cheap scan over indexed rows that
 * ranks by how many query terms appear in title + tags. It keeps the tool
 * useful on a wiki whose FTS index is stale (an edit made outside the app that
 * has not been synced yet) instead of reporting a flat "no results".
 */
export function fallbackSearch(db: Db, options: SearchOptions): SearchHit[] {
  const terms = options.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const rows = db
    .prepare(`SELECT slug, title, type, tags FROM pages ORDER BY updated_at DESC LIMIT 500`)
    .all() as Array<{ slug: string; title: string; type: string; tags: string | null }>;

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const tags = parseTags(row.tags);
    const haystack = `${row.title} ${tags.join(" ")}`.toLowerCase();
    const matched = terms.filter((t) => haystack.includes(t)).length;
    if (matched === 0) continue;
    if (options.type && row.type !== options.type) continue;
    hits.push({
      path: `wiki/${row.slug}.md`,
      title: row.title,
      snippet: "",
      score: round4((matched / terms.length) * 0.5),
      channel: "bm25",
      type: row.type,
      tags,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.maxResults);
}

/** Body excerpt for a hit that came from the metadata fallback. */
export function snippetFromBody(body: string, length: number): string {
  const excerpt = buildExcerpt(body, { limit: Math.max(SNIPPET_MIN, length) });
  return excerpt.text;
}
