import { NextResponse } from "next/server";

import {
  clampIngestConcurrency,
  clampMaxRounds,
  DEFAULT_WIKI_SETTINGS,
  loadWikiSettings,
  saveWikiSettings,
  type ModelSlotConfig,
  type WikiSettings,
} from "@llm-wiki/core";

import { resolveWikiPath } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

export async function GET() {
  const wikiPath = resolveWikiPath();
  const settings = await loadWikiSettings(wikiPath);
  return NextResponse.json({ settings, wikiPath });
}

type PutBody = Partial<{
  topic: string;
  defaultModels: Partial<Record<keyof WikiSettings["defaultModels"], Partial<ModelSlotConfig>>>;
  autoLintAfterIngest: boolean;
  showCostEstimates: boolean;
  requireApprovalForIngest: boolean;
  ingestConcurrency: number;
}>;

export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }
  const wikiPath = resolveWikiPath();
  const current = await loadWikiSettings(wikiPath);
  const mergeSlot = (
    saved: ModelSlotConfig,
    patch: Partial<ModelSlotConfig> | undefined,
  ): ModelSlotConfig => ({
    provider: patch?.provider ?? saved.provider,
    model: patch?.model ?? saved.model,
    maxRounds:
      typeof patch?.maxRounds === "number" ? clampMaxRounds(patch.maxRounds) : saved.maxRounds,
  });
  const next: WikiSettings = {
    version: 1,
    topic: typeof body.topic === "string" ? body.topic : current.topic,
    defaultModels: {
      ingest: mergeSlot(current.defaultModels.ingest, body.defaultModels?.ingest),
      query: mergeSlot(current.defaultModels.query, body.defaultModels?.query),
      chat: mergeSlot(current.defaultModels.chat, body.defaultModels?.chat),
      lint: mergeSlot(current.defaultModels.lint, body.defaultModels?.lint),
      vision: mergeSlot(current.defaultModels.vision, body.defaultModels?.vision),
    },
    autoLintAfterIngest:
      typeof body.autoLintAfterIngest === "boolean"
        ? body.autoLintAfterIngest
        : current.autoLintAfterIngest,
    showCostEstimates:
      typeof body.showCostEstimates === "boolean"
        ? body.showCostEstimates
        : current.showCostEstimates,
    requireApprovalForIngest:
      typeof body.requireApprovalForIngest === "boolean"
        ? body.requireApprovalForIngest
        : current.requireApprovalForIngest,
    // Clamped rather than trusted: a hand-crafted request must not be able to
    // set a concurrency the executor has no lanes for.
    ingestConcurrency:
      typeof body.ingestConcurrency === "number"
        ? clampIngestConcurrency(body.ingestConcurrency)
        : current.ingestConcurrency,
  };
  await saveWikiSettings(wikiPath, next);
  // Return both the saved settings and the model defaults for the UI's
  // "reset to default" affordance.
  return NextResponse.json({ ok: true, settings: next, defaults: DEFAULT_WIKI_SETTINGS });
}
