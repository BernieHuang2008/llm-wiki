import { NextResponse } from "next/server";

import { submitTask } from "@/lib/task-service";

export const dynamic = "force-dynamic";

// POST /api/lint — queues a whole-wiki health check and returns 202.
//
// Body: { model?: string }
//
// This used to run inline, which meant a large wiki held the request open for
// minutes, showed no progress, and lost the result if the request was cut off
// or the page was closed. The check now runs in the background executor; poll
// GET /api/tasks/<id> for the result.
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Optional body — an empty one is fine.
  }

  const result = await submitTask("lint", body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, queued: true, task: result.task }, { status: 202 });
}
