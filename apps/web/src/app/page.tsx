import Link from "next/link";

import {
  getApiKey,
  getTotalCostCents,
  listChatRows,
  listPageRows,
  listSourceRows,
  loadGlobalConfig,
  type KeyProvider,
} from "@llm-wiki/core";

import { Onboarding } from "@/components/onboarding";
import { openWikiContext, resolveWikiPath } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: { needsKey?: string; provider?: string; slot?: string };
}) {
  const ctx = await openWikiContext();
  let pageCount = 0;
  let sourceCount = 0;
  let chatCount = 0;
  let costCents = 0;
  const topic = ctx.settings.topic;
  try {
    pageCount = listPageRows(ctx.db).length;
    sourceCount = listSourceRows(ctx.db).length;
    chatCount = listChatRows(ctx.db).length;
    costCents = getTotalCostCents(ctx.db);
  } finally {
    ctx.db.close();
  }
  const wikiPath = resolveWikiPath();

  // First-run gate (docs/04 P0 #1). Block the dashboard until the user has
  // (a) named the wiki's topic so the LLM has scope and (b) configured an
  // OpenRouter key so any operation can actually run. Both are saved to the
  // user's own machine, no remote round-trip.
  //
  // The wizard mode (isFirstRun) vs minimal mode is decided by whether the
  // user has ever completed the welcome flow before — tracked in the global
  // config. First-ever app open gets the 4-step Welcome → Topic → Key →
  // Tour. Returning users who somehow ended up here again (new wiki without
  // a topic, key removed) get the compact single-card form.
  const [apiKeyStatus, globalCfg] = await Promise.all([
    getApiKey(),
    loadGlobalConfig(),
  ]);
  const needsTopic = topic.trim().length === 0;
  const needsKey = searchParams.needsKey === "1";
  // `requireSetup` sends the provider it was missing, so the key step asks for
  // the right field. Falling back to OpenRouter keeps old links working.
  const requiredProvider: KeyProvider =
    searchParams.provider === "deepseek" ? "deepseek" : "openrouter";
  const blockedSlot = searchParams.slot?.trim() ? searchParams.slot.trim() : null;
  // `onboardingCompletedAt` absent means either (a) brand-new install or
  // (b) the user just clicked Settings → About → "Replay welcome tour",
  // which clears the flag. In both cases we want the 4-step wizard, even
  // when topic+key are already saved — the wizard becomes a pure walkthrough
  // and the KeyStep allows blank advance via `alreadyHasKey` downstream.
  const isFirstRun = !globalCfg.onboardingCompletedAt;
  if (needsTopic || needsKey || isFirstRun) {
    return (
      <Onboarding
        needsTopic={needsTopic}
        needsKey={needsKey}
        initialTopic={topic}
        wikiPath={wikiPath}
        isFirstRun={isFirstRun}
        requiredProvider={requiredProvider}
        blockedSlot={blockedSlot}
      />
    );
  }

  const isFresh = pageCount === 0 && sourceCount === 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-12">
      <header className="mb-10">
        <p className="text-caption uppercase tracking-wider text-muted-foreground">
          {isFresh ? "欢迎" : "你的知识库"}
        </p>
        <h1 className="mt-2 font-display text-display font-semibold">
          {isFresh ? "构建一个由 LLM 为你维护的知识库。" : "LLM Wiki"}
        </h1>
        <p className="mt-3 max-w-2xl text-body text-muted-foreground">
          {isFresh
            ? "放入文章、论文、笔记或 URL。智能体会把它们编译成一个持久的、互相链接的 markdown 知识库，完全归你所有。知识会不断累积。"
            : "由 LLM 智能体维护的本地优先知识库。"}
        </p>
        <p className="mt-2 font-mono text-caption text-muted-foreground">
          {wikiPath}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="页面" value={pageCount.toString()} href="/wiki" />
        <StatTile label="Source" value={sourceCount.toString()} href="/sources" />
        <StatTile label="对话" value={chatCount.toString()} href="/chats" />
        {/* LLM spend tile points at /dashboard, not /settings — dashboard
            shows this wiki's spend in context with every other wiki's, plus
            a cumulative roll-up. Settings → Models still has the per-model
            breakdown table for a deeper view. */}
        <StatTile label="LLM 花费" value={formatCost(costCents)} href="/dashboard" />
      </section>
      <p className="mt-2 text-right text-caption text-muted-foreground">
        <Link
          href="/dashboard"
          className="hover:text-foreground"
          title="你打开过的所有知识库的统计"
        >
          ↗ 查看所有知识库
        </Link>
      </p>

      <section className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ActionCard
          tone="primary"
          title={isFresh ? "添加你的第一个Source" : "Ingest"}
          body="粘贴一篇文章、拖入 PDF，或抓取一个 URL。智能体会阅读它、撰写页面并建立交叉链接。"
          cta="打开Source页 →"
          href="/sources"
        />
        <ActionCard
          title="Query"
          body="带引用的单次问答。把好的回答沉淀为持久页面。"
          cta="打开查询页 →"
          href="/query"
        />
        <ActionCard
          title="浏览知识库"
          body={
            pageCount === 0
              ? "目前还是空的。添加一份Source，开始把它填起来。"
              : `${pageCount} 个页面，涵盖概念、实体和总览。`
          }
          cta={pageCount === 0 ? "先添加一份Source →" : "打开知识库 →"}
          href={pageCount === 0 ? "/sources" : "/wiki"}
        />
        <ActionCard
          title="体检"
          body={
            pageCount === 0
              ? "还没有可检查的内容。请先IngestSource。"
              : "扫描矛盾、失效链接、孤岛页面和内容缺口。可直接就地快速修复。"
          }
          cta={pageCount === 0 ? "先添加一份Source →" : "打开体检 →"}
          href={pageCount === 0 ? "/sources" : "/lint"}
        />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-3 md:grid-cols-2">
        <MetaCard
          title="它是如何工作的"
          items={[
            "磁盘上有三个层次：原始Source、由 LLM 维护的知识库、你的 CLAUDE.md schema。",
            "三项操作：Ingest、查询、体检。全部针对你的文件夹运行。",
            "一切都只是 markdown 文件 —— 用 git 管理它，用 iCloud 同步它，在 Obsidian 中编辑它。",
          ]}
        />
        <MetaCard
          title="快捷键"
          items={[
            { kbd: "⌘K", text: "命令面板 —— 跳转到任何地方" },
            { kbd: "⌘,", text: "设置" },
            { kbd: "⌘↵", text: "提交（表单 / 对话输入框中）" },
            { kbd: "esc", text: "关闭对话框" },
          ]}
        />
      </section>
    </div>
  );
}

// ---- bits ---------------------------------------------------------------

function StatTile({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-border/70 bg-card px-4 py-3 transition-all duration-100 hover:border-primary/40 hover:bg-accent/40 active:scale-[0.99]"
    >
      <p className="text-caption uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-h2 font-semibold tabular-nums">{value}</p>
    </Link>
  );
}

function ActionCard({
  tone = "default",
  title,
  body,
  cta,
  href,
}: {
  tone?: "default" | "primary";
  title: string;
  body: string;
  cta: string;
  href: string;
}) {
  const primary = tone === "primary";
  return (
    <Link
      href={href}
      className={
        "group flex flex-col rounded-lg border p-5 transition-all duration-100 active:scale-[0.99] " +
        (primary
          ? "border-primary/40 bg-primary/[0.04] hover:border-primary/60 hover:bg-primary/[0.07]"
          : "border-border/70 bg-card hover:border-border")
      }
    >
      <h2 className="font-display text-h3 font-semibold">{title}</h2>
      <p className="mt-2 flex-1 text-ui text-muted-foreground">{body}</p>
      <p
        className={
          "mt-4 text-ui font-medium " +
          (primary ? "text-primary" : "text-foreground/80 group-hover:text-foreground")
        }
      >
        {cta}
      </p>
    </Link>
  );
}

type MetaItem = string | { kbd: string; text: string };

function MetaCard({ title, items }: { title: string; items: MetaItem[] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card p-5">
      <h2 className="font-display text-h3 font-semibold">{title}</h2>
      <ul className="mt-3 space-y-1.5 text-ui text-muted-foreground">
        {items.map((it, i) =>
          typeof it === "string" ? (
            <li key={i} className="leading-relaxed">
              · {it}
            </li>
          ) : (
            <li key={i} className="flex items-center gap-2.5">
              {/* sans font (Inter) so ⌘/↵/esc glyphs render correctly at
                  small sizes; mono fonts often miss or mis-baseline them. */}
              <kbd className="inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded-md border border-border bg-muted px-2 font-sans text-[12px] font-medium leading-none text-foreground/80">
                {it.kbd}
              </kbd>
              <span>{it.text}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function formatCost(cents: number): string {
  if (cents === 0) return "$0.00";
  if (cents < 1) return `$${(cents / 100).toFixed(4)}`;
  if (cents < 100) return `$${(cents / 100).toFixed(3)}`;
  return `$${(cents / 100).toFixed(2)}`;
}
