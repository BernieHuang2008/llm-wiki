"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type KeyProvider = "openrouter" | "deepseek";

type ApiKeyStatus = {
  provider: KeyProvider;
  configured: boolean;
  source: "keychain" | "config" | "none";
  keychainAvailable: boolean;
  hint: string | null;
};

type ApiKeyStatusMap = Record<KeyProvider, ApiKeyStatus>;

type TestResult = {
  ok: boolean;
  provider?: KeyProvider;
  reason?: string;
  message?: string;
  label?: string | null;
  usageUsd?: number | null;
  limitUsd?: number | null;
  modelCount?: number;
};

type ProviderMeta = {
  id: KeyProvider;
  title: string;
  /** Text before the "get a key here" link. */
  blurb: string;
  keyUrl: string;
  keyUrlLabel: string;
  placeholder: string;
  /** OpenRouter keys have a recognisable prefix; DeepSeek's are opaque. */
  maskedPrefix: string;
};

const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "openrouter",
    title: "OpenRouter API Key",
    blurb: "一个密钥即可访问数百个模型（Claude、GPT、Gemini 等）。可在",
    keyUrl: "https://openrouter.ai/keys",
    keyUrlLabel: "openrouter.ai/keys",
    placeholder: "sk-or-v1-...",
    maskedPrefix: "sk-or-v1-",
  },
  {
    id: "deepseek",
    title: "DeepSeek API Key",
    blurb:
      "DeepSeek 官方接口，base URL 为 https://api.deepseek.com（不经由第三方路由）。可在",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyUrlLabel: "platform.deepseek.com",
    placeholder: "sk-...",
    maskedPrefix: "sk-",
  },
];

export function ApiTab() {
  const [statuses, setStatuses] = useState<ApiKeyStatusMap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keychainAvailable, setKeychainAvailable] = useState(true);

  async function refresh() {
    setLoadError(null);
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) throw new Error(`/api/config 返回 ${res.status}`);
      const json = (await res.json()) as {
        statuses?: ApiKeyStatusMap;
        keychainAvailable?: boolean;
      };
      if (json.statuses) {
        setStatuses(json.statuses);
        setKeychainAvailable(json.statuses.openrouter.keychainAvailable);
      }
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-medium">API 密钥</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          密钥可用时保存在系统钥匙串中，否则保存在{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.llm-wiki/config.json</code>{" "}
          中（权限 0600）。每个提供方的密钥互相独立。
        </p>
      </div>

      {loadError ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : null}

      {statuses === null ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        PROVIDERS.map((meta) => (
          <ProviderKeyCard
            key={meta.id}
            meta={meta}
            status={statuses[meta.id]}
            keychainAvailable={keychainAvailable}
            onChanged={refresh}
          />
        ))
      )}

      <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
        要使用本地模型（Ollama）无需密钥：请在“模型”标签页把某个用途的提供方切换为
        Ollama。Ollama 与 DeepSeek 的模型 id 与 OpenRouter 的{" "}
        <code className="font-mono">provider/model</code> 写法不同，请不要混用。
      </div>
    </div>
  );
}

function ProviderKeyCard({
  meta,
  status,
  keychainAvailable,
  onChanged,
}: {
  meta: ProviderMeta;
  status: ApiKeyStatus;
  keychainAvailable: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(!status.configured);
  const [busy, setBusy] = useState<"save" | "delete" | "test" | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // A key appearing or disappearing (e.g. after save/remove) re-syncs the mode.
  useEffect(() => {
    setEditing(!status.configured);
  }, [status.configured]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy("save");
    setFlash(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: draft.trim(), provider: meta.id }),
      });
      const json = (await res.json()) as { source?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDraft("");
      setFlash(`已保存到${json.source === "keychain" ? "系统钥匙串" : "配置文件"}。`);
      await onChanged();
    } catch (err) {
      setFlash(`保存失败：${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!confirm(`要移除已保存的 ${meta.title} 吗？`)) return;
    setBusy("delete");
    setFlash(null);
    setTestResult(null);
    try {
      const res = await fetch(`/api/config?provider=${meta.id}`, { method: "DELETE" });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setFlash("密钥已移除。");
      await onChanged();
    } catch (err) {
      setFlash(`删除失败：${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    setTestResult(null);
    try {
      const res = await fetch("/api/config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: meta.id }),
      });
      setTestResult((await res.json()) as TestResult);
    } catch (err) {
      setTestResult({ ok: false, reason: "network", message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  function maskedKey(hint: string | null): string {
    // Reconstruct a representative shape rather than storing the raw key
    // client-side.
    const dots = "•".repeat(16);
    return hint ? `${meta.maskedPrefix}${dots}${hint}` : `${meta.maskedPrefix}${dots}••••`;
  }

  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="text-base font-medium">{meta.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {meta.blurb}
        <a
          className="underline underline-offset-2 hover:text-foreground"
          href={meta.keyUrl}
          target="_blank"
          rel="noreferrer"
        >
          {meta.keyUrlLabel}
        </a>
        {" 获取密钥。"}
      </p>

      {status.configured && !editing ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">当前密钥</label>
            <div className="flex items-stretch gap-2">
              <div
                className="flex h-10 flex-1 select-none items-center rounded-md border border-input bg-muted/40 px-3 font-mono text-sm text-foreground/80"
                aria-label="已保存的 API 密钥（已遮蔽）"
              >
                {maskedKey(status.hint)}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft("");
                  setEditing(true);
                  setFlash(null);
                  setTestResult(null);
                }}
              >
                更换
              </Button>
            </div>
            <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              保存在{status.source === "keychain" ? "系统钥匙串" : "配置文件"}中
              {status.hint ? (
                <>
                  ，末四位为 <code>…{status.hint}</code>
                </>
              ) : null}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onTest} disabled={busy !== null}>
              {busy === "test" ? "测试中…" : "测试连接"}
            </Button>
            <Button type="button" variant="ghost" onClick={onDelete} disabled={busy !== null}>
              {busy === "delete" ? "移除中…" : "移除"}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSave} className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor={`api-key-${meta.id}`}>
              {status.configured ? "新密钥" : "粘贴你的密钥"}
            </label>
            <Input
              id={`api-key-${meta.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={meta.placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono"
            />
            {!keychainAvailable ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                注意：本系统不支持系统钥匙串。密钥将保存到你的主目录中一个权限受限的文件里。
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!draft.trim() || busy !== null}>
              {busy === "save" ? "保存中…" : "保存密钥"}
            </Button>
            {status.configured ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft("");
                  setEditing(false);
                  setFlash(null);
                }}
                disabled={busy !== null}
              >
                取消
              </Button>
            ) : null}
          </div>
        </form>
      )}

      {flash ? <p className="mt-2 text-sm text-muted-foreground">{flash}</p> : null}

      {testResult ? (
        <div
          className={
            "mt-3 rounded-md px-3 py-2 text-sm " +
            (testResult.ok
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "bg-destructive/10 text-destructive")
          }
        >
          {testResult.ok ? (
            <span>
              密钥可用。
              {testResult.label ? (
                <>
                  {" "}
                  账号：<strong>{testResult.label}</strong>。
                </>
              ) : null}
              {typeof testResult.modelCount === "number"
                ? ` 该密钥可访问 ${testResult.modelCount} 个模型。`
                : null}
              {typeof testResult.usageUsd === "number"
                ? testResult.limitUsd !== null && testResult.limitUsd !== undefined
                  ? ` 已使用 $${testResult.usageUsd.toFixed(2)}，额度上限 $${testResult.limitUsd.toFixed(2)}。`
                  : ` 累计用量 $${testResult.usageUsd.toFixed(2)}。`
                : null}
            </span>
          ) : (
            <span>{testResult.message ?? "测试失败。"}</span>
          )}
        </div>
      ) : null}
    </section>
  );
}
