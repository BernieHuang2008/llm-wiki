import Link from "next/link";
import { notFound } from "next/navigation";

import { getRun } from "@llm-wiki/core";

import { LintView } from "@/app/lint/lint-view";
import { PageContainer, PageHeader } from "@/components/page-shell";
import { openWikiContext, requireSetup } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

type StoredLintOutput = {
  issues?: unknown;
  overallHealth?: unknown;
  runId?: unknown;
};

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * One stored lint run, reopened in full.
 *
 * The issues and their fix buttons are the same component the /lint page uses,
 * so a past run can be acted on directly instead of only being read.
 */
export default async function LintRunPage({ params }: { params: { id: string } }) {
  await requireSetup("lint");
  const ctx = await openWikiContext();
  let run;
  try {
    run = getRun(ctx.db, params.id);
  } finally {
    ctx.db.close();
  }

  if (!run || run.kind !== "lint") notFound();

  const output = (run.output ?? {}) as StoredLintOutput;
  // Guard the shape: a stored payload could be from an older schema, and a
  // half-rendered result view is worse than an explicit message.
  const valid = output.issues !== undefined && output.overallHealth !== undefined;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="体检记录"
        title={run.label}
        description={
          <span>
            执行于 <span className="font-mono">{formatStamp(run.created_at)}</span>
            {run.model ? (
              <>
                {" · 模型 "}
                <span className="font-mono">{run.model}</span>
              </>
            ) : null}
            {run.error ? <span className="text-destructive"> · 失败：{run.error}</span> : null}
          </span>
        }
        actions={
          <Link
            href="/lint"
            className="text-ui text-primary underline underline-offset-2 hover:text-primary/80"
          >
            ← 返回体检
          </Link>
        }
      />

      {!valid ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          这条记录的格式无法解析（可能是旧版本写入的）。请回到体检页重新跑一次。
        </p>
      ) : (
        <LintView
          initialResult={run.output as never}
          initialModel={run.model}
        />
      )}
    </PageContainer>
  );
}
