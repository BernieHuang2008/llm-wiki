"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoHint, SettingsRow } from "@/components/settings/info-hint";
import { useTheme, type UiTheme } from "@/components/theme-provider";

type SettingsResponse = {
  settings: {
    topic: string;
    requireApprovalForIngest?: boolean;
    ingestConcurrency?: number;
  };
  wikiPath: string;
};

const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10] as const;

const THEME_LABEL: Record<UiTheme, string> = {
  light: "浅色",
  dark: "深色",
  auto: "跟随系统",
};

export function GeneralTab() {
  const { theme, setTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  useEffect(() => setThemeMounted(true), []);

  const [topic, setTopic] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [wikiPath, setWikiPath] = useState<string>("");
  const [requireApproval, setRequireApproval] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [ingestConcurrency, setIngestConcurrency] = useState(1);
  const [concurrencySaving, setConcurrencySaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SettingsResponse;
        setTopic(data.settings.topic);
        setOriginal(data.settings.topic);
        setWikiPath(data.wikiPath);
        setRequireApproval(Boolean(data.settings.requireApprovalForIngest));
        setIngestConcurrency(data.settings.ingestConcurrency ?? 1);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  // Flash messages are acknowledgement, not state — they have no business
  // staying on screen after the user has moved on to the next row.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  async function saveIngestConcurrency(next: number) {
    setConcurrencySaving(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ingestConcurrency: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SettingsResponse;
      setIngestConcurrency(data.settings.ingestConcurrency ?? next);
      setFlash("已保存。并发数对下一个取到的任务立即生效，无需重启。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConcurrencySaving(false);
    }
  }

  async function toggleRequireApproval(next: boolean) {
    setApprovalSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requireApprovalForIngest: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRequireApproval(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApprovalSaving(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOriginal(topic);
      setFlash("已保存。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dirty = topic !== original;
  const settingsPath = `${wikiPath || "<wiki>"}/.llm-wiki/settings.json`;

  return (
    <div className="space-y-4">
      <div className="divide-y divide-border/70">
        <SettingsRow
          title="Wiki 主题"
          hint={
            <>
              <p>
                用一句话描述<strong>这个</strong> wiki 的范围。智能体在每次Ingest和查询时都会读取它，
                所以请写得具体一些。
              </p>
              <p className="mt-2">
                保存到 <code>{settingsPath}</code>
              </p>
              <p className="mt-2">
                <strong>按设计，一个 wiki 只对应一个主题。</strong>一个 wiki 就是一个文件夹；
                上面的主题描述的是该文件夹的范围。若要让多个主题彼此隔离（例如量子计算
                <em>和</em>机器学习），请再创建一个 wiki 文件夹，并把应用指向它：
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-background/70 p-2 font-mono text-[11px] text-foreground/80">
{`# stop the dev server, then:
export LLM_WIKI_PATH=~/llm-wiki-machine-learning
pnpm dev

# or via the CLI:
llm-wiki start ~/llm-wiki-machine-learning`}
              </pre>
              <p className="mt-2">
                按照 Karpathy 的模式，每个 wiki 都是一个自包含的语料库。切换文件夹会一次性切换
                所有页面、对话、Source和 schema。
              </p>
            </>
          }
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：量子计算研究"
              className="sm:flex-1"
            />
            {/* Reserved whether or not the button shows, so saving a topic
                doesn't shift the rows below it. */}
            <div className="flex h-10 shrink-0 items-center justify-end">
              {dirty ? (
                <Button onClick={onSave} disabled={busy} size="sm">
                  {busy ? "保存中…" : "保存"}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">已保存</span>
              )}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Ingest审批把关"
          hint={
            <>
              开启后，每次Ingest都会先向你展示大语言模型提议的改动（新页面、页面更新、矛盾之处），
              在你确认之前不会写入任何内容。点击「应用」才会提交。当你并不完全信任某个廉价的
              Ingest模型时很有用——或者只是想先看看模型打算怎么改你的 wiki。
            </>
          }
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={requireApproval}
              disabled={approvalSaving}
              onChange={(e) => void toggleRequireApproval(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm">
              应用Ingest改动前需要审批
              {approvalSaving ? (
                <span className="ml-2 text-xs text-muted-foreground">保存中…</span>
              ) : null}
            </span>
          </label>
        </SettingsRow>

        <SettingsRow
          title="Ingest并发数"
          hint={
            <>
              <p>
                同时执行多少个Ingest任务。默认 1（串行），也是唯一完全安全的取值：每次Ingest在
                开始时读取当前索引，提交时合并写回，因此并发更新<em>同一个页面</em>时，后提交的会
                覆盖先提交的（提交阶段有写入锁保护，所以索引不会损坏，代价是重复劳动）。
                导入一批互不相关的文件时，调高它可以明显加快速度。
              </p>
              <p className="mt-2">改动对下一个取到的任务立即生效，无需重启。</p>
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="并发任务数"
              value={ingestConcurrency}
              disabled={concurrencySaving}
              onChange={(e) => void saveIngestConcurrency(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {CONCURRENCY_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1（串行，推荐）" : `${n} 个并发`}
                </option>
              ))}
            </select>
            {concurrencySaving ? (
              <span className="text-xs text-muted-foreground">保存中…</span>
            ) : null}
            {ingestConcurrency > 1 ? (
              <span className="text-xs text-amber-800 dark:text-amber-200">
                若这批文件会引用同一批概念／实体，请考虑用 1，或在入库后跑一次体检检查是否有页面被覆盖。
              </span>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          title="主题外观"
          hint={
            <>
              立即生效。保存在 <code>localStorage</code> 中，因此可跨会话保持。
            </>
          }
        >
          {/* Server can't read localStorage, so render a placeholder until the
              client mounts. Avoids a hydration-mismatch on the active button's
              background color. */}
          {themeMounted ? (
            <div className="inline-flex rounded-md border border-border bg-secondary/40 p-1 text-sm">
              {(["light", "dark", "auto"] as UiTheme[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTheme(t)}
                  className={
                    "rounded px-3 py-1 " +
                    (theme === t
                      ? "bg-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {THEME_LABEL[t]}
                </button>
              ))}
            </div>
          ) : (
            <div className="inline-block h-9 w-[14rem] rounded-md border border-border bg-secondary/40" />
          )}
        </SettingsRow>
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}
      {flash ? <p className="text-sm text-muted-foreground">{flash}</p> : null}

      <p className="border-t border-border/70 pt-3 text-xs text-muted-foreground">
        这些偏好保存在 <code>{settingsPath}</code>
      </p>
    </div>
  );
}
