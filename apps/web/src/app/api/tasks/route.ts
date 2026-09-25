import { NextResponse } from "next/server";

import { isActiveTaskStatus, type TaskStatus } from "@llm-wiki/core";

import {
  listActiveTasksForUi,
  listTaskRowsForUi,
  submitTask,
  type SubmitFailure,
} from "@/lib/task-service";
import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

function parseStatuses(raw: string | null): readonly TaskStatus[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as TaskStatus[];
  return wanted.length > 0 ? wanted : undefined;
}

// GET /api/tasks?status=pending,running&limit=50
//     /api/tasks?active=1            → queue + running, oldest first
//     /api/tasks?sourceId=<id>       → every attempt for one source
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ctx = await openWikiContext();
  try {
    const sourceId = url.searchParams.get("sourceId");
    if (sourceId) {
      return NextResponse.json({ tasks: listTaskRowsForUi(ctx.db, { sourceId }) });
    }

    if (url.searchParams.get("active") === "1") {
      return NextResponse.json({ tasks: listActiveTasksForUi(ctx.db) });
    }

    const statuses = parseStatuses(url.searchParams.get("status"));
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), MAX_LIMIT) : 50;
    const tasks = listTaskRowsForUi(ctx.db, {
      ...(statuses ? { statuses } : {}),
      limit,
    });
    return NextResponse.json({
      tasks,
      activeCount: tasks.filter((t) => isActiveTaskStatus(t.status)).length,
    });
  } finally {
    ctx.db.close();
  }
}

// POST /api/tasks — the single entry point for every background operation.
//
// Body: { type: "ingest" | "query" | "chat" | "lint_fix", ...payload }
//
// Returns 202 as soon as the task is recorded. The response never waits for
// the LLM: that work continues in the executor even if this request's client
// disconnects, navigates away, or reloads.
export async function POST(req: Request) {
  let body: { type?: string } & Record<string, unknown>;
  try {
    body = (await req.json()) as { type?: string } & Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 400 });
  }

  if (typeof body.type !== "string" || body.type.length === 0) {
    return NextResponse.json({ error: "缺少 type 字段" }, { status: 400 });
  }

  const result = await submitTask(body.type, body);
  if (!result.ok) {
    return failure(result);
  }

  return NextResponse.json(
    {
      ok: true,
      task: result.task,
      taskIds: result.taskIds ?? [result.task.id],
      tasks: result.tasks ?? [result.task],
      /** Convenience for ingest callers that then poll per-source. */
      sourceId: result.sourceId ?? null,
    },
    { status: 202 },
  );
}

function failure(result: SubmitFailure): Response {
  return NextResponse.json(
    { ok: false, error: result.error, type: result.type },
    { status: result.status },
  );
}
