import { NextResponse } from "next/server";

import { submitTask } from "@/lib/task-service";

export const dynamic = "force-dynamic";
// Only parsing/validation happens here now — the model call runs in the
// background executor, so this route returns immediately.
export const maxDuration = 60;

// POST /api/ingest — records an ingest task and returns 202.
//
// Body: JSON { text?, url?, title?, model? } or multipart with one or more
// `file` fields. Each uploaded file becomes its own source + its own task, so
// a batch upload behaves like N independent ingests: one failure never blocks
// the others.
//
// The response is intentionally *not* the ingest result. The task keeps
// running in the server process even if the browser closes or reloads; poll
// GET /api/tasks/<id> (or GET /api/sources) for the outcome.
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const result = await submitTask("ingest", { form });
      return respond(result);
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "需要 JSON 请求体或 multipart 上传" },
        { status: 400 },
      );
    }
    const result = await submitTask("ingest", body);
    return respond(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "提交入库任务失败" },
      { status: 500 },
    );
  }
}

function respond(result: Awaited<ReturnType<typeof submitTask>>) {
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      queued: true,
      task: result.task,
      taskIds: result.taskIds ?? [result.task.id],
      tasks: result.tasks ?? [result.task],
      sourceId: result.sourceId ?? null,
    },
    { status: 202 },
  );
}
