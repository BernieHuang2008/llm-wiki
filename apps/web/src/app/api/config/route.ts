import { NextResponse } from "next/server";

import {
  asKeyProvider,
  deleteApiKey,
  getApiKeyStatuses,
  setApiKey,
} from "@/lib/server-config";

// Avoid any caching: these endpoints reflect mutable on-disk + keychain state.
export const dynamic = "force-dynamic";

// GET /api/config — key status for every provider that needs one, so the
// Settings → API tab can list OpenRouter and DeepSeek side by side.
export async function GET() {
  try {
    const statuses = await getApiKeyStatuses();
    // Kept alongside the map for older clients that read the flat shape.
    const openrouter = statuses.openrouter;
    return NextResponse.json({ ...openrouter, statuses });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "failed to read config" },
      { status: 500 },
    );
  }
}

// POST /api/config — body: { apiKey: string, provider?: "openrouter" | "deepseek" }
export async function POST(req: Request) {
  let body: { apiKey?: unknown; provider?: unknown } = {};
  try {
    body = (await req.json()) as { apiKey?: unknown; provider?: unknown };
  } catch {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 400 });
  }

  const key = body.apiKey;
  if (typeof key !== "string" || key.trim().length === 0) {
    return NextResponse.json({ error: "apiKey 不能为空" }, { status: 400 });
  }

  try {
    const provider = asKeyProvider(body.provider ?? "openrouter");
    const status = await setApiKey(key, provider);
    return NextResponse.json({ ...status, statuses: await getApiKeyStatuses() });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "failed to save API key" },
      { status: 400 },
    );
  }
}

// DELETE /api/config?provider=deepseek — defaults to OpenRouter.
export async function DELETE(req: Request) {
  try {
    const provider = asKeyProvider(
      new URL(req.url).searchParams.get("provider") ?? "openrouter",
    );
    const status = await deleteApiKey(provider);
    return NextResponse.json({ ...status, statuses: await getApiKeyStatuses() });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "failed to delete API key" },
      { status: 400 },
    );
  }
}
