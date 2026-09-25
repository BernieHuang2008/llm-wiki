import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import Link from "next/link";

import {
  getTotalCostCents,
  listChatRows,
  listPageRows,
  listSourceRows,
  loadGlobalConfig,
  loadWikiSettings,
  openDb,
  WIKI_PATHS,
} from "@llm-wiki/core";

import { PageContainer, PageHeader } from "@/components/page-shell";
import { SwitchWikiButton } from "@/components/dashboard/switch-wiki-button";
import { requireSetup } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

type WikiHealth = {
  path: string;
  topic: string | null;
  exists: boolean;
  initialized: boolean;
  isActive: boolean;
  pageCount: number;
  sourceCount: number;
  chatCount: number;
  costCents: number;
  lastTouchedMs: number | null;
};

function defaultWikiPath(): string {
  return join(homedir(), "llm-wiki-default");
}

async function gatherHealth(path: string, isActive: boolean): Promise<WikiHealth> {
  let exists = false;
  let lastTouchedMs: number | null = null;
  try {
    const s = await stat(path);
    exists = s.isDirectory();
    lastTouchedMs = s.mtimeMs;
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      path,
      topic: null,
      exists: false,
      initialized: false,
      isActive,
      pageCount: 0,
      sourceCount: 0,
      chatCount: 0,
      costCents: 0,
      lastTouchedMs: null,
    };
  }

  let topic: string | null = null;
  try {
    const settings = await loadWikiSettings(path);
    topic = settings.topic.trim() || null;
  } catch {
    topic = null;
  }

  // Skip DB open for wikis that exist on disk but haven't been opened by
  // the app yet — openDb() creates .llm-wiki/ as a side effect, which we
  // don't want on a read-only page.
  let initialized = false;
  try {
    await stat(join(path, WIKI_PATHS.tooling));
    initialized = true;
  } catch {
    initialized = false;
  }

  if (!initialized) {
    return {
      path,
      topic,
      exists: true,
      initialized: false,
      isActive,
      pageCount: 0,
      sourceCount: 0,
      chatCount: 0,
      costCents: 0,
      lastTouchedMs,
    };
  }

  const db = openDb(path);
  try {
    return {
      path,
      topic,
      exists: true,
      initialized: true,
      isActive,
      pageCount: listPageRows(db).length,
      sourceCount: listSourceRows(db).length,
      chatCount: listChatRows(db).length,
      costCents: getTotalCostCents(db),
      lastTouchedMs,
    };
  } finally {
    db.close();
  }
}

export default async function DashboardPage() {
  await requireSetup();

  const cfg = await loadGlobalConfig();
  const activePath = cfg.activeWiki ?? defaultWikiPath();
  const all = Array.from(new Set([activePath, ...cfg.recentWikis]));
  const wikis = await Promise.all(all.map((p) => gatherHealth(p, p === activePath)));
  wikis.sort((a, b) => (b.lastTouchedMs ?? 0) - (a.lastTouchedMs ?? 0));

  const totals = wikis.reduce(
    (acc, w) => ({
      pageCount: acc.pageCount + w.pageCount,
      sourceCount: acc.sourceCount + w.sourceCount,
      chatCount: acc.chatCount + w.chatCount,
      costCents: acc.costCents + w.costCents,
    }),
    { pageCount: 0, sourceCount: 0, chatCount: 0, costCents: 0 },
  );

  return (
    <PageContainer width="xl">
      <PageHeader
        eyebrow="跨所有知识库"
        title="知识库健康"
        description="各知识库统计 —— 页面 / 来源 / 对话数量、累计 LLM 花费、最后修改时间。按新旧排序。点击任意知识库即可切换进去。"
      />

      {/* Roll-up across every wiki. Useful for the "how much have I actually
          spent on this app" question that doesn't have a clean answer when
          each wiki tracks cost independently. */}
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <RollupTile label="知识库总数" value={wikis.length.toString()} />
        <RollupTile label="页面总数" value={totals.pageCount.toString()} />
        <RollupTile label="来源总数" value={totals.sourceCount.toString()} />
        <RollupTile label="累计花费" value={formatCost(totals.costCents)} />
      </section>

      <ul className="space-y-3">
        {wikis.map((w) => (
          <li key={w.path}>
            <WikiCard wiki={w} />
          </li>
        ))}
      </ul>
    </PageContainer>
  );
}

function WikiCard({ wiki }: { wiki: WikiHealth }) {
  const title = wiki.topic ?? "（未设置主题）";

  return (
    <article
      className={
        "rounded-lg border bg-card p-5 transition-colors " +
        (wiki.isActive
          ? "border-primary/40 bg-primary/[0.04]"
          : "border-border/70 hover:border-border")
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-display text-h3 font-semibold">{title}</h2>
            {wiki.isActive ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                启用中
              </span>
            ) : null}
            {!wiki.exists ? (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                文件夹缺失
              </span>
            ) : !wiki.initialized ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                未初始化
              </span>
            ) : null}
          </div>
          <p className="mt-1 break-all font-mono text-caption text-muted-foreground">{wiki.path}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {wiki.exists && wiki.isActive ? (
            <Link
              href="/"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:border-primary/40 hover:bg-accent"
            >
              打开 →
            </Link>
          ) : wiki.exists ? (
            <SwitchWikiButton path={wiki.path} />
          ) : null}
        </div>
      </div>

      {wiki.initialized ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="页面" value={wiki.pageCount.toString()} />
          <Stat label="来源" value={wiki.sourceCount.toString()} />
          <Stat label="对话" value={wiki.chatCount.toString()} />
          <Stat label="花费" value={formatCost(wiki.costCents)} />
          <Stat label="最后修改" value={formatRelative(wiki.lastTouchedMs)} />
        </dl>
      ) : wiki.exists ? (
        <p className="mt-4 text-ui text-muted-foreground">
          文件夹存在，但还没有被应用打开过。切换进去即可
          初始化元数据层。
        </p>
      ) : (
        <p className="mt-4 text-ui text-muted-foreground">
          这个知识库指向的文件夹已不存在。请在{" "}
          <Link href="/settings?tab=wikis" className="text-primary underline underline-offset-2">
            设置 → 知识库
          </Link>{" "}
          中移除它，以清理最近使用列表。
        </p>
      )}
    </article>
  );
}

function RollupTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card px-4 py-3">
      <p className="text-caption uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-h2 font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-display text-h3 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function formatCost(cents: number): string {
  if (cents === 0) return "$0.00";
  if (cents < 1) return `$${(cents / 100).toFixed(4)}`;
  if (cents < 100) return `$${(cents / 100).toFixed(3)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRelative(ms: number | null): string {
  if (ms === null) return "—";
  const diffMs = Date.now() - ms;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.round(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.round(diffMs / hour)} 小时前`;
  if (diffMs < 30 * day) return `${Math.round(diffMs / day)} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}
