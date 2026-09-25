"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme, type UiTheme } from "@/components/theme-provider";

type SettingsResponse = {
  settings: {
    topic: string;
    requireApprovalForIngest?: boolean;
  };
  wikiPath: string;
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
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Wiki 主题</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          用一句话描述<strong>这个</strong> wiki 的范围。智能体在每次Ingest和查询时都会读取它，
          所以请写得具体一些。
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例如：量子计算研究"
            className="sm:flex-1"
          />
          <Button onClick={onSave} disabled={!dirty || busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          保存到 <code>{wikiPath || "<wiki>"}/.llm-wiki/settings.json</code>
        </p>

        <div className="mt-4 rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">按设计，一个 wiki 只对应一个主题。</strong>{" "}
            一个 wiki 就是一个文件夹；上面的主题描述的是该文件夹的范围。若要让多个主题彼此隔离
            （例如量子计算<em>和</em>机器学习），请再创建一个 wiki 文件夹，并把应用指向它：
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
        </div>
      </div>

      <div>
        <h2 className="text-lg font-medium">Ingest审批把关</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          开启后，每次Ingest都会先向你展示大语言模型提议的改动（新页面、页面更新、矛盾之处），
          在你确认之前不会写入任何内容。点击「应用」才会提交。当你并不完全信任某个廉价的
          Ingest模型时很有用——或者只是想先看看模型打算怎么改你的 wiki。
        </p>
        <label className="mt-3 flex items-center gap-2">
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
      </div>

      <div>
        <h2 className="text-lg font-medium">主题外观</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          立即生效。保存在 <code>localStorage</code> 中，因此可跨会话保持。
        </p>
        {/* Server can't read localStorage, so render a placeholder until the
            client mounts. Avoids a hydration-mismatch on the active button's
            background color. */}
        {themeMounted ? (
          <div className="mt-3 inline-flex rounded-md border border-border bg-secondary/40 p-1 text-sm">
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
                {t === "light" ? "浅色" : t === "dark" ? "深色" : "跟随系统"}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-3 inline-block h-9 w-[14rem] rounded-md border border-border bg-secondary/40" />
        )}
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {flash ? <p className="text-sm text-muted-foreground">{flash}</p> : null}
    </div>
  );
}
