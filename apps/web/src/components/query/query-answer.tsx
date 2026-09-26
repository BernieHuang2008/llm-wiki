"use client";

import Link from "next/link";
import { useState } from "react";

import { MarkdownView } from "@/components/wiki/markdown-view";
import { cn } from "@/lib/utils";

export type StoredQueryResponse = {
  answer: string;
  pagesUsed: string[];
  suggestedNewPage: null | {
    slug: string;
    title: string;
    content: string;
    reason: string;
  };
  confidence: "high" | "medium" | "low";
  caveats: string[];
};

const CONFIDENCE_LABEL: Record<StoredQueryResponse["confidence"], string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const CONFIDENCE_STYLES: Record<StoredQueryResponse["confidence"], string> = {
  high: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "bg-destructive/10 text-destructive",
};

/**
 * Renders a stored query answer.
 *
 * Shared by the live /query result and the /query/[id] detail page so a past
 * answer looks exactly like a fresh one. `onPromote` is only passed on the
 * live page — promoting a suggested page is an action on the current answer,
 * and the detail page has no promotion flow.
 */
export function QueryAnswer({
  response,
  model,
  knownSlugs,
  onPromote,
  promoting = false,
  promoteResult = null,
  promoteError = null,
}: {
  response: StoredQueryResponse;
  model: string;
  knownSlugs: ReadonlyArray<string>;
  onPromote?: () => void;
  promoting?: boolean;
  promoteResult?: { slug: string } | null;
  promoteError?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copyOriginalAnswer() {
    await navigator.clipboard.writeText(response.answer);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="mt-10 space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-medium uppercase tracking-wide",
            CONFIDENCE_STYLES[response.confidence],
          )}
        >
          置信度：{CONFIDENCE_LABEL[response.confidence]}
        </span>
        <span className="text-muted-foreground">模型：{model}</span>
      </div>

      <article className="rounded-lg border border-border bg-card p-6 text-card-foreground">
        <MarkdownView content={response.answer} knownSlugs={knownSlugs} />
      </article>

      {response.caveats.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            注意事项
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {response.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {response.pagesUsed.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            引用的页面
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {response.pagesUsed.map((slug) => (
              <li key={slug}>
                <Link
                  href={`/wiki/${slug}`}
                  className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-accent"
                >
                  {slug}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {response.suggestedNewPage ? (
        <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            建议新建的页面
          </h3>
          <button
            type="button"
            onClick={() => void copyOriginalAnswer()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            {copied ? "已复制" : "复制原始回答（Markdown）"}
          </button>
          <p className="mt-2">
            <strong>{response.suggestedNewPage.title}</strong>{" "}
            <span className="text-xs text-muted-foreground">
              （{response.suggestedNewPage.slug}）
            </span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{response.suggestedNewPage.reason}</p>

          {promoteResult ? (
            <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">
              已保存。{" "}
              <Link href={`/wiki/${promoteResult.slug}`} className="underline">
                打开页面 →
              </Link>
            </p>
          ) : onPromote ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onPromote}
                disabled={promoting}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                {promoting ? "保存中…" : "保存为 wiki 页面"}
              </button>
              {promoteError ? (
                <span className="text-sm text-destructive">{promoteError}</span>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              这是历史记录，无法直接保存。请重新提问后再保存。
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
