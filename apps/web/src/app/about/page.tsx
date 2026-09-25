import Link from "next/link";

import { PageContainer } from "@/components/page-shell";
import { APP_VERSION } from "@/components/footer";

export const dynamic = "force-dynamic";

export default function AboutPage() {
  return (
    <PageContainer width="lg">
      {/* Hero — Fraunces title sets the scholarly tone the rest of the page
          tries to live up to. */}
      <header className="mb-12">
        <p className="text-caption uppercase tracking-wider text-muted-foreground">关于</p>
        <h1 className="mt-2 font-display text-display font-semibold tracking-tight">
          一个由 LLM 为你维护的个人维基百科。
        </h1>
        <p className="mt-5 max-w-2xl text-body font-serif text-muted-foreground">
          你放入Source —— 论文、文章、笔记、URL。LLM 智能体会阅读它们，撰写互相链接的页面，
          维护索引，并在新Source改变全貌时修订旧页面。结果是这样一个知识库：它会<em>不断累积</em>——
          每一份Source都让每个页面更丰富，而不只是多出一页。
        </p>
        <a
          href="https://www.producthunt.com/products/llm-wiki-cc?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-llm-wiki-cc"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1159603&theme=light&t=1780562921195"
            alt="LLM Wiki cc - A personal Wikipedia an LLM maintains for you | Product Hunt"
            width={250}
            height={54}
          />
        </a>
      </header>

      <Section eyebrow="这个范式" title="建立在 Karpathy 的想法之上">
        <p>
          2026 年 4 月，Andrej Karpathy{" "}
          <a
            href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            勾画了一个范式
          </a>
          ：面向个人知识库，把 LLM 当作知识工程师而不是搜索引擎。三个层次（原始Source、由 LLM
          维护的知识库、LLM 每次调用都会读取的 schema）加上三项操作（Ingest、查询、体检）
          构成一个闭环，你喂给它的越多，它就越好。
        </p>
        <blockquote className="my-4 border-l-2 border-primary/40 pl-4 font-serif italic text-foreground/80">
          “Obsidian 是 IDE。LLM 是程序员。知识库是代码库。”
        </blockquote>
        <p>
          LLM Wiki 是该范式的开源实现 —— 本地优先、自带密钥、自始至终都是纯 markdown。
          即使你删除这个应用，你的知识库依然可用。
        </p>
      </Section>

      <Section eyebrow="你会得到什么" title="知识库 + 它的 3D 形态视图">
        <p>你的知识会呈现在两个互补的视图中：</p>
        <ul className="space-y-1">
          <li>
            <strong>知识库本身</strong> —— 按类型分组的 markdown 页面（总览、概念、实体、
            对比、Source），带完整的反向链接和Source脉络。像读教科书一样阅读它，检索它，编辑它。
          </li>
          <li>
            <strong>3D 图谱</strong>，包含每一个页面和每一条交叉链接 —— 与 Obsidian
            的图谱视图同引擎、同观感，但按<em>页面类型</em>着色，而不是自由标签。随着你不断
            IngestSource，亲眼看着知识实实在在生长；孤岛和枢纽在空间上一目了然。
          </li>
        </ul>
      </Section>

      <Section eyebrow="为什么会有它" title="没人填补的那块空白">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SubCard title="RAG 对话（NotebookLM、ChatGPT 文件）">
            无状态。每次查询都从零重新发现你的语料。不会积累任何你日后可以翻阅的东西。
          </SubCard>
          <SubCard title="笔记应用（Obsidian、Notion）">
            全部维护负担都在人身上。你写、你交叉链接、你检查矛盾。什么都无法规模化。
          </SubCard>
        </div>
        <p className="mt-4">
          LLM Wiki 介于两者之间。LLM 负责维护；知识库不断累积价值；文件归你所有。喂给它三个月
          之后，你就拥有了一份关于你所关心话题的、可导航、有引用、刻意组织的知识体 ——
          而你一行页面都不必自己写。
        </p>
      </Section>

      <Section eyebrow="一个知识库，还是多个" title="每个主题一个知识库 —— 一键切换">
        <p>
          一个知识库应聚焦于一个主题 —— 你在首次运行时设置的 schema 会让 LLM 保持在范围内。
          对于彼此独立的主题（比如<em>物理学</em>、<em>机器学习研究</em>，以及一个
          <em>个人知识库</em>），你保留各自的知识库文件夹，并在{" "}
          <Link href="/settings" className="text-primary underline underline-offset-2">
            设置 → 知识库
          </Link>
          中切换。切换会在下一次请求时把整个应用重新指向 —— 无需重启，无需折腾端口。
          每个知识库都是你自己完全拥有的文件夹。
        </p>
      </Section>

      <Section eyebrow="适合谁" title="如果你符合以下任一条">
        <ul className="space-y-2">
          {AUDIENCE.map((row) => (
            <li
              key={row.who}
              className="flex flex-col gap-1 rounded-md border border-border/70 bg-card p-4 sm:flex-row sm:items-baseline sm:gap-4"
            >
              <span className="font-display text-h3 font-medium tracking-tight sm:w-44">
                {row.who}
              </span>
              <span className="text-ui text-muted-foreground">{row.what}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section eyebrow="原则" title="它拒绝做什么">
        <ul className="space-y-2">
          {PRINCIPLES.map((p) => (
            <li key={p.title} className="border-l-2 border-border pl-4">
              <p className="font-medium text-foreground">{p.title}</p>
              <p className="mt-0.5 text-ui text-muted-foreground">{p.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section eyebrow="技术" title="技术栈简述">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {STACK.map((row) => (
            <div key={row.label} className="flex items-baseline gap-3">
              <dt className="w-32 shrink-0 text-caption uppercase tracking-wider text-muted-foreground">
                {row.label}
              </dt>
              <dd className="text-ui">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-caption text-muted-foreground">
          想深入了解，请见{" "}
          <Link href="/developers" className="text-primary underline underline-offset-2">
            开发者页面
          </Link>{" "}
          或 GitHub 上的{" "}
          <a
            href="https://github.com/ddsyasas/llm-wiki/tree/main/docs"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            /docs 文件夹
          </a>
          。
        </p>
      </Section>

      <Section eyebrow="致谢" title="由 Yasas 制作，范式来自 Karpathy。">
        <p>
          由{" "}
          <a
            href="https://github.com/ddsyasas"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Yasas
          </a>{" "}
          从零实现 LLM Wiki 范式，该范式由{" "}
          <a
            href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Andrej Karpathy 描述
          </a>
          。以 MIT 许可证发布。欢迎在{" "}
          <a
            href="https://github.com/ddsyasas/llm-wiki"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            GitHub
          </a>
          上贡献代码或分叉。
        </p>
        <p className="mt-2 text-caption text-muted-foreground">
          v{APP_VERSION} · 安装命令 <code>npm install -g </code>
          <a
            href="https://www.npmjs.com/package/@syasas/llm-wiki"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            @syasas/llm-wiki
          </a>
          。已在 macOS、Linux、Windows 上验证。
        </p>
        <p className="mt-2 text-caption text-muted-foreground">
          项目网站：{" "}
          <a
            href="https://llmwiki.cc"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            llmwiki.cc
          </a>{" "}
          —— 也提供托管版本（等待名单），适合不想安装任何东西的人。
        </p>
        <p className="mt-2 text-caption text-muted-foreground">
          LLM Wiki 与 Andrej Karpathy 或 Anthropic 没有隶属关系；范式是他的，实现是独立的。
        </p>
      </Section>

      <div className="mt-12 flex flex-wrap gap-4">
        <Link
          href="/help"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          第一次来？阅读帮助指南 →
        </Link>
        <Link
          href="/developers"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          想构建或扩展它？看开发者页面 →
        </Link>
      </div>
    </PageContainer>
  );
}

// ---- pieces -------------------------------------------------------------

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <p className="text-caption uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-1 mb-4 font-display text-h2 font-semibold tracking-tight">{title}</h2>
      <div className="space-y-3 text-body font-serif leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

function SubCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/70 bg-card p-4">
      <p className="font-display text-h3 font-medium tracking-tight">{title}</p>
      <p className="mt-1 text-ui text-muted-foreground">{children}</p>
    </div>
  );
}

const AUDIENCE: Array<{ who: string; what: string }> = [
  {
    who: "研究者",
    what: "综述你反复回看的文献。引用始终附着在论断上，矛盾会在体检中浮现。",
  },
  {
    who: "律师 / 律师助理",
    what: "围绕某个案件或某个监管领域建立可用的知识。每一条论断都能追溯到磁盘上的Source文档。",
  },
  {
    who: "医生 / 临床工作者",
    what: "保存一份私密的指南、研究与个人笔记参考。涉及患者相关材料时无需上传云端。",
  },
  {
    who: "记者 / 分析师",
    what: "用于同一批人名、机构、日期反复出现的条线报道。知识库成为你报道这个故事的第二大脑。",
  },
  {
    who: "教育工作者",
    what: "构建一份随你Ingest新读物而自我更新的课程大纲。交叉引用始终有效。",
  },
  {
    who: "独立开发者 / 技术创始人",
    what: "为你要进入的市场建立私密知识库。Ingest竞品文档、客户笔记、你自己的决策。",
  },
];

const PRINCIPLES: Array<{ title: string; body: string }> = [
  {
    title: "文件优先于数据库。",
    body: "每一个你可能想保留的产物，都是你选定文件夹里的一个 markdown 文件。SQLite 只存元数据 —— 可以安全删除，能重新生成。",
  },
  {
    title: "不锁定。",
    body: "开放标准（Markdown、SQLite），LLM 使用自带密钥。卸载应用后，你的知识库在任何编辑器里依然可用。",
  },
  {
    title: "智能体干活。",
    body: "你不该被迫手动更新交叉引用、生成摘要或维护索引。LLM 负责编译，你负责阅读。",
  },
  {
    title: "诚实的成本。",
    body: "每项操作在运行前都会大致告诉你将花费多少 token。没有意外账单。",
  },
  {
    title: "本地优先，自带密钥。",
    body: "没有遥测，没有远程存储，没有登录。你自带 OpenRouter 密钥；我们永远看不到它。",
  },
];

const STACK: Array<{ label: string; value: string }> = [
  { label: "框架", value: "Next.js 14（App Router），TypeScript 严格模式" },
  { label: "界面", value: "Tailwind + shadcn 风格组件，Fraunces / Crimson Pro / Inter" },
  { label: "存储", value: "纯 markdown 文件 + SQLite（better-sqlite3）保存元数据" },
  {
    label: "LLM",
    value: "OpenRouter（自带密钥）—— Claude / GPT / Gemini / Llama，按操作自选",
  },
  { label: "检索", value: "对页面正文 + frontmatter 标题/标签使用 FTS5" },
  {
    label: "Ingest",
    value:
      "mammoth（DOCX）、officeparser（XLSX/PPTX）、@mozilla/readability（HTML/URL）、面向 PDF/图片的视觉模型",
  },
  { label: "许可证", value: "MIT" },
];
