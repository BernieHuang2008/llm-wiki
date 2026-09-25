"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Declared locally rather than imported from @llm-wiki/core: this is a client
// component, and a type-only import would still pull the server package into
// the client module graph for no benefit.
type KeyProvider = "openrouter" | "deepseek";

type Props = {
  needsTopic: boolean;
  needsKey: boolean;
  initialTopic: string;
  wikiPath: string;
  /**
   * True only on the very first app open (no onboardingCompletedAt in
   * global config yet). Drives the choice between the full 4-step welcome
   * wizard and the minimal topic+key form returning users see if they
   * spin up a new wiki later that's missing one of those.
   */
  isFirstRun: boolean;
  /**
   * Which provider's key is actually missing. The gate can be tripped by a
   * DeepSeek-backed slot just as easily as an OpenRouter one, and asking for
   * the wrong field would leave the user unable to satisfy it.
   */
  requiredProvider: KeyProvider;
  /** Slot whose gate sent the user here (e.g. "chat"), for an honest message. */
  blockedSlot: string | null;
};

const PROVIDER_LABEL: Record<KeyProvider, string> = {
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
};

const PROVIDER_KEY_URL: Record<KeyProvider, { href: string; label: string }> = {
  openrouter: { href: "https://openrouter.ai/keys", label: "openrouter.ai/keys" },
  deepseek: { href: "https://platform.deepseek.com/api_keys", label: "platform.deepseek.com" },
};

const SLOT_LABEL: Record<string, string> = {
  ingest: "Ingest（来源）",
  query: "查询",
  chat: "对话",
  lint: "体检",
  vision: "视觉",
};

type Step = "welcome" | "topic" | "key" | "tour";
const STEP_ORDER: Step[] = ["welcome", "topic", "key", "tour"];

export function Onboarding(props: Props) {
  // First-run users get the full wizard; everyone else gets the same compact
  // form we've always had. Single component so the save plumbing is shared.
  if (props.isFirstRun) {
    return <FirstRunWizard {...props} />;
  }
  return <MinimalOnboarding {...props} />;
}

// ---- the welcome wizard -------------------------------------------------

// Curated free-model defaults the wizard writes when the user opts in.
// Mirrors the picks shipped in v1.2.3's Settings → Models dropdown. Each
// slot is biased toward the largest free model that reliably produces
// strict JSON. Centralizing here so future updates (model rotates out of
// the free tier, better option ships) live in one place.
const FREE_MODEL_DEFAULTS = {
  ingest: { provider: "openrouter" as const, model: "meta-llama/llama-3.3-70b-instruct:free" },
  query:  { provider: "openrouter" as const, model: "nvidia/nemotron-3-super-120b-a12b:free" },
  chat:   { provider: "openrouter" as const, model: "nvidia/nemotron-3-super-120b-a12b:free" },
  lint:   { provider: "openrouter" as const, model: "meta-llama/llama-3.3-70b-instruct:free" },
  vision: { provider: "openrouter" as const, model: "google/gemma-4-31b-it:free" },
};

function FirstRunWizard(props: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [topic, setTopic] = useState(props.initialTopic);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  // User's free-models opt-in toggle on the key step. Drives whether the
  // wizard writes FREE_MODEL_DEFAULTS to /api/settings alongside the key.
  const [useFreeModels, setUseFreeModels] = useState(false);

  function goTo(next: Step) {
    setError(null);
    setStep(next);
  }

  async function persist(topicToSave: string, keyToSave: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      if (props.needsTopic && topicToSave.trim()) {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: topicToSave.trim() }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `topic save failed: HTTP ${res.status}`);
        }
      }
      if (props.needsKey && keyToSave.trim()) {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: keyToSave.trim(),
            provider: props.requiredProvider,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `key save failed: HTTP ${res.status}`);
        }
      }
      // Free-models opt-in: write the curated defaults to settings.json.
      // PUT /api/settings merges partial slot configs into existing ones,
      // so this leaves any other settings field (topic, approval gate,
      // theme, etc.) untouched.
      if (useFreeModels) {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaultModels: FREE_MODEL_DEFAULTS }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `models save failed: HTTP ${res.status}`);
        }
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function markOnboardingDone(): Promise<void> {
    try {
      await fetch("/api/onboarding", { method: "POST" });
    } catch {
      // Non-fatal — the user just sees the wizard again on next visit,
      // which is annoying but not broken. Don't gate the redirect on it.
    }
  }

  // Skip from any step: save whatever's been entered, mark onboarding done,
  // and fall back to the minimal form (which only shows if topic/key still
  // missing — otherwise the dashboard appears).
  async function onSkip() {
    await persist(topic, key);
    await markOnboardingDone();
    router.refresh();
  }

  async function onTest() {
    if (!key.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestMessage(null);
    try {
      const res = await fetch("/api/config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        setTestResult("ok");
        setTestMessage("密钥可用 — OpenRouter 已响应。");
      } else {
        setTestResult("fail");
        setTestMessage(json.error ?? "测试失败。");
      }
    } catch (err) {
      setTestResult("fail");
      setTestMessage((err as Error).message);
    } finally {
      setTesting(false);
    }
  }

  // Step 3 → Step 4 transition: save before advancing so the user can't
  // back-button into a state where their data was lost.
  async function onAdvanceFromKey() {
    const ok = await persist(topic, key);
    if (ok) goTo("tour");
  }

  // Step 4 final: mark onboarding complete + navigate the user to Sources
  // where they take their first real action (ingesting a source).
  async function onFinish(destination: "sources" | "home" = "sources") {
    await markOnboardingDone();
    if (destination === "sources") router.push("/sources");
    else router.refresh();
  }

  const currentIdx = STEP_ORDER.indexOf(step);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-16 pt-12">
      {/* Stepper — visible only after the welcome screen to keep step 1
          uncluttered. Calm dots, no labels (would crowd the layout). */}
      {step !== "welcome" ? (
        <ol className="mb-8 flex items-center justify-center gap-2" aria-label="进度">
          {STEP_ORDER.slice(1).map((s, i) => {
            const idx = i + 1;
            const active = currentIdx === idx;
            const done = currentIdx > idx;
            return (
              <li
                key={s}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "h-1.5 w-10 rounded-full transition-colors",
                  done ? "bg-primary" : active ? "bg-primary/70" : "bg-border",
                )}
              />
            );
          })}
        </ol>
      ) : null}

      {step === "welcome" ? (
        <WelcomeStep
          wikiPath={props.wikiPath}
          onNext={() => goTo("topic")}
          onSkip={onSkip}
          busy={busy}
        />
      ) : null}

      {step === "topic" ? (
        <TopicStep
          topic={topic}
          setTopic={setTopic}
          onBack={() => goTo("welcome")}
          onNext={() => goTo("key")}
          onSkip={onSkip}
          busy={busy}
        />
      ) : null}

      {step === "key" ? (
        <KeyStep
          apiKey={key}
          setApiKey={setKey}
          // When the user is replaying the tour, an OpenRouter key is
          // already on disk (we just don't surface it here for security).
          // Let them advance without re-typing it.
          alreadyHasKey={!props.needsKey}
          useFreeModels={useFreeModels}
          setUseFreeModels={setUseFreeModels}
          onBack={() => goTo("topic")}
          onNext={onAdvanceFromKey}
          onSkip={onSkip}
          onTest={onTest}
          testing={testing}
          testResult={testResult}
          testMessage={testMessage}
          busy={busy}
          error={error}
        />
      ) : null}

      {step === "tour" ? (
        <TourStep
          onBack={() => goTo("key")}
          onSkip={() => void onFinish("home")}
          onFinish={() => void onFinish("sources")}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

// ---- step components ----------------------------------------------------

function WelcomeStep({
  wikiPath,
  onNext,
  onSkip,
  busy,
}: {
  wikiPath: string;
  onNext: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  return (
    <div className="text-center">
      <p
        aria-hidden
        className="font-mono text-3xl leading-none text-primary"
      >
        [[
      </p>
      <h1 className="mt-4 font-display text-display font-semibold tracking-tight">
        LLM Wiki
      </h1>
      <p className="mx-auto mt-4 max-w-lg text-body font-serif text-muted-foreground">
        一个由 LLM 为你维护的个人维基百科。放入文章、论文、笔记 ——
        智能体会阅读它们并撰写互相链接的页面。知识会不断累积。
      </p>
      <p className="mx-auto mt-2 max-w-lg text-caption text-muted-foreground">
        你的知识库以纯 markdown 文件形式存放在{" "}
        <code className="font-mono">{wikiPath}</code>，完全归你所有。
      </p>
      <div className="mt-8 flex items-center justify-center gap-4">
        <Button onClick={onNext} disabled={busy}>
          开始使用 →
        </Button>
      </div>
      <button
        type="button"
        onClick={onSkip}
        disabled={busy}
        className="mt-4 text-caption text-muted-foreground hover:text-foreground"
      >
        跳过引导
      </button>
    </div>
  );
}

function TopicStep({
  topic,
  setTopic,
  onBack,
  onNext,
  onSkip,
  busy,
}: {
  topic: string;
  setTopic: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const ready = topic.trim().length > 0;
  return (
    <div>
      <p className="text-caption uppercase tracking-wider text-muted-foreground">
        第 1 步 / 共 3 步
      </p>
      <h2 className="mt-2 font-display text-h1 font-semibold tracking-tight">
        这个知识库是关于什么的？
      </h2>
      <p className="mt-3 text-body font-serif text-muted-foreground">
        用一句话描述它的范围。LLM 在每次操作中都会读取它 ——
        Ingest、查询、体检 —— 所以要具体，而不是泛泛而谈。
      </p>
      <Input
        autoFocus
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ready) onNext();
        }}
        placeholder='例如“量子计算研究及其背后的算法”'
        className="mt-5 text-base"
      />
      <p className="mt-2 text-caption text-muted-foreground">
        你之后可以在 设置 → 通用 中修改。
      </p>
      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          ← 上一步
        </Button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            跳过引导
          </button>
          <Button onClick={onNext} disabled={!ready || busy}>
            下一步 →
          </Button>
        </div>
      </div>
    </div>
  );
}

function KeyStep({
  apiKey,
  setApiKey,
  alreadyHasKey,
  onBack,
  onNext,
  onSkip,
  onTest,
  testing,
  testResult,
  testMessage,
  busy,
  error,
  useFreeModels,
  setUseFreeModels,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  alreadyHasKey: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onTest: () => void;
  testing: boolean;
  testResult: "ok" | "fail" | null;
  testMessage: string | null;
  busy: boolean;
  error: string | null;
  useFreeModels: boolean;
  setUseFreeModels: (v: boolean) => void;
}) {
  // Replay flow: a key is already on disk; let the user advance with the
  // input empty. New-install flow: require a non-empty key.
  const ready = alreadyHasKey || apiKey.trim().length > 0;
  return (
    <div>
      <p className="text-caption uppercase tracking-wider text-muted-foreground">
        第 2 步 / 共 3 步
      </p>
      <h2 className="mt-2 font-display text-h1 font-semibold tracking-tight">
        OpenRouter API 密钥
      </h2>
      <p className="mt-3 text-body font-serif text-muted-foreground">
        你需要自带密钥 —— 我们永远看不到它。一个密钥即可通过{" "}
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          openrouter.ai/keys
        </a>
        访问 Claude / GPT / Gemini / Llama。按量付费，没有最低消费。
      </p>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Input
          autoFocus
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={alreadyHasKey ? "留空以保留当前密钥" : "sk-or-v1-..."}
          className="font-mono text-[13px] sm:flex-1"
          autoComplete="off"
        />
        {/* Test always needs a typed key — it validates new input, not the
            stored one. So gate on `apiKey`, not `ready` (which is true on
            replay regardless of input). */}
        <Button variant="outline" onClick={onTest} disabled={!apiKey.trim() || testing || busy}>
          {testing ? "测试中…" : "测试"}
        </Button>
      </div>
      {testMessage ? (
        <p
          className={cn(
            "mt-2 text-xs",
            testResult === "ok"
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-destructive",
          )}
        >
          {testMessage}
        </p>
      ) : null}
      <p className="mt-2 text-caption text-muted-foreground">
        在系统支持时存入操作系统钥匙串，否则存入{" "}
        <code className="font-mono">~/.llm-wiki/config.json</code>（权限 600）。
        绝不提交到 git。
      </p>

      {/* Free-models opt-in. One toggle button that sets sensible defaults
          across all five slots. The OpenRouter account/key above is still
          required — what changes is the per-call cost (zero). Caveats
          (rate limits, data retention) surface as a Settings banner once
          the user lands inside the app. */}
      <div className="mt-6 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">
          希望每次调用零成本？使用 OpenRouter 的免费模型。
        </p>
        <p className="mt-1 text-muted-foreground">
          上面的密钥仍然需要（OpenRouter 账号是免费的，只有额度需要付费）。
          点击一下，我们就会为全部五项操作设置以下默认模型：
        </p>
        <ul className="mt-2 space-y-0.5 text-muted-foreground">
          <li>
            <span className="font-mono text-xs">ingest / lint</span> · Llama
            3.3 70B（免费）
          </li>
          <li>
            <span className="font-mono text-xs">query / chat</span> ·
            Nemotron Super 120B（免费）
          </li>
          <li>
            <span className="font-mono text-xs">vision</span> · Gemma 4 31B
            （免费）
          </li>
        </ul>
        <p className="mt-2 text-caption text-muted-foreground">
          存在速率限制（约 20 次/分钟、约 50 次/天），且部分提供商可能会保留数据用于
          训练 —— 设置 → 模型 中会有横幅说明。之后可以在那里修改任何默认值。
        </p>
        <Button
          variant={useFreeModels ? "default" : "outline"}
          size="sm"
          onClick={() => setUseFreeModels(!useFreeModels)}
          disabled={busy}
          className="mt-3"
        >
          {useFreeModels
            ? "✓ 将使用免费模型（点击可撤销）"
            : "默认使用免费模型"}
        </Button>
      </div>

      {error ? (
        <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          ← 上一步
        </Button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            跳过引导
          </button>
          <Button onClick={onNext} disabled={!ready || busy}>
            {busy ? "保存中…" : "下一步 →"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TourStep({
  onBack,
  onSkip,
  onFinish,
  busy,
}: {
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
  busy: boolean;
}) {
  return (
    <div>
      <p className="text-caption uppercase tracking-wider text-muted-foreground">
        第 3 步 / 共 3 步
      </p>
      <h2 className="mt-2 font-display text-h1 font-semibold tracking-tight">
        接下来你会做的事
      </h2>
      <p className="mt-3 text-body font-serif text-muted-foreground">
        五个界面，一套流程。每一项操作都作用于你刚刚设置好的知识库文件夹。
      </p>

      <ul className="mt-6 space-y-3">
        <TourRow
          numeral="①"
          title="Source"
          body="粘贴一篇文章、拖入 PDF，或抓取一个 URL。智能体会读取它并撰写页面。"
        />
        <TourRow
          numeral="②"
          title="知识库"
          body="浏览 LLM 撰写、按类型分组的页面。每个页面都有完整的反向链接与Source脉络。"
        />
        <TourRow
          numeral="③"
          title="图谱"
          body="以网络形式呈现知识的 3D 视图 —— 页面是节点，交叉链接是边。随着Ingest增多，看它不断生长。"
        />
        <TourRow
          numeral="④"
          title="查询 / 对话"
          body="提出带引用的单次问题，或进行多轮对话。把好的回答保存回知识库。"
        />
        <TourRow
          numeral="⑤"
          title="体检"
          body="定期健康检查 —— 矛盾、失效链接、内容缺口 —— 支持一键修复。"
        />
      </ul>

      <p className="mt-6 text-caption text-muted-foreground">
        完整的操作指南在 <Link href="/help" className="text-primary underline underline-offset-2">/help</Link>，进入应用后即可查看。
      </p>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          ← 上一步
        </Button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            跳过
          </button>
          <Button onClick={onFinish} disabled={busy}>
            {busy ? "…" : "带我去Source页 →"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TourRow({
  numeral,
  title,
  body,
}: {
  numeral: string;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-baseline gap-4 rounded-md border border-border/70 bg-card p-4">
      <span aria-hidden className="font-display text-h2 text-primary/80">
        {numeral}
      </span>
      <div>
        <p className="font-display text-h3 font-medium tracking-tight">{title}</p>
        <p className="mt-0.5 text-ui text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}

// ---- minimal form (returning users) -------------------------------------

// The original single-card layout. Fires when a wiki has missing topic/key
// AFTER the user has already completed the welcome wizard at some point.
// Common case: they created a new wiki via Settings → Wikis → Create and
// somehow ended up here (shouldn't happen often since the Create form
// collects the topic), or the API key got removed.
function MinimalOnboarding({
  needsTopic,
  needsKey,
  initialTopic,
  wikiPath,
}: Props) {
  const router = useRouter();
  const [topic, setTopic] = useState(initialTopic);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const canSubmit =
    (!needsTopic || topic.trim().length > 0) &&
    (!needsKey || key.trim().length > 0) &&
    !busy;

  async function onTest() {
    if (!key.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestMessage(null);
    try {
      const res = await fetch("/api/config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        setTestResult("ok");
        setTestMessage("密钥可用 — OpenRouter 已响应。");
      } else {
        setTestResult("fail");
        setTestMessage(json.error ?? "测试失败。");
      }
    } catch (err) {
      setTestResult("fail");
      setTestMessage((err as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      if (needsTopic && topic.trim()) {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: topic.trim() }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `topic save failed: HTTP ${res.status}`);
        }
      }
      if (needsKey && key.trim()) {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: key.trim() }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `key save failed: HTTP ${res.status}`);
        }
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-16 pt-16">
      <header className="mb-8">
        <p className="text-caption uppercase tracking-wider text-muted-foreground">
          就快好了
        </p>
        <h1 className="mt-2 font-display text-display font-semibold">
          完成这个知识库的设置。
        </h1>
        <p className="mt-3 text-body text-muted-foreground">
          {needsTopic && needsKey
            ? "我们只需要一个主题和一个 OpenRouter 密钥就可以开始了。"
            : needsTopic
              ? "我们只需要为这个知识库填一个主题。"
              : "我们只需要一个 OpenRouter 密钥来启用 LLM。"}{" "}
          知识库位于 <code className="font-mono text-[13px]">{wikiPath}</code>。
        </p>
      </header>

      <div className="space-y-6 rounded-lg border border-border bg-card p-6">
        {needsTopic ? (
          <section>
            <h2 className="font-display text-h3 font-semibold">
              {needsKey ? "1. " : ""}这个知识库是关于什么的？
            </h2>
            <p className="mt-1 text-ui text-muted-foreground">
              一句话。LLM 在每次Ingest和查询时都会读取它，所以越具体越好。
            </p>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如“量子计算研究”"
              className="mt-3"
              autoFocus
            />
          </section>
        ) : null}

        {needsKey ? (
          <section>
            <h2 className="font-display text-h3 font-semibold">
              {needsTopic ? "2. " : ""}OpenRouter API 密钥
            </h2>
            <p className="mt-1 text-ui text-muted-foreground">
              在{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                openrouter.ai/keys
              </a>
              获取。在系统支持时存入操作系统钥匙串。
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-or-v1-..."
                className="font-mono text-[13px] sm:flex-1"
                autoComplete="off"
              />
              <Button
                variant="outline"
                onClick={onTest}
                disabled={!key.trim() || testing}
              >
                {testing ? "测试中…" : "测试"}
              </Button>
            </div>
            {testMessage ? (
              <p
                className={cn(
                  "mt-2 text-xs",
                  testResult === "ok"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-destructive",
                )}
              >
                {testMessage}
              </p>
            ) : null}
          </section>
        ) : null}

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end border-t border-border pt-4">
          <Button onClick={onSave} disabled={!canSubmit}>
            {busy ? "保存中…" : "保存并继续"}
          </Button>
        </div>
      </div>
    </div>
  );
}
