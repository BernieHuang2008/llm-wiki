import { NextResponse } from "next/server";

import { getApiKey, lintWiki } from "@llm-wiki/core";
import { createClient, ContextLengthError, RateLimitError, UnknownModelError } from "@llm-wiki/llm";

import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

type Body = { model?: string };

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const ctx = await openWikiContext();
  const provider = ctx.settings.defaultModels.lint.provider;
  // Ollama needs no key; the hosted providers do.
  let apiKey = "ollama";
  if (provider !== "ollama") {
    const result = await getApiKey(provider);
    if (!result.key) {
      ctx.db.close();
      return NextResponse.json(
        {
          error:
            provider === "deepseek"
              ? "未配置 DeepSeek API Key，请在“设置 → API”中填写。"
              : "未配置 OpenRouter API Key，请在“设置 → API”中填写。",
        },
        { status: 400 },
      );
    }
    apiKey = result.key;
  }
  const client = createClient(apiKey, provider);
  const model = body.model ?? ctx.settings.defaultModels.lint.model;

  try {
    const result = await lintWiki({
      wikiPath: ctx.wikiPath,
      db: ctx.db,
      client,
      model,
    });
    return NextResponse.json({ ok: true, model, result });
  } catch (err) {
    const status =
      err instanceof ContextLengthError || err instanceof UnknownModelError
        ? 400
        : err instanceof RateLimitError
          ? 429
          : 500;
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message ?? "lint failed",
        type: (err as Error).name ?? "Error",
      },
      { status },
    );
  } finally {
    ctx.db.close();
  }
}
