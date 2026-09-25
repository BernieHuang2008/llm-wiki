import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { listPageRows, WIKI_PATHS } from "@llm-wiki/core";

import { PageContainer, PageHeader } from "@/components/page-shell";
import { MarkdownView } from "@/components/wiki/markdown-view";
import { openWikiContext, requireSetup } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

// Splits log.md into its intro (the "# Wiki Log" preamble) and one entry
// per "## [stamp] …" heading. Entries are returned in file order; the page
// reverses them so newest is on top.
function parseLogEntries(text: string): { intro: string; entries: string[] } {
  const lines = text.split(/\r?\n/);
  const entryStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## [")) entryStarts.push(i);
  }
  if (entryStarts.length === 0) {
    return { intro: text.trim(), entries: [] };
  }
  const introEnd = entryStarts[0]!;
  const intro = lines.slice(0, introEnd).join("\n").trim();
  const entries: string[] = [];
  for (let i = 0; i < entryStarts.length; i++) {
    const start = entryStarts[i]!;
    const end = i + 1 < entryStarts.length ? entryStarts[i + 1]! : lines.length;
    entries.push(lines.slice(start, end).join("\n").trim());
  }
  return { intro, entries };
}

export default async function LogPage() {
  await requireSetup();
  const ctx = await openWikiContext();
  let raw = "";
  let knownSlugs: string[] = [];
  try {
    const path = join(ctx.wikiPath, WIKI_PATHS.log);
    try {
      raw = await readFile(path, "utf8");
    } catch {
      raw = "";
    }
    knownSlugs = listPageRows(ctx.db).map((r) => r.slug);
  } finally {
    ctx.db.close();
  }

  const { entries } = parseLogEntries(raw);
  const newestFirst = [...entries].reverse();

  return (
    <PageContainer width="lg">
      <PageHeader
        eyebrow="知识库时间线"
        title="日志"
        description={
          <>
            这个知识库中的每一次Ingest、编辑、体检和 schema 保存，最新的排在最前。它镜像磁盘上的{" "}
            <code className="font-mono">{ctx.wikiPath}/log.md</code> —— 你也可以随时
            用编辑器打开它。
          </>
        }
      />

      {entries.length === 0 ? (
        <p className="rounded-md border border-border/70 bg-card p-4 text-sm text-muted-foreground">
          还没有记录。随着你IngestSource、编辑页面、运行体检或
          保存 schema，日志会逐渐填充起来。
        </p>
      ) : (
        <>
          <p className="mb-4 text-caption uppercase tracking-wider text-muted-foreground">
            {entries.length} 条记录 · 最新在前
          </p>
          <article className="space-y-4">
            {newestFirst.map((entry, i) => (
              <div
                key={`${entries.length - i - 1}`}
                className="rounded-md border border-border/70 bg-card p-4"
              >
                <MarkdownView content={entry} knownSlugs={knownSlugs} />
              </div>
            ))}
          </article>
        </>
      )}
    </PageContainer>
  );
}
