import { NextResponse } from "next/server";

import { deleteChatMessage, getChat } from "@llm-wiki/core";

import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

type RouteParams = { params: { id: string; index: string } };

// DELETE /api/chats/[id]/messages/[index] — removes one message and rewrites
// the chat file. The index is the position in the same message list the UI
// rendered, since chat markdown has no per-message identifiers.
export async function DELETE(_req: Request, { params }: RouteParams) {
  const index = Number(params.index);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "invalid message index" }, { status: 400 });
  }

  const ctx = await openWikiContext();
  try {
    if (!getChat(ctx.db, params.id)) {
      return NextResponse.json({ error: `chat not found: ${params.id}` }, { status: 404 });
    }
    const result = await deleteChatMessage(ctx.wikiPath, ctx.db, params.id, index);
    return NextResponse.json({
      ok: true,
      chat: { row: result.row, messages: result.messages },
      deleted: result.deleted,
    });
  } catch (err) {
    const message = (err as Error).message ?? "failed to delete message";
    const status = message.includes("out of range") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  } finally {
    ctx.db.close();
  }
}
