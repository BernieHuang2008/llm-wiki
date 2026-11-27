import { NextResponse } from "next/server";

import { cancelTask } from "@llm-wiki/core";

import { getTaskForUi } from "@/lib/task-service";
import { abortTask } from "@/lib/task-executor";
import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

// GET /api/tasks/[id] — status, progress, and the result payload once done.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await openWikiContext();
  try {
    const task = getTaskForUi(ctx.db, params.id);
    if (!task) {
      return NextResponse.json({ error: `任务不存在：${params.id}` }, { status: 404 });
    }
    return NextResponse.json({ task });
  } finally {
    ctx.db.close();
  }
}

// DELETE /api/tasks/[id] — stops a task.
//
// The row is marked canceled first, then the executor's AbortController is
// triggered so an in-flight model request is cut off at the SDK boundary. A
// queued task has no controller yet; marking it canceled is enough because it
// can never be claimed.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await openWikiContext();
  try {
    const task = getTaskForUi(ctx.db, params.id);
    if (!task) {
      return NextResponse.json({ error: `任务不存在：${params.id}` }, { status: 404 });
    }
    cancelTask(ctx.db, params.id);
    abortTask(params.id);
    return NextResponse.json({ ok: true, task: getTaskForUi(ctx.db, params.id) });
  } finally {
    ctx.db.close();
  }
}
