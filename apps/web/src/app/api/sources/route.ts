import { NextResponse } from "next/server";

import { listUnfinishedSourcesForUi } from "@/lib/task-service";
import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

// GET /api/sources — the "still needs attention" list.
//
// Only sources that have NOT been ingested are returned: pending uploads
// (queued or running), failures awaiting retry, and approval-gate proposals.
// Successfully ingested sources are deliberately omitted — they are already
// part of the wiki, and mixing them in made the list useless as a work queue.
export async function GET() {
  const ctx = await openWikiContext();
  try {
    const sources = listUnfinishedSourcesForUi(ctx.db);
    return NextResponse.json({
      sources,
      pendingCount: sources.length,
      activeCount: sources.filter((s) => s.inFlight).length,
      wikiPath: ctx.wikiPath,
    });
  } finally {
    ctx.db.close();
  }
}
