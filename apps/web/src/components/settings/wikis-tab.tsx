"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Client-safe mirror of the SCHEMA_TEMPLATES metadata in
// packages/core/src/templates.ts. Importing the value from @llm-wiki/core
// here pulls the whole barrel — including secrets.ts → keytar (a Node-only
// native module) → webpack bundle error. The server-side route at
// /api/wikis (handleCreate) still imports the real SCHEMA_TEMPLATES from
// core to look up the body by id; we just need the id/label/description
// triple on the client for the dropdown. Keep this list in sync if you
// add/rename templates over there.
type SchemaTemplateId =
  | "blank"
  | "research"
  | "legal"
  | "clinical"
  | "project"
  | "personal";

type SchemaTemplateMeta = {
  id: SchemaTemplateId;
  label: string;
  description: string;
};

const SCHEMA_TEMPLATES: ReadonlyArray<SchemaTemplateMeta> = [
  {
    id: "blank",
    label: "空白",
    description:
      "带有通用写作规范默认值的 schema。之后可在「设置 → Schema」中编辑。",
  },
  {
    id: "research",
    label: "研究",
    description:
      "学术／科研语气。论点以来源为依据，使用技术性表述，并显式列出待解的开放问题。",
  },
  {
    id: "legal",
    label: "法律",
    description:
      "精确引用原文，区分判决理由与附带意见，标注已被推翻的先例。",
  },
  {
    id: "clinical",
    label: "临床",
    description:
      "标注证据等级，标记已废止的指南，原样保留剂量与单位。",
  },
  {
    id: "project",
    label: "项目",
    description:
      "观点鲜明、以决策为导向，为判断标注日期，明确记录失败模式。",
  },
  {
    id: "personal",
    label: "个人知识库",
    description:
      "语气友好、鼓励探索。欢迎开放性问题，记录来源以便日后重新查找。",
  },
];

type WikiDetail = {
  path: string;
  topic: string | null;
  exists: boolean;
};

type ListResponse = {
  active: WikiDetail;
  recents: WikiDetail[];
};

// Suggests a default folder path from a topic. Matches the convention
// `~/llm-wiki-<slug>` so users have a sensible starting point without
// having to type a full path.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function suggestedPath(topic: string): string {
  const slug = slugify(topic);
  if (!slug) return "~/llm-wiki-untitled";
  return `~/llm-wiki-${slug}`;
}

export function WikisTab() {
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Create form
  const [createOpen, setCreateOpen] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newTemplate, setNewTemplate] = useState<SchemaTemplateId>("blank");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/wikis", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function doAction(
    label: string,
    body: object,
    successFlash: string,
  ): Promise<boolean> {
    setBusyAction(label);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/wikis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setFlash(successFlash);
      await refresh();
      // Re-render every server component so the new active wiki is read
      // throughout the app, not just by this tab.
      router.refresh();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function onSwitch(path: string) {
    await doAction(`switch:${path}`, { type: "switch", path }, `已切换到 ${path}`);
  }

  async function onRemove(path: string, isActive: boolean) {
    const msg = isActive
      ? `要把这个 wiki 从选择列表中移除，并切换回默认 wiki 吗？文件夹和文件都会保留在磁盘上。`
      : `要把这个 wiki 从选择列表中移除吗？文件夹和文件都会保留在磁盘上。`;
    if (!confirm(msg)) return;
    await doAction(`remove:${path}`, { type: "remove", path }, "已从选择列表中移除");
  }

  async function onCreate() {
    const topic = newTopic.trim();
    const path = newPath.trim() || suggestedPath(topic);
    if (!topic) {
      setError("必须填写主题。");
      return;
    }
    const templateLabel =
      SCHEMA_TEMPLATES.find((t) => t.id === newTemplate)?.label ?? newTemplate;
    const ok = await doAction(
      "create",
      { type: "create", path, topic, templateId: newTemplate },
      `已在该路径创建 wiki：${path}${newTemplate !== "blank" ? `（使用「${templateLabel}」模板）` : ""}`,
    );
    if (ok) {
      setNewTopic("");
      setNewPath("");
      setNewTemplate("blank");
      setCreateOpen(false);
    }
  }

  if (data === null && !error) {
    return <p className="text-sm text-muted-foreground">正在加载 wiki…</p>;
  }

  if (error && data === null) {
    return (
      <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        无法加载 wiki：{error}
      </p>
    );
  }

  const active = data?.active;
  const rows = data?.recents ?? [];
  const activeIsInRecents = active ? rows.some((r) => r.path === active.path) : false;

  // Stale entries left over from prior testing or removed-from-disk wikis.
  // Surface a single bulk-cleanup affordance so users don't have to click
  // Remove on each one.
  const missing = rows.filter((r) => !r.exists);

  async function onCleanMissing() {
    if (missing.length === 0) return;
    if (
      !confirm(
        `要把 ${missing.length} 个已失效的文件夹从选择列表中移除吗？（这些条目指向的路径在磁盘上已不存在。）`,
      )
    )
      return;
    setBusyAction("clean-missing");
    setError(null);
    setFlash(null);
    try {
      // Sequential — small N + we want each remove to see the prior's
      // updated config, since removing the currently-active wiki resets it.
      for (const m of missing) {
        const res = await fetch("/api/wikis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "remove", path: m.path }),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
      }
      setFlash(`已清理 ${missing.length} 个失效条目。`);
      await refresh();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Wiki 列表</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            一个主题一个 wiki。在你切换之前，整个应用读取的都是当前启用的 wiki。
            切换只需两次点击——无需重启。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <a
            href="/dashboard"
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:border-primary/40 hover:bg-accent"
            title="每个 wiki 的页面／来源／对话数量，以及所有 wiki 的累计大语言模型支出，按最近使用排序。"
          >
            健康概览
          </a>
          {active?.exists ? (
            <a
              href="/api/wikis/export"
              download
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:border-primary/40 hover:bg-accent"
              title="下载当前启用 wiki 的 zip 压缩包（markdown + 原始来源 + 对话 + schema + 索引 + 日志）。会跳过 .llm-wiki/ 元数据。"
            >
              导出当前 wiki
            </a>
          ) : null}
        </div>
      </div>

      {flash ? (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {flash}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {missing.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="text-amber-800 dark:text-amber-200">
            有 {missing.length} 个条目指向的文件夹在磁盘上已不存在（可能是早先会话遗留的）。
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onCleanMissing()}
            disabled={busyAction !== null}
          >
            {busyAction === "clean-missing"
              ? "清理中…"
              : `清理 ${missing.length} 个失效条目`}
          </Button>
        </div>
      ) : null}

      {/* If the active wiki isn't in the recents list (typical on first run —
          the default ~/llm-wiki-default), render it as its own row. We now
          use the server-enriched detail so topic + exists are correct. */}
      {active && !activeIsInRecents ? (
        <WikiRow
          path={active.path}
          topic={active.topic}
          exists={active.exists}
          isActive={true}
          busyAction={busyAction}
          onSwitch={() => Promise.resolve()}
          onRemove={() =>
            onRemove(active.path, true)
          }
        />
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <WikiRow
            key={row.path}
            path={row.path}
            topic={row.topic}
            exists={row.exists}
            isActive={active?.path === row.path}
            busyAction={busyAction}
            onSwitch={() => onSwitch(row.path)}
            onRemove={() => onRemove(row.path, active?.path === row.path)}
          />
        ))}
      </ul>

      {/* Create form, collapsed by default. */}
      <div className="rounded-md border border-border/70 bg-muted/20 p-4">
        {!createOpen ? (
          <Button variant="outline" onClick={() => setCreateOpen(true)}>
            新建 wiki
          </Button>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">新建一个 wiki</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                选择一个主题（大语言模型在每次操作时都会读取它）和一个文件夹路径。
                文件夹不存在时会自动创建。
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="new-topic">
                主题
              </label>
              <Input
                id="new-topic"
                value={newTopic}
                onChange={(e) => {
                  setNewTopic(e.target.value);
                  if (!newPath) setNewPath(suggestedPath(e.target.value));
                }}
                placeholder="例如：机器学习研究与关键论文"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="new-path">
                文件夹路径
              </label>
              <Input
                id="new-path"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder={newTopic ? suggestedPath(newTopic) : "~/llm-wiki-…"}
                className="font-mono text-[13px]"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                波浪号（<code className="font-mono">~</code>）会被展开为你的主目录。
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="new-template">
                Schema 模板
              </label>
              <select
                id="new-template"
                value={newTemplate}
                onChange={(e) => setNewTemplate(e.target.value as SchemaTemplateId)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {SCHEMA_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {SCHEMA_TEMPLATES.find((t) => t.id === newTemplate)?.description}{" "}
                会预填 <code className="font-mono">CLAUDE.md</code>——可随时在
                「设置 → Schema」中编辑。
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={onCreate} disabled={!newTopic.trim() || busyAction === "create"}>
                {busyAction === "create" ? "创建中…" : "创建并切换"}
              </Button>
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        切换之后，应用中的每个页面都会在下一次请求时从新的 wiki 重新读取。大多数界面会原地更新；
        若发现内容仍是旧的，请刷新浏览器。
      </p>
    </div>
  );
}

function WikiRow({
  path,
  topic,
  exists,
  isActive,
  busyAction,
  onSwitch,
  onRemove,
}: {
  path: string;
  topic: string | null;
  exists: boolean;
  isActive: boolean;
  busyAction: string | null;
  onSwitch: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const switching = busyAction === `switch:${path}`;
  const removing = busyAction === `remove:${path}`;
  return (
    <li
      className={
        "flex flex-wrap items-baseline justify-between gap-3 rounded-md border p-3 " +
        (isActive ? "border-primary/40 bg-primary/[0.04]" : "border-border/70 bg-card")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm font-medium">
            {topic ?? <span className="text-muted-foreground italic">未设置主题</span>}
          </p>
          {isActive ? (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
              当前启用
            </span>
          ) : null}
          {!exists ? (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
              文件夹缺失
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {path}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {!isActive && exists ? (
          <Button size="sm" variant="outline" onClick={() => void onSwitch()} disabled={busyAction !== null}>
            {switching ? "切换中…" : "切换"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void onRemove()} disabled={busyAction !== null}>
          {removing ? "移除中…" : "移除"}
        </Button>
      </div>
    </li>
  );
}
