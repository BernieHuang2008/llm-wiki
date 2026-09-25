"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";

import { CostPreview } from "@/components/cost-preview";
import { PageContainer, PageHeader } from "@/components/page-shell";
import { IngestQueue } from "@/components/sources/ingest-queue";
import { SourcesList } from "@/components/sources/sources-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWikiSettings } from "@/lib/use-wiki-settings";
import { cn } from "@/lib/utils";

type Mode = "paste" | "file" | "url";

const ACCEPTED_EXTENSIONS =
  ".md,.markdown,.txt,.html,.htm,.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp";

const VISION_EXTENSIONS = /\.(pdf|png|jpg|jpeg|webp)$/i;

export function SourcesView() {
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = useMemo(
    () => files.reduce((sum, f) => sum + f.size, 0),
    [files],
  );
  const visionCount = files.filter((f) => VISION_EXTENSIONS.test(f.name)).length;

  const canSubmit =
    !busy &&
    ((mode === "paste" && text.trim().length > 0) ||
      (mode === "url" && url.trim().length > 0) ||
      (mode === "file" && files.length > 0));

  function resetPicker() {
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function addFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    setFiles((prev) => {
      // Same file dropped twice shouldn't queue twice.
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      const next = [...prev];
      for (const f of incoming) {
        const key = `${f.name}:${f.size}:${f.lastModified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(f);
      }
      return next;
    });
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setSubmitted(null);
    setError(null);

    const label =
      mode === "file"
        ? `${files.length} 个文件`
        : mode === "url"
          ? url
          : "粘贴的文本";
    console.log(`%c[入库提交] 提交来源："${label}"（${mode}）`, "color: #3b82f6; font-weight: bold;");

    try {
      let res: Response;
      if (mode === "file") {
        // One multipart request; the server splits it into one source + one
        // background task per file.
        const form = new FormData();
        for (const file of files) form.append("file", file);
        if (title.trim()) form.append("title", title.trim());
        res = await fetch("/api/ingest", { method: "POST", body: form });
      } else {
        const body: Record<string, string> = {};
        if (mode === "paste") body["text"] = text;
        if (mode === "url") body["url"] = url.trim();
        if (title.trim()) body["title"] = title.trim();
        res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        taskIds?: string[];
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      const count = json.taskIds?.length ?? 1;
      console.log(
        `%c[入库已排队] "${label}" -> 已创建 ${count} 个后台任务`,
        "color: #10b981; font-weight: bold;",
      );
      setSubmitted(
        count === 1
          ? "已提交 1 个后台任务。可以关闭本页或切换页面，入库会在服务端继续执行。"
          : `已提交 ${count} 个后台任务，每个文件独立执行、互不影响。可以关闭本页。`,
      );
      setText("");
      setTitle("");
      resetPicker();
      setRefreshNonce((n) => n + 1);
    } catch (err) {
      console.error(`[入库提交失败] "${label}"：${(err as Error).message}`);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length > 0) {
      addFiles(dropped);
      setMode("file");
    }
  }, []);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="加入 wiki"
        title="来源"
        description="粘贴文本和 Markdown 直接入库；网址会抓取并用 Readability 抽取正文；PDF 与图片走视觉模型；DOCX/PPTX/XLSX 在本地预解析。所有任务都在后台执行，关闭页面不会中断。"
      />

      <section className="mb-8 rounded-lg border border-border/70 bg-card p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-h3 font-semibold">待处理来源</h2>
          <p className="text-caption text-muted-foreground">
            只显示排队中、执行中与失败的条目；原文保存在{" "}
            <code className="font-mono">raw/</code>
          </p>
        </div>
        <SourcesList
          refreshNonce={refreshNonce}
          onChanged={() => setRefreshNonce((n) => n + 1)}
        />
      </section>

      <section
        className={cn(
          "rounded-lg border bg-card p-5 text-card-foreground transition-colors",
          dragOver ? "border-primary ring-2 ring-primary/30" : "border-border/70",
        )}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <div className="inline-flex rounded-md border border-border/70 bg-secondary/40 p-1 text-ui">
          {(
            [
              ["paste", "粘贴"],
              ["file", "文件"],
              ["url", "网址"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={cn(
                "rounded px-3 py-1",
                mode === value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          {mode !== "file" ? (
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="title">
                标题（可选）
              </label>
              <Input
                id="title"
                type="text"
                placeholder="默认：粘贴文本取首行、网址取页面标题、文件取文件名"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
              />
            </div>
          ) : null}

          {mode === "paste" ? (
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="text">
                内容
              </label>
              <Textarea
                id="text"
                rows={14}
                placeholder="在此粘贴文章、论文或笔记…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
                className="min-h-[280px] font-mono text-[13px] leading-relaxed"
              />
            </div>
          ) : null}

          {mode === "url" ? (
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="url">
                网址
              </label>
              <Input
                id="url"
                type="url"
                placeholder="https://..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                会抓取页面、用 Mozilla Readability 去除导航与广告，再对正文入库。
              </p>
            </div>
          ) : null}

          {mode === "file" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">文件（可多选）</label>
              <div
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-background px-6 py-10 text-center",
                  dragOver ? "border-primary bg-primary/5" : null,
                )}
              >
                {files.length === 0 ? (
                  <>
                    <p className="text-sm">
                      把文件拖到这里，或{" "}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-primary underline underline-offset-2"
                      >
                        选择多个文件
                      </button>
                      。
                    </p>
                    <p className="text-xs text-muted-foreground">
                      支持 .md、.txt、.html、.pdf、.docx、.pptx、.xlsx、.png、.jpg、.webp
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm">
                      已选择 <strong>{files.length}</strong> 个文件（
                      {Math.max(1, Math.round(totalBytes / 1024))} KB 合计）
                      {visionCount > 0 ? `，其中 ${visionCount} 个走视觉模型` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      每个文件会拆成独立任务，分别执行、互不影响。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy}
                      >
                        继续添加
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={resetPicker}
                        disabled={busy}
                      >
                        清空
                      </Button>
                    </div>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    // Allow re-picking the same file later.
                    e.target.value = "";
                  }}
                />
              </div>

              {files.length > 0 ? (
                <ul className="mt-3 divide-y divide-border rounded-md border border-border/70">
                  {files.map((file, index) => (
                    <li
                      key={`${file.name}-${file.size}-${index}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {Math.max(1, Math.round(file.size / 1024))} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        disabled={busy}
                        className="shrink-0 text-[11px] text-muted-foreground underline hover:text-foreground"
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <CostPreviewForSources mode={mode} text={text} files={files} url={url} />

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!canSubmit}>
              {busy ? "提交中…" : "提交入库"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {mode === "file" && visionCount > 0
                ? "含 PDF/图片，将使用 设置 → 模型 → 视觉 中的模型。"
                : "使用入库模型；提交后立即返回，任务在后台执行。"}
            </p>
          </div>
        </form>

        {error ? <IngestErrorBanner message={error} /> : null}

        {submitted ? (
          <div className="mt-6 rounded-md bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
            <strong>已提交。</strong> {submitted}
          </div>
        ) : null}
      </section>

      <section className="mt-8 rounded-lg border border-border/70 bg-card p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-h3 font-semibold">后台任务</h2>
          <p className="text-caption text-muted-foreground">
            由服务端执行器运行，与页面是否打开无关
          </p>
        </div>
        <IngestQueue refreshNonce={refreshNonce} />
      </section>

      <p className="mt-6 text-caption text-muted-foreground">
        打开{" "}
        <Link href="/wiki" className="underline underline-offset-2">
          Wiki
        </Link>{" "}
        浏览由这些来源生成的页面。
      </p>
    </PageContainer>
  );
}

// Schema-validation errors come back as a single long string from the LLM
// wrapper. Surface a friendly summary at the top with the raw detail
// collapsed underneath so power users can still see what the model returned.
function IngestErrorBanner({ message }: { message: string }) {
  const isSchemaError =
    message.includes("schema validation") || message.includes("not valid JSON");
  return (
    <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <p className="font-medium">
        {isSchemaError ? "模型返回的数据格式不正确。" : "提交入库任务失败。"}
      </p>
      {isSchemaError ? (
        <p className="mt-1 text-destructive/85">
          再点一次 <strong>提交入库</strong> 通常就能成功——小模型偶尔会偏离 JSON 格式。
          如果反复出现，请在{" "}
          <a
            href="/settings"
            className="underline underline-offset-2 hover:text-destructive/70"
          >
            设置 → 模型 → 入库
          </a>{" "}
          中换用更强的模型（例如{" "}
          <code className="font-mono text-xs">anthropic/claude-sonnet-4.6</code> 或{" "}
          <code className="font-mono text-xs">openai/gpt-4o</code>）。
        </p>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-destructive/70 hover:text-destructive">
          查看技术细节
        </summary>
        <pre className="mt-2 overflow-x-auto rounded bg-background/50 p-2 font-mono text-[11px] text-destructive/80">
          {message}
        </pre>
      </details>
    </div>
  );
}

function CostPreviewForSources({
  mode,
  text,
  files,
  url,
}: {
  mode: Mode;
  text: string;
  files: File[];
  url: string;
}) {
  const settings = useWikiSettings();
  if (!settings) return null;
  if (!settings.settings.showCostEstimates) return null;

  const isVision = files.length > 0 && files.some((f) => VISION_EXTENSIONS.test(f.name));
  const slot = isVision
    ? settings.settings.defaultModels.vision
    : settings.settings.defaultModels.ingest;
  const model = slot.model;

  // For files we estimate by size; PDFs/images ride as base64 in the
  // multimodal call, so input cost is roughly bytes/3 (base64 overhead).
  let estimateInput = "";
  if (mode === "paste") estimateInput = text;
  else if (mode === "url") estimateInput = url ? `Article from ${url}, est. 3000 words` : "";
  else if (mode === "file" && files.length > 0) {
    // Approximate the whole batch by folding every file's size into one blob;
    // per-file precision would need N previews for one number.
    const total = files.reduce((sum, f) => sum + f.size, 0);
    estimateInput = "x".repeat(Math.min(isVision ? total : total * 2, 400_000));
  }

  return <CostPreview text={estimateInput} model={model} contextOverhead={5000} />;
}
