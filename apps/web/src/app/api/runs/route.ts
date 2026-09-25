import { NextResponse } from "next/server";

import { listRuns, type RunKind } from "@llm-wiki/core";

import { LINT_LIST_LIMIT, recentWindowStart, RUN_LIST_LIMIT } from "@/lib/run-history";
import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

// GET /api/runs?kind=query|lint&limit=50
//
// Recent runs of one kind, newest first, bounded by both a count and a time
// window so "recent" stays recent on a busy wiki and still shows something on
// a quiet one.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kindRaw = url.searchParams.get("kind");
  if (kindRaw !== "query" && kindRaw !== "lint") {
    return NextResponse.json({ error: "kind 必须是 query 或 lint" }, { status: 400 });
  }
  const kind: RunKind = kindRaw;

  const defaultLimit = kind === "lint" ? LINT_LIST_LIMIT : RUN_LIST_LIMIT;
  const limitRaw = Number(url.searchParams.get("limit") ?? defaultLimit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(1, Math.floor(limitRaw)), RUN_LIST_LIMIT)
    : defaultLimit;

  const ctx = await openWikiContext();
  try {
    const runs = listRuns(ctx.db, { kind, limit, since: recentWindowStart() });
    return NextResponse.json({
      runs,
      limit,
      windowDays: 14,
      windowStart: recentWindowStart(),
    });
  } finally {
    ctx.db.close();
  }
}
