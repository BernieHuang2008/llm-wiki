import Link from "next/link";
import { notFound } from "next/navigation";

import { getRun, listPageRows } from "@llm-wiki/core";

import { PageContainer, PageHeader } from "@/components/page-shell";
import { QueryAnswer, type StoredQueryResponse } from "@/components/query/query-answer";
import { openWikiContext, requireSetup } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * One stored query, reopened.
 *
 * Queries are read-only answers, so this page is purely a reader — the live
 * /query page is where new questions (and page promotion) happen.
 */
export default async function QueryRunPage({ params }: { params: { id: string } }) {
  await requireSetup("query");
  const ctx = await openWikiContext();
  let run;
  let knownSlugs: string[];
  try {
    run = getRun(ctx.db, params.id);
    knownSlugs = listPageRows(ctx.db).map((r) => r.slug);
  } finally {
    ctx.db.close();
  }

  if (!run || run.kind !== "query") notFound();

  const response = run.output as StoredQueryResponse | null;
  const valid = response !== null && typeof response.answer === "string";

  return (
    <PageContainer>
      <PageHeader
        eyebrow="查询记录"
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
            href="/query"
            className="text-ui text-primary underline underline-offset-2 hover:text-primary/80"
          >
            ← 返回查询
          </Link>
        }
      />

      {!valid ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          这条记录的格式无法解析（可能是旧版本写入的）。
        </p>
      ) : (
        <QueryAnswer
          response={response}
          model={run.model ?? "未知模型"}
          knownSlugs={knownSlugs}
        />
      )}
    </PageContainer>
  );
}
