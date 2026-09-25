"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SLOTS = ["ingest", "query", "chat", "lint", "vision"] as const;
type Slot = (typeof SLOTS)[number];

// ─── Provider types ────────────────────────────────────────────────────────────
type Provider = "openrouter" | "ollama";

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama（本地）" },
];

// ─── OpenRouter model catalogue ────────────────────────────────────────────────
type ModelChoice = {
  id: string;
  label: string;
  notes: string;
  vision: boolean;
  /** OpenRouter `:free` route. Drives the free-tier banner + dropdown sorting. */
  free?: boolean;
};

const SUGGESTED: ReadonlyArray<ModelChoice> = [
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    notes: "便宜且快速",
    vision: true,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    notes: "智能且支持视觉",
    vision: true,
  },
  {
    id: "anthropic/claude-opus-4.7",
    label: "Claude Opus 4.7",
    notes: "能力最强，价格较高",
    vision: true,
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini",
    notes: "最便宜的可靠 JSON 输出",
    vision: true,
  },
  { id: "openai/gpt-4o", label: "GPT-4o", notes: "OpenAI 智能且支持视觉", vision: true },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    notes: "长上下文",
    vision: true,
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    notes: "Google 出品，便宜且快速",
    vision: true,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    notes: "开放权重，不支持视觉",
    vision: false,
  },
  // OpenRouter free tier. Picks bias toward larger models — smaller free
  // models tend to fail the wiki's JSON schema. Banner explains the tradeoffs.
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Llama 3.3 70B (free)",
    notes: "免费 · JSON 表现经过验证 · 入库／体检",
    vision: false,
    free: true,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron Super 120B (free)",
    notes: "免费 · 1M 上下文 · 查询／对话",
    vision: false,
    free: true,
  },
  {
    id: "deepseek/deepseek-v4-flash:free",
    label: "DeepSeek V4 Flash (free)",
    notes: "免费 · 推理快速 · 查询／对话",
    vision: false,
    free: true,
  },
  {
    id: "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B (free)",
    notes: "免费 · 支持视觉",
    vision: true,
    free: true,
  },
];

// ─── Ollama local model suggestions ───────────────────────────────────────────
type OllamaChoice = { id: string; label: string; notes: string; vision: boolean };

const OLLAMA_SUGGESTED: ReadonlyArray<OllamaChoice> = [
  { id: "llama3", label: "Llama 3 (8B)", notes: "Meta —— 快速且够用", vision: false },
  { id: "llama3:70b", label: "Llama 3 (70B)", notes: "Meta —— 质量最佳", vision: false },
  { id: "mistral", label: "Mistral 7B", notes: "全能选手", vision: false },
  { id: "mixtral", label: "Mixtral 8x7B", notes: "MoE，推理能力强", vision: false },
  { id: "phi3", label: "Phi-3 Mini", notes: "Microsoft —— 小巧快速", vision: false },
  { id: "phi3:medium", label: "Phi-3 Medium", notes: "Microsoft —— 表现均衡", vision: false },
  { id: "gemma2", label: "Gemma 2 (9B)", notes: "Google 开放模型", vision: false },
  { id: "qwen2", label: "Qwen 2 (7B)", notes: "Alibaba —— 多语言", vision: false },
  {
    id: "llava",
    label: "LLaVA",
    notes: "支持视觉的本地模型",
    vision: true,
  },
  {
    id: "moondream",
    label: "Moondream 2",
    notes: "小型视觉模型",
    vision: true,
  },
];

const CUSTOM_SENTINEL = "__custom__";

const SLOT_HINT: Record<Slot, string> = {
  ingest: "每次添加来源时运行。建议偏向便宜——调用次数会累积。",
  query: "一次性问答。建议偏向智能——答案是面向用户的。",
  chat: "多轮对话。新对话的默认值；单个对话的覆盖设置保存在该对话的 frontmatter 中。",
  lint: "对整个 wiki 做语义健康检查。建议使用智能模型。",
  vision: "PDF 和图片。必须支持视觉。",
};

// Slot ids are technical identifiers used by the API and by the per-slot
// <select> ids; only the visible label is localized.
const SLOT_LABEL: Record<Slot, string> = {
  ingest: "入库",
  query: "查询",
  chat: "对话",
  lint: "体检",
  vision: "视觉",
};

// ─── State shape ───────────────────────────────────────────────────────────────
// Mirrors the server's ModelSlotConfig: each slot stores both provider + model.
type SlotConfig = { provider: Provider; model: string };
type Models = Record<Slot, SlotConfig>;

// Shared <select> className to keep all dropdowns visually identical.
const SELECT_CLS = cn(
  "h-10 min-w-[16rem] rounded-md border border-input bg-background px-3 text-sm",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

export function ModelsTab() {
  const [models, setModels] = useState<Models | null>(null);
  const [original, setOriginal] = useState<Models | null>(null);

  // Per-slot: is this slot's value currently a custom slug (not in the relevant list)?
  const [customMode, setCustomMode] = useState<Record<Slot, boolean>>({
    ingest: false,
    query: false,
    chat: false,
    lint: false,
    vision: false,
  });

  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { settings: { defaultModels: Models } };
        const dm = data.settings.defaultModels;
        setModels(dm);
        setOriginal(dm);

        const knownOR = new Set(SUGGESTED.map((s) => s.id));
        const knownOL = new Set(OLLAMA_SUGGESTED.map((s) => s.id));
        const derivedCustom = {} as Record<Slot, boolean>;
        for (const slot of SLOTS) {
          const { provider, model } = dm[slot];
          derivedCustom[slot] =
            provider === "ollama" ? !knownOL.has(model) : !knownOR.has(model);
        }
        setCustomMode(derivedCustom);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  function updateSlot(slot: Slot, patch: Partial<SlotConfig>) {
    setModels((prev) => (prev ? { ...prev, [slot]: { ...prev[slot], ...patch } } : prev));
  }

  function onProviderChange(slot: Slot, value: Provider) {
    setCustomMode((m) => ({ ...m, [slot]: false }));
    // Reset model to a sensible default for the new provider
    const defaultModel =
      value === "ollama"
        ? (OLLAMA_SUGGESTED.find((m) => (slot === "vision" ? m.vision : true))?.id ?? "llama3")
        : (SUGGESTED.find((s) => (slot === "vision" ? s.vision : true))?.id ?? SUGGESTED[0]?.id ?? "openai/gpt-4o-mini");
    updateSlot(slot, { provider: value, model: defaultModel });
  }

  function onModelSelectChange(slot: Slot, value: string) {
    if (value === CUSTOM_SENTINEL) {
      setCustomMode((m) => ({ ...m, [slot]: true }));
      updateSlot(slot, { model: "" });
      return;
    }
    setCustomMode((m) => ({ ...m, [slot]: false }));
    updateSlot(slot, { model: value });
  }

  async function onSave() {
    if (!models) return;
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultModels: models }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOriginal(models);
      setFlash("已保存。后续操作会立即使用这些模型。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dirty = useMemo(
    () => !!models && !!original && SLOTS.some((s) => {
      return models[s].provider !== original[s].provider || models[s].model !== original[s].model;
    }),
    [models, original],
  );

  // Show the Ollama setup banner if ANY slot is currently configured to use
  // Ollama (saved state, not draft). Without local Ollama running, those slot
  // operations all fail with a generic "Connection error" — the banner makes
  // the requirement obvious before the user finds out the painful way.
  const ollamaSlots = useMemo(
    () => (original ? SLOTS.filter((s) => original[s].provider === "ollama") : []),
    [original],
  );

  // Free-tier banner trigger: any saved slot whose model slug is an
  // OpenRouter `:free` route. Distinct concern from Ollama (rate limits +
  // data-retention vs. local-install), distinct banner. Reads the *saved*
  // shape, not the draft, so editing doesn't make the banner flicker.
  const freeSlots = useMemo(
    () =>
      original
        ? SLOTS.filter(
            (s) => original[s].provider === "openrouter" && original[s].model.endsWith(":free"),
          )
        : [],
    [original],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">按操作选择模型</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          为每项操作分别选择提供方和模型。云端模型请使用{" "}
          <a
            href="https://openrouter.ai/models"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            OpenRouter
          </a>
          ，本地推理请使用{" "}
          <a
            href="https://ollama.com/library"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Ollama
          </a>
          。
        </p>
      </div>

      {/* Free-tier banner — visible when one or more slots use an
          OpenRouter `:free` model. Surfaces the rate-limit + data-retention
          tradeoffs the user implicitly opted into. Same amber palette as
          the Ollama banner since both are "you made a non-default choice
          with operational caveats". */}
      {freeSlots.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-4 py-3 text-sm">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            正在使用免费模型：{freeSlots.join("、")}{" "}
            {freeSlots.length === 1 ? "（1 个槽位）" : `（${freeSlots.length} 个槽位）`}
          </p>
          <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
            OpenRouter 的免费线路每次调用零成本，但有两点需要了解：
          </p>
          <ul className="ml-4 mt-1 list-disc space-y-0.5 text-amber-900/80 dark:text-amber-200/80">
            <li>
              <strong>速率限制。</strong>新账号约为每分钟 20 次请求、每天 50 次。
              为 OpenRouter 充值 ${"≥"}10 后每日上限会提升到约 1000 次——即使你用的是免费模型，
              这笔充值也能解锁更高的吞吐。
            </li>
            <li>
              <strong>数据留存。</strong>部分免费线路会经过保留提示词用于训练的提供方。
              不要通过 <code>:free</code> 线路传递任何机密内容。付费的 Anthropic / OpenAI
              线路不会共享数据。
            </li>
            <li>
              <strong>JSON 可靠性。</strong>wiki 的入库／查询／体检流程都要求严格的 JSON。
              如果遇到 <em>schema validation failed</em> 报错，免费模型很可能就是原因——
              请把该槽位换成付费模型。
            </li>
          </ul>
          <a
            href="https://openrouter.ai/docs/api-reference/limits"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-100"
          >
            OpenRouter 速率限制文档 →
          </a>
        </div>
      ) : null}

      {/* Ollama setup banner — visible when one or more slots already use
          Ollama. Static link to /local-models with install + hardware guidance.
          Not gated on Ollama actually being reachable (would need a server-
          side ping every render); just a "did you set this up?" reminder. */}
      {ollamaSlots.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-4 py-3 text-sm">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            Ollama 已用于 {ollamaSlots.length === 1 ? "1 个槽位" : `${ollamaSlots.length} 个槽位`}
            {ollamaSlots.length > 0 ? `（${ollamaSlots.join("、")}）` : ""}
          </p>
          <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
            Ollama 在你的机器上本地运行——必须先安装并启动，这些操作才能正常工作，
            否则会以通用的 <em>Connection error</em> 失败。安装步骤、模型推荐以及各模型
            所需的硬件配置请见配置指南。
          </p>
          <Link
            href="/local-models"
            className="mt-2 inline-block text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-100"
          >
            打开 Ollama 配置指南 →
          </Link>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      {!models ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <div className="space-y-5">
          {SLOTS.map((slot) => {
            const provider = models[slot].provider;
            const visionOnly = slot === "vision";
            const isOllama = provider === "ollama";

            // Pick which suggestion list to show
            const visibleOptions = isOllama
              ? visionOnly
                ? OLLAMA_SUGGESTED.filter((s) => s.vision)
                : OLLAMA_SUGGESTED
              : visionOnly
                ? SUGGESTED.filter((s) => s.vision)
                : SUGGESTED;

            const knownIds = new Set(visibleOptions.map((o) => o.id));
            const isCustom = customMode[slot] || !knownIds.has(models[slot].model);

            return (
              <div key={slot}>
                <label className="mb-1.5 block text-sm font-medium" htmlFor={`m-${slot}`}>
                  {SLOT_LABEL[slot]}
                </label>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {/* ── Provider picker ─────────────────────────────────── */}
                  <select
                    id={`p-${slot}`}
                    aria-label={`${SLOT_LABEL[slot]} 提供方`}
                    value={provider}
                    onChange={(e) => onProviderChange(slot, e.target.value as Provider)}
                    className={cn(SELECT_CLS, "min-w-[10rem]")}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>

                  {/* ── Model picker ────────────────────────────────────── */}
                  <select
                    id={`m-${slot}`}
                    value={isCustom ? CUSTOM_SENTINEL : models[slot].model}
                    onChange={(e) => onModelSelectChange(slot, e.target.value)}
                    className={cn(SELECT_CLS, "min-w-[16rem]")}
                  >
                    {visibleOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label} — {o.notes}
                      </option>
                    ))}
                    <option value={CUSTOM_SENTINEL}>
                      {isOllama ? "自定义（在下方输入模型名）" : "自定义（在下方输入模型标识）"}
                    </option>
                  </select>

                  {/* ── Custom model input ──────────────────────────────── */}
                  {isCustom ? (
                    <Input
                      value={models[slot].model}
                      onChange={(e) => updateSlot(slot, { model: e.target.value })}
                      placeholder={isOllama ? "例如 llama3:latest" : "provider/model-id"}
                      className="font-mono text-[13px] sm:flex-1"
                    />
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">{models[slot].model}</span>
                  )}
                </div>

                {/* Ollama hint */}
                {isOllama && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    保存前请先确认{" "}
                    <code className="font-mono">ollama run {models[slot].model || "<model>"}</code>{" "}
                    能在本机正常运行。
                  </p>
                )}

                <p className="mt-1 text-xs text-muted-foreground">{SLOT_HINT[slot]}</p>
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-2">
            <Button onClick={onSave} disabled={!dirty || busy}>
              {busy ? "保存中…" : dirty ? "保存模型" : "已保存"}
            </Button>
            {flash ? <span className="text-sm text-muted-foreground">{flash}</span> : null}
          </div>
        </div>
      )}

      <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">模型标识会过期。</strong>{" "}
        提供方会定期下线旧版本。如果某项操作报错{" "}
        <code className="font-mono">model not available on OpenRouter</code>
        ，请从下拉列表中为该槽位选择当前可用的模型。使用 Ollama 时，可运行{" "}
        <code className="font-mono">ollama list</code> 查看本地已安装的模型。
      </div>
    </div>
  );
}
