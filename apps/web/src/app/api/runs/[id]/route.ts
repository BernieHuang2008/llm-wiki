import { NextResponse } from "next/server";

import { getRun } from "@llm-wiki/core";

import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

// GET /api/runs/[id] — one stored run, including the full response payload.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await openWikiContext();
  try {
    const run = getRun(ctx.db, params.id);
    if (!run) {
      return NextResponse.json({ error: `记录不存在：${params.id}` }, { status: 404 });
    }
    return NextResponse.json({ run });
  } finally {
    ctx.db.close();
  }
}
