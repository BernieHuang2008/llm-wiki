import { NextResponse } from "next/server";

import { cancelTask } from "@llm-wiki/core";

import { getTaskForUi } from "@/lib/task-service";
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

// DELETE /api/tasks/[id] — cancels a task that has not started yet.
//
// A task already running finishes its current call (there is no safe way to
// abort an in-flight model request mid-write), but it is marked canceled so
// the UI stops waiting on it.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await openWikiContext();
  try {
    const task = getTaskForUi(ctx.db, params.id);
    if (!task) {
      return NextResponse.json({ error: `任务不存在：${params.id}` }, { status: 404 });
    }
    cancelTask(ctx.db, params.id);
    return NextResponse.json({ ok: true, task: getTaskForUi(ctx.db, params.id) });
  } finally {
    ctx.db.close();
  }
}
