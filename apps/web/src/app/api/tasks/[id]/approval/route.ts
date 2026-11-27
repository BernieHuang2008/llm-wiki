import { NextResponse } from "next/server";

import { resolveLiveWriteApproval } from "@/lib/live-stream";
import { getTaskForUi } from "@/lib/task-service";
import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

type Body = { approved?: unknown };

/**
 * POST /api/tasks/[id]/approval — answers the write prompt a chat task is
 * blocked on. Only the first write in a user turn asks; approving here allows
 * every subsequent write in that same turn.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 400 });
  }
  if (typeof body.approved !== "boolean") {
    return NextResponse.json({ error: "approved 必须是布尔值" }, { status: 400 });
  }

  const ctx = await openWikiContext();
  try {
    const task = getTaskForUi(ctx.db, params.id);
    if (!task) {
      return NextResponse.json({ error: `任务不存在：${params.id}` }, { status: 404 });
    }
    if (task.kind !== "chat") {
      return NextResponse.json({ error: "只有对话任务会请求写入批准" }, { status: 400 });
    }
    if (task.status !== "pending" && task.status !== "running") {
      return NextResponse.json({ error: "任务已经结束" }, { status: 409 });
    }

    const resolved = resolveLiveWriteApproval(params.id, body.approved);
    if (!resolved) {
      return NextResponse.json(
        { error: "当前没有等待确认的写入请求（可能已处理或已超时）" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, approved: body.approved });
  } finally {
    ctx.db.close();
  }
}
