"use client";

import { useEffect, useState } from "react";

import { PageContainer, PageHeader } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/wiki/markdown-view";

export function SchemaEditorView() {
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [wikiPath, setWikiPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/schema", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { content: string; wikiPath: string };
        setContent(data.content);
        setOriginal(data.content);
        setWikiPath(data.wikiPath);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  const dirty = content !== null && content !== original;

  async function onSave() {
    if (content === null) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/schema", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const json = (await res.json()) as { ok?: true; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setOriginal(content);
      setFlash("已保存。先前版本已备份到 .llm-wiki/schema-history/。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer width="xl">
      <PageHeader
        eyebrow="LLM 的契约"
        title="Schema 编辑器"
        description={
          <>
            编辑你知识库文件夹中的 <code className="font-mono">CLAUDE.md</code>。schema
            是 LLM 在每次入库/查询/体检调用时使用的契约。先前版本
            保存在 <code className="font-mono">.llm-wiki/schema-history/</code>（最近 10 个）。
          </>
        }
        actions={
          <>
            <Button onClick={onSave} disabled={!dirty || busy}>
              {busy ? "保存中…" : dirty ? "保存 schema" : "已保存"}
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setContent(original)} disabled={busy}>
                还原
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-ui text-destructive">
          {error}
        </div>
      ) : null}
      {flash ? (
        <div className="mb-4 rounded-md bg-emerald-500/10 px-3 py-2 text-ui text-emerald-700 dark:text-emerald-300">
          {flash}
        </div>
      ) : null}

      {content === null ? (
        <p className="text-ui text-muted-foreground">加载中…</p>
      ) : (
        <>
          {/* Split pane fills the available viewport height so the editor
              feels like a real editing surface, not a small inline textarea.
              Headers stay visible (sticky) while the panes scroll. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col">
              <h3 className="mb-2 text-caption font-semibold uppercase tracking-wider text-muted-foreground">
                Markdown
              </h3>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="min-h-[calc(100vh-18rem)] flex-1 resize-none rounded-md border-border/70 bg-card p-5 font-mono text-[13px] leading-relaxed"
              />
            </div>
            <div className="flex flex-col">
              <h3 className="mb-2 text-caption font-semibold uppercase tracking-wider text-muted-foreground">
                预览
              </h3>
              <div className="min-h-[calc(100vh-18rem)] flex-1 overflow-y-auto rounded-md border border-border/70 bg-card p-5">
                <MarkdownView content={content} knownSlugs={[]} />
              </div>
            </div>
          </div>
          <p className="mt-4 text-caption text-muted-foreground">
            <span className="font-mono break-all">{wikiPath}/CLAUDE.md</span>
          </p>
        </>
      )}
    </PageContainer>
  );
}
