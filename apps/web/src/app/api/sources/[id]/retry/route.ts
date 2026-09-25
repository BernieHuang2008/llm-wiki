import { NextResponse } from "next/server";

import { submitSourceRetry } from "@/lib/task-service";

export const dynamic = "force-dynamic";

// POST /api/sources/[id]/retry — queues a fresh ingest task for a source whose
// raw file is still on disk. Useful after a failure (model drift, transient
// network error) or when the user wants to try a smarter model.
//
// Body: { modelOverride?: string }
export async function POST(req: Request, { params }: { params: { id: string } }) {
  let body: { modelOverride?: unknown } = {};
  try {
    body = (await req.json()) as { modelOverride?: unknown };
  } catch {
    // Optional body — empty is fine.
  }

  const result = await submitSourceRetry(
    params.id,
    typeof body.modelOverride === "string" ? body.modelOverride : undefined,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { ok: true, queued: true, task: result.task, sourceId: params.id },
    { status: 202 },
  );
}
