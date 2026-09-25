"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CostPreview } from "@/components/cost-preview";
import { PageContainer, PageHeader } from "@/components/page-shell";
import { QueryAnswer, type StoredQueryResponse } from "@/components/query/query-answer";
import { RecentQueries } from "@/components/query/recent-queries";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchTask, isActive, type PublicTask } from "@/lib/task-client";
import { useWikiSettings } from "@/lib/use-wiki-settings";

type QueryResponse = StoredQueryResponse;

type QuerySuccess = {
  ok: true;
  model: string;
  response: QueryResponse;
};

type QueryTaskOutput = { model?: string; response?: QueryResponse; provider?: string };

export function QueryView() {
  const [question, setQuestion] = useState("");
  const [knownSlugs, setKnownSlugs] = useState<string[]>([]);
  const settings = useWikiSettings();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<QuerySuccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [promoting, setPromoting] = useState(false);
  const [promoteResult, setPromoteResult] = useState<{ slug: string } | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  // Bumped when a query finishes so the recent-queries list picks it up
  // without a page reload.
  const [historyNonce, setHistoryNonce] = useState(0);

  // Stops the polling loop when the user navigates away. The *task* keeps
  // running on the server either way — that is the point of the executor.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/pages", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { knownSlugs: string[] };
        setKnownSlugs(data.knownSlugs);
      } catch {
        // non-fatal — wikilinks just render conservatively
      }
    })();
  }, []);

  async function onAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setResult(null);
    setError(null);
    setProgress("已提交，等待执行…");
    setPromoteResult(null);
    setPromoteError(null);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        task?: PublicTask;
      };
      if (!res.ok || !json.ok || !json.task) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      // Poll until the background task settles.
      const taskId = json.task.id;
      for (;;) {
        const task = await fetchTask(taskId);
        if (!aliveRef.current) return;
        setProgress(task.progress ?? null);
        if (!isActive(task)) {
          if (task.status === "succeeded") {
            const out = (task.output ?? {}) as QueryTaskOutput;
            if (out.response) {
              setResult({
                ok: true,
                model: out.model ?? "未知模型",
                response: out.response,
              });
            } else {
              setError("任务已完成，但没有返回答案。");
            }
          } else {
            setError(task.error ?? "查询任务失败。");
          }
          // Either way the run row may now exist (success) or not; refreshing
          // costs one request and keeps the list honest.
          setHistoryNonce((n) => n + 1);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function onPromote() {
    if (!result?.response.suggestedNewPage) return;
    const s = result.response.suggestedNewPage;
    setPromoting(true);
    setPromoteError(null);
    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: s.slug,
          title: s.title,
          type: "concept",
          content: s.content,
        }),
      });
      const json = (await res.json()) as { ok?: true; slug?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPromoteResult({ slug: s.slug });
      setKnownSlugs((prev) => (prev.includes(s.slug) ? prev : [...prev, s.slug]));
    } catch (err) {
      setPromoteError((err as Error).message);
    } finally {
      setPromoting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="单次提问"
        title="查询"
        description="向 wiki 提问并获得带引用的回答。适合一次性的查证；需要连续追问请使用“对话”。"
      />

      <form onSubmit={onAsk} className="space-y-3">
        <label className="block text-ui font-medium" htmlFor="question">
          你的问题
        </label>
        <Textarea
          id="question"
          rows={3}
          placeholder="例如：Shor 算法与 RSA 之间是什么关系？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
          className="font-serif text-body"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onAsk(e as unknown as React.FormEvent);
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!question.trim() || busy}>
            {busy ? "处理中…" : "提问"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Cmd/Ctrl + Enter 提交 · 使用 设置 → 模型 → 查询
          </p>
        </div>
        {settings?.settings.showCostEstimates && question.trim() ? (
          <CostPreview
            text={question}
            model={settings.settings.defaultModels.query.model}
            contextOverhead={6000}
            expectedOutputTokens={600}
          />
        ) : null}
      </form>

      {busy ? (
        <p className="mt-6 rounded-md bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
          任务已在后台运行{progress ? `：${progress}` : "…"}。即使离开本页，回答也会继续生成并保存。
        </p>
      ) : null}

      {error ? (
        <div className="mt-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {result ? (
        <QueryAnswer
          response={result.response}
          model={result.model}
          knownSlugs={knownSlugs}
          onPromote={() => void onPromote()}
          promoting={promoting}
          promoteResult={promoteResult}
          promoteError={promoteError}
        />
      ) : null}

      <section className="mt-12 rounded-lg border border-border/70 bg-card p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-h3 font-semibold">最近查询</h2>
          <p className="text-caption text-muted-foreground">点开任意一条可查看完整回答与引用</p>
        </div>
        <RecentQueries refreshNonce={historyNonce} />
      </section>
    </PageContainer>
  );
}
