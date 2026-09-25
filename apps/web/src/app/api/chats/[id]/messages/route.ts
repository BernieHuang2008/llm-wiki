import { NextResponse } from "next/server";

import { submitTask } from "@/lib/task-service";

export const dynamic = "force-dynamic";

type Body = {
  message?: unknown;
  modelOverride?: unknown;
};

// POST /api/chats/[id]/messages — records a chat task and returns 202.
//
// The user's turn is written to the chat file immediately (so the thread shows
// it), while the assistant reply is generated in the background. Leaving the
// page mid-answer no longer loses the reply.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 400 });
  }

  const result = await submitTask("chat", {
    chatId: params.id,
    message: body.message,
    modelOverride: body.modelOverride,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, queued: true, task: result.task }, { status: 202 });
}
