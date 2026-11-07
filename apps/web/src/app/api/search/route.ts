import { stat } from "node:fs/promises";

import { NextResponse } from "next/server";

import {
  loadGlobalConfig,
  openDb,
  searchByMetadata,
  searchWikiInMeili,
  searchWikiPages,
  type Db,
  type WikiSearchHit,
  type WikiSearchOptions,
} from "@llm-wiki/core";

import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;

type CrossWikiHit = WikiSearchHit & { wikiPath: string; wikiName: string };

function parseOptions(url: URL): WikiSearchOptions {
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : 20;
  const type = url.searchParams.get("type");
  const tags = url.searchParams.getAll("tag").filter((t) => t.trim().length > 0);
  return {
    query: url.searchParams.get("q") ?? "",
    limit,
    type: type && type.length > 0 ? type : null,
    tags,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * GET /api/search?q=…&limit=…&type=…&tag=…&all=1
 *
 * The single search entry point for the web UI. Uses the active wiki by
 * default; `all=1` federates across every known wiki (each has its own
 * Meilisearch index). Meilisearch outages fall back to title/tag matching.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const options = parseOptions(url);
  const all = url.searchParams.get("all") === "1";

  const ctx = await openWikiContext();
  try {
    if (!all) {
      const result = await searchWikiPages(ctx.wikiPath, ctx.db, options);
      return NextResponse.json({
        ok: true,
        query: options.query,
        strategy: result.strategy,
        hits: result.hits,
      });
    }

    const config = await loadGlobalConfig();
    const paths = Array.from(
      new Set(
        [config.activeWiki, ...config.recentWikis].filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        ),
      ),
    );

    const federated: CrossWikiHit[] = [];
    let strategy: "meili" | "metadata" = "meili";

    for (const path of paths) {
      if (!(await pathExists(path))) continue;
      const wikiName = path.split(/[\\/]+/).filter(Boolean).pop() ?? path;

      const fromMeili = await searchWikiInMeili(path, options);
      if (fromMeili && fromMeili.length > 0) {
        federated.push(...fromMeili.map((hit) => ({ ...hit, wikiPath: path, wikiName })));
        continue;
      }
      if (fromMeili === null) strategy = "metadata";

      // Meili unavailable, or its index has no hit for this wiki: try the
      // per-wiki SQLite title/tag fallback.
      let db: Db | undefined;
      try {
        db = openDb(path);
        const fallback = searchByMetadata(db, options);
        if (fallback.length > 0) {
          strategy = "metadata";
          federated.push(...fallback.map((hit) => ({ ...hit, wikiPath: path, wikiName })));
        }
      } catch {
        // Unreadable wiki folder — skip it rather than failing the whole search.
      } finally {
        db?.close();
      }
    }

    federated.sort((a, b) => b.score - a.score);
    return NextResponse.json({
      ok: true,
      query: options.query,
      strategy,
      hits: federated.slice(0, options.limit ?? 20),
    });
  } finally {
    ctx.db.close();
  }
}
