import { NextResponse } from "next/server";

import { getApiKey, type KeyProvider } from "@llm-wiki/core";

import { asKeyProvider } from "@/lib/server-config";

export const dynamic = "force-dynamic";

// Validates a stored API key without spending tokens.
//
// - OpenRouter exposes /key, which requires auth and echoes the account's
//   credit limit + usage.
// - DeepSeek exposes /models, which requires auth and returns the model list.
//   It has no credit endpoint, so the UI shows a "key accepted" result with no
//   usage figures rather than inventing them.
//
// Body (optional): { provider?: "openrouter" | "deepseek" }
export async function POST(req: Request) {
  let provider: KeyProvider = "openrouter";
  try {
    const body = (await req.json().catch(() => ({}))) as { provider?: unknown };
    provider = asKeyProvider(body.provider ?? "openrouter");
  } catch {
    return NextResponse.json(
      { ok: false, reason: "bad-provider", message: "未知的 API key 提供方。" },
      { status: 400 },
    );
  }

  const { key } = await getApiKey(provider);
  if (!key) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        reason: "no-key",
        message: provider === "deepseek" ? "尚未配置 DeepSeek API Key。" : "尚未配置 OpenRouter API Key。",
      },
      { status: 200 },
    );
  }

  return provider === "deepseek"
    ? testDeepSeek(key)
    : testOpenRouter(key);
}

async function testOpenRouter(key: string): Promise<Response> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/ddsyasas/llm-wiki",
        "X-Title": "LLM Wiki",
      },
    });

    if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        { ok: false, provider: "openrouter", reason: "invalid-key", message: "OpenRouter 拒绝了该密钥。" },
        { status: 200 },
      );
    }
    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          provider: "openrouter",
          reason: "remote-error",
          message: `OpenRouter 返回 ${response.status}。`,
        },
        { status: 200 },
      );
    }
    const body = (await response.json()) as {
      data?: { label?: string; usage?: number; limit?: number | null };
    };
    return NextResponse.json({
      ok: true,
      provider: "openrouter",
      label: body.data?.label ?? null,
      usageUsd: body.data?.usage ?? 0,
      limitUsd: body.data?.limit ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        provider: "openrouter",
        reason: "network",
        message: `无法连接 OpenRouter：${(err as Error).message}`,
      },
      { status: 200 },
    );
  }
}

async function testDeepSeek(key: string): Promise<Response> {
  try {
    const response = await fetch("https://api.deepseek.com/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });

    if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        { ok: false, provider: "deepseek", reason: "invalid-key", message: "DeepSeek 拒绝了该密钥。" },
        { status: 200 },
      );
    }
    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          provider: "deepseek",
          reason: "remote-error",
          message: `DeepSeek 返回 ${response.status}。`,
        },
        { status: 200 },
      );
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return NextResponse.json({
      ok: true,
      provider: "deepseek",
      label: null,
      usageUsd: null,
      limitUsd: null,
      modelCount: ids.length,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        provider: "deepseek",
        reason: "network",
        message: `无法连接 DeepSeek：${(err as Error).message}`,
      },
      { status: 200 },
    );
  }
}
