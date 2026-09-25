import { NextResponse } from "next/server";

import { submitTask } from "@/lib/task-service";

export const dynamic = "force-dynamic";

// POST /api/lint/fix — records a link-fix task and returns 202.
//
// Body: { type: "remove-broken-link" | "rebuild-index" | "fix-all-broken-links"
//               | "create-stub-page" | "apply-suggested-fix", ...args }
//
// Remove/rebuild are local and finish in milliseconds; the stub draft and the
// suggested-fix apply call the model, so all five run through the same
// background path and the UI polls instead of holding the request open.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 400 });
  }

  const result = await submitTask("lint_fix", body);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, type: result.type },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, queued: true, task: result.task }, { status: 202 });
}
