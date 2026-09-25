import { NextResponse } from "next/server";

import { submitTask } from "@/lib/task-service";

export const dynamic = "force-dynamic";

// POST /api/query — records a query task and returns 202.
//
// The answer is produced in the background; poll GET /api/tasks/<id> for it.
// Closing the page no longer cancels the work.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 400 });
  }

  const result = await submitTask("query", body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, queued: true, task: result.task }, { status: 202 });
}
