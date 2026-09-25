import Link from "next/link";

import { PageContainer } from "@/components/page-shell";
import { APP_VERSION } from "@/components/footer";

export const dynamic = "force-dynamic";

export default function DevelopersPage() {
  return (
    <PageContainer width="lg">
      <header className="mb-12">
        <p className="text-caption uppercase tracking-wider text-muted-foreground">
          开发者
        </p>
        <h1 className="mt-2 font-display text-display font-semibold tracking-tight">
          阅读、扩展与贡献。
        </h1>
        <p className="mt-5 max-w-2xl text-body font-serif text-muted-foreground">
          理解这份代码所需的一切。面向用户的指南见{" "}
          <Link href="/help" className="text-primary underline underline-offset-2">
            帮助
          </Link>
          ；产品故事见{" "}
          <Link href="/about" className="text-primary underline underline-offset-2">
            关于
          </Link>
          。设计决策的唯一事实来源在 GitHub 上的{" "}
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
      </header>

      <nav className="mb-12 rounded-md border border-border/70 bg-card p-4">
        <p className="mb-2 text-caption uppercase tracking-wider text-muted-foreground">
          本页内容
        </p>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-ui sm:grid-cols-2">
          {TOC.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className="text-foreground/80 hover:text-primary"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="stack" eyebrow="技术栈" title="底层用了什么">
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
        <p>
          设计契约中有两条硬性规则：<strong>全部使用 TypeScript</strong>（不用 Python
          边车进程），以及<strong>从第一天起就跨平台</strong>（Mac、Windows、Linux）。
          V1 不使用 Electron / Tauri / React Native —— 这个应用就是你本地运行的 Next.js 服务器。
        </p>
      </Section>

      <Section id="layout" eyebrow="目录结构" title="这个 monorepo">
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-4 text-[12px] leading-relaxed">
{`llm-wiki/
├── apps/web/                  # Next.js app (UI + API routes)
│   ├── src/app/               # routes
│   ├── src/components/        # shared React components
│   └── src/lib/server-wiki.ts # per-request DB + settings context
├── packages/core/             # wiki I/O, schemas, prompts, operations
│   ├── src/wiki.ts            # file I/O for pages, index, log
│   ├── src/db.ts              # SQLite open + schema migrations
│   ├── src/ingest.ts          # the ingest operation
│   ├── src/query.ts           # the query operation
│   ├── src/lint.ts            # the lint operation
│   ├── src/chat.ts            # chat threads (send, create, promote)
│   ├── src/editor.ts          # manual page edits + lint quick-fixes
│   ├── src/index-builder.ts   # index.md render + rebuild
│   ├── src/lint-fixes.ts      # LLM-powered lint fixes
│   ├── src/graph.ts           # /graph builder — nodes/links from pages
│   ├── src/secrets.ts         # OpenRouter key (keychain w/ file fallback)
│   ├── src/schema.ts          # zod schemas for LLM JSON contracts
│   └── src/prompts/           # system prompts per operation
├── packages/llm/              # LLM client + retries + JSON repair
│   ├── src/client.ts          # OpenRouter via openai SDK + defensive parse
│   └── src/models.ts          # model presets + pricing table
├── packages/ingestion/        # source-format extractors
│   ├── src/pdf.ts             # vision-model pipeline
│   ├── src/docx.ts            # mammoth
│   ├── src/html.ts            # Readability + jsdom + turndown
│   └── …                      # one extractor per format
└── docs/                      # spec — read 01-vision.md first`}
        </pre>
      </Section>

      <Section id="ops" eyebrow="三项操作" title="入库、查询、体检">
        <p>
          Karpathy 的范式以三项操作为核心。每一项都是 <code>packages/core/</code>{" "}
          中的一个函数，接收知识库路径、数据库连接、LLM 客户端和模型 slug。
        </p>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <OpCard
            name="ingest"
            file="packages/core/src/ingest.ts"
            entry="ingestSource() / ingestPastedText() / ingestVisionSource()"
            what="读取 schema + 索引 + 前 K 个相关页面，以严格的 JSON schema（经 zod 校验）调用 LLM，撰写新页面、更新既有页面（带备份）、刷新索引、追加日志。"
          />
          <OpCard
            name="query"
            file="packages/core/src/query.ts"
            entry="answerQuery()"
            what="读取 schema + 索引 + 前 K 个页面，带着问题调用 LLM，返回回答 + 被引用的 slug + 一个用户可采纳的新页面建议。"
          />
          <OpCard
            name="lint"
            file="packages/core/src/lint.ts"
            entry="lintWiki()"
            what="两轮：本地扫描（失效链接 + 孤岛页面，不用 LLM）和 LLM 检查（矛盾、缺口、过时、缺失页面）。返回分组的问题 + 建议修复文本 + 总体健康评级。"
          />
        </div>
      </Section>

      <Section
        id="contracts"
        eyebrow="LLM 契约"
        title="LLM 必须返回的 JSON 结构"
      >
        <p>
          每次 LLM 调用都不使用流式，且返回的 JSON 在使用前都会经过 zod 校验。
          schema 位于{" "}
          <code>packages/core/src/schema.ts</code>：
        </p>
        <ul className="space-y-1">
          <li>
            <code>IngestResponseSchema</code> — newPages, pageUpdates,
            indexEntries, logEntry, contradictions
          </li>
          <li>
            <code>QueryResponseSchema</code> — answer, pagesUsed,
            suggestedNewPage, confidence, caveats
          </li>
          <li>
            <code>LintResponseSchema</code> — issues (severity + type +
            description + affectedPages + suggestedFix), suggestedQuestions,
            overallHealth
          </li>
        </ul>
        <p>
          LLM 客户端（
          <code>packages/llm/src/client.ts</code>）处理：
        </p>
        <ul className="space-y-1">
          <li>
            <strong>防御性 JSON 解析</strong> —— 剥掉 markdown 代码
            围栏（Anthropic 的模型很喜欢把 JSON 包在{" "}
            <code>```json</code> 里）并截取从第一个花括号到
            最后一个花括号之间的内容。
          </li>
          <li>
            <strong>一次修复重试</strong>：遇到 InvalidJsonError 时重试一次，
            然后把错误呈现给界面。
          </li>
          <li>
            <strong>带退避的重试</strong>：针对 5xx / 网络错误 / 429
            （遵守 Retry-After）。
          </li>
          <li>
            <strong>AbortSignal 传递</strong>：支持用户在请求进行中
            取消。
          </li>
        </ul>
      </Section>

      <Section
        id="storage"
        eyebrow="存储"
        title="文件是事实来源，SQLite 存元数据"
      >
        <p>
          知识库文件夹是事实来源。SQLite（
          <code>.llm-wiki/meta.sqlite</code>）是派生缓存 ——
          可以在启动时通过{" "}
          <code>syncWikiToDb()</code> 以及实时文件监听从磁盘上的 markdown 重新生成。
        </p>
        <p>SQLite 数据表：</p>
        <ul className="space-y-1">
          <li>
            <code>sources</code> —— 每一份原始输入（文件名、格式、大小、
            ingested_at、url、title）
          </li>
          <li>
            <code>pages</code> —— 为界面快速查询而缓存的 wiki 页面
          </li>
          <li>
            <code>pages_fts</code> —— 针对 title + content +
            tags 的 FTS5 虚拟表，用于入库/查询/体检时的前 K 相关性排序
          </li>
          <li>
            <code>page_sources</code> —— 多对多关联。支撑每个 wiki 页面上的
            “来源”区块，以及每个来源详情页上的“贡献了 N
            个页面”视图
          </li>
          <li>
            <code>chats</code> —— 对话线程元数据（文件仍是事实
            来源）
          </li>
          <li>
            <code>usage</code> —— 每次调用的 token + 成本记录，供
            设置 → 花费 标签页使用
          </li>
          <li>
            <code>response_cache</code> —— 以哈希为键的 LLM 响应缓存
            （占位；V1 中未使用）
          </li>
        </ul>
        <p>
          Wiki 文件可以在外部编辑（Obsidian、vim、git pull）。{" "}
          <code>chokidar</code> 监听文件夹，并在变化时重新同步 SQLite
          中的记录。
        </p>
      </Section>

      <Section
        id="extend"
        eyebrow="扩展"
        title="添加一种新的来源格式"
      >
        <ol className="ml-5 list-decimal space-y-2">
          <li>
            在 <code>packages/ingestion/src/&lt;format&gt;.ts</code> 中编写提取器。
            它接收一个 <code>Buffer</code> 并返回{" "}
            <code>{`{ kind: "text" | "vision", title, content, metadata? }`}</code>。
          </li>
          <li>
            在{" "}
            <code>packages/ingestion/src/detect.ts</code> 中注册该格式，
            让文件扩展名检测能路由到它。
          </li>
          <li>
            在{" "}
            <code>apps/web/src/app/api/ingest/route.ts</code> 的{" "}
            <code>runExtractor()</code> 中添加分支。
          </li>
          <li>
            把文件扩展名追加到来源页面的{" "}
            <code>ACCEPTED_EXTENSIONS</code> 常量，
            让文件选择器接受它。
          </li>
        </ol>
        <p>
          支持视觉的格式（PDF、图片）走{" "}
          <code>ingestVisionSource()</code>，它把字节以 base64
          放在 <code>image_url</code> 消息部分中发送。文本路径
          使用 <code>ingestSource()</code>。
        </p>
      </Section>

      <Section
        id="swap-llm"
        eyebrow="LLM"
        title="更换提供商"
      >
        <p>
          默认使用 OpenRouter，因为一个密钥就能访问大多数前沿模型。
          要使用其他提供商：
        </p>
        <ul className="space-y-1">
          <li>
            <strong>直连 Anthropic / OpenAI 等</strong> —— 修改{" "}
            <code>packages/llm/src/client.ts</code> 中{" "}
            <code>createClient()</code> 的 <code>baseURL</code>。{" "}
            <code>openai</code> SDK 可用于任何 OpenAI 兼容端点。
          </li>
          <li>
            <strong>Ollama / 本地模型</strong> —— 通过{" "}
            <code>WikiSettings.defaultModels</code> 中每个模型槽位的{" "}
            <code>provider</code> 字段获得一等支持。
            <code>createClient(apiKey, "ollama")</code>
            {" "}会路由到 <code>http://localhost:11434/v1</code>（或环境变量{" "}
            <code>OLLAMA_BASE_URL</code>，若已设置）。面向用户的设置说明与各模型的硬件要求见应用内的{" "}
            <Link
              href="/local-models"
              className="text-primary underline underline-offset-2"
            >
              本地模型设置指南
            </Link>
            。注意：许多本地模型在严格 JSON 输出上很吃力；防御性解析有帮助，但救不回格式严重错误的响应。
          </li>
          <li>
            <strong>按操作覆盖</strong> —— 每项操作都
            接受 <code>modelOverride</code> 参数。界面通过
            设置 → 模型 中的按槽位下拉框暴露这一能力。
          </li>
        </ul>
      </Section>

      <Section
        id="contracts-prompts"
        eyebrow="提示词"
        title="LLM 的指令放在哪里"
      >
        <p>
          每项操作一个文件，位于 <code>packages/core/src/prompts/</code>：
        </p>
        <ul className="space-y-1">
          <li>
            <code>ingest.ts</code> —— 严格的 JSON 结构、逐字段规则、
            wikilink 约定
          </li>
          <li>
            <code>query.ts</code> —— 引用规则 + “保存为知识库页面”
            建议的判定标准
          </li>
          <li>
            <code>chat.ts</code> —— 对话语气、引用规则、
            保持线程连续性
          </li>
          <li>
            <code>lint.ts</code> —— 该标出什么、忽略什么、如何
            表述建议修复
          </li>
        </ul>
        <p>
          每个提示词都内嵌一个逐字的 <code>JSON_SHAPE</code> 块，
          展示期望的输出对象，并附逐字段规则。
          这是在多个小模型反复在字段类型上跑偏之后加上去的
          （例如把用户的主题塞进某个分类枚举）。
        </p>
      </Section>

      <Section
        id="quickfixes"
        eyebrow="体检修复"
        title="快速修复是如何分发的"
      >
        <p>
          所有体检修复都经由单一端点：{" "}
          <code>POST /api/lint/fix</code>，带一个 <code>type</code>{" "}
          判别字段：
        </p>
        <ul className="space-y-1">
          <li>
            <code>remove-broken-link</code> —— 本地；通过{" "}
            <code>editor.ts</code> 中的{" "}
            <code>removeBrokenLink()</code> 从宿主页面剥除{" "}
            <code>[[slug]]</code>
          </li>
          <li>
            <code>rebuild-index</code> —— 本地；调用{" "}
            <code>index-builder.ts</code> 中的{" "}
            <code>rebuildIndexFromPages()</code>
          </li>
          <li>
            <code>fix-all-broken-links</code> —— 本地；对数组迭代调用{" "}
            <code>removeBrokenLink</code>
          </li>
          <li>
            <code>create-stub-page</code> —— LLM；收集反向链接作为
            上下文，调用{" "}
            <code>lint-fixes.ts</code> 中的 <code>createStubPage()</code>。当
            该 slug 已有页面时回退到{" "}
            <code>rebuild-index</code>。
          </li>
          <li>
            <code>apply-suggested-fix</code> —— LLM；调用{" "}
            <code>applyLintSuggestedFix()</code>。客户端通过在建议修复文本中
            扫描 <code>affectedPages</code> 里的 kebab-case slug 来
            选定目标页面（不一定是
            <code>affectedPages[0]</code>）。空操作检测：如果 LLM
            返回未改动的内容，就跳过写入并告知界面。
          </li>
        </ul>
      </Section>

      <Section
        id="graph"
        eyebrow="可视化"
        title="3D 图谱视图（/graph）"
      >
        <p>
          把知识库渲染成 3D 力导向图。每个页面是一个节点；
          每一条 <code>[[wikilink]]</code> 是一条边。基于{" "}
          <code>react-force-graph-3d</code> 构建（底层是 Three.js + d3-force-3d
          —— 与 Obsidian 的 3D Graph 插件同引擎）。
        </p>
        <ul className="space-y-1">
          <li>
            <strong>构建器</strong> ——{" "}
            <code>packages/core/src/graph.ts</code> 的 <code>buildGraph(wikiPath, db)</code>。
            复用已有的 <code>uniqueLinkedSlugs()</code> 解析器；丢弃
            失效链接（那是体检的职责）和自链接。
          </li>
          <li>
            <strong>页面</strong> ——{" "}
            <code>apps/web/src/app/graph/page.tsx</code> 服务端组件。
            从 <code>searchParams</code> 读取 <code>?node=&lt;slug&gt;</code>，
            让深链接无需客户端闪烁即可生效。
          </li>
          <li>
            <strong>客户端组件</strong> ——{" "}
            <code>apps/web/src/components/graph/vault-graph.tsx</code>。使用{" "}
            <code>ssr: false</code> 动态导入，让约 600KB 的 three.js 包
            不进入其他路由的负载。通过 <code>&lt;html&gt;</code> 上的{" "}
            <code>MutationObserver</code> 监听主题类变化来实现
            主题响应。
          </li>
          <li>
            <strong>URL 状态</strong>通过{" "}
            <code>window.history.replaceState</code> 管理（而不是{" "}
            <code>useRouter().replace()</code>），这样点击选择时不会
            触发 Next 路由重渲染。
          </li>
        </ul>
        <p>
          设计与决策见{" "}
          <a
            href="https://github.com/ddsyasas/llm-wiki/blob/main/docs/12-graph-view.md"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            docs/12-graph-view.md
          </a>
          。
        </p>
      </Section>

      <Section
        id="testing"
        eyebrow="测试"
        title="测试套件放在哪里"
      >
        <ul className="space-y-1">
          <li>
            <code>packages/core/</code> —— <strong>约 120+ 个 vitest 测试</strong>，{" "}
            覆盖 wiki 读写、数据库 CRUD、同步、入库、查询、体检、对话、
            编辑器、索引构建、链接、配置、密钥。
          </li>
          <li>
            <code>packages/llm/</code> —— <strong>17 个测试</strong>，针对
            LLM 客户端（正常路径、错误映射、重试行为、
            防御性 JSON 解析）。
          </li>
          <li>
            <code>packages/ingestion/</code> —— 每种格式的提取器冒烟测试。
          </li>
        </ul>
        <p>在仓库根目录运行：</p>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`pnpm -r --filter @llm-wiki/core test --run
pnpm -r exec tsc --noEmit            # monorepo typecheck`}
        </pre>
      </Section>

      <Section
        id="distribution"
        eyebrow="发布"
        title="构建 + 发布流水线"
      >
        <p>
          构建会产出两个形态差异很大的产物：
        </p>
        <ul className="space-y-2">
          <li>
            <strong>独立服务器包</strong>（<code>.next/standalone/</code>）
            —— <code>llm-wiki start</code> 实际运行的东西。<code>next build</code>{" "}
            会追踪服务器所需的每个模块，并把它们复制到与 <code>server.js</code>{" "}
            并列的自包含目录树中。一个构建后脚本（<code>scripts/copy-standalone-assets.mjs</code>）
            做了 Next 14 留给你的事情：把 <code>.next/static</code> +{" "}
            <code>public</code> 复制到独立目录树中，并从正确的工作区根目录解析 +
            深拷贝每一个 <code>serverComponentsExternalPackages</code>{" "}
            条目（在 pnpm + transpilePackages 组合下，Next
            的追踪器会跳过外部依赖）。
          </li>
          <li>
            <strong>可发布的 tarball</strong>（<code>dist-publish/</code>）
            —— 上传到 GitHub Releases / npm 的东西。
            {" "}<code>scripts/build-publish-tarball.mjs</code> 组装出一个
            干净的包：用公开名称（<code>@syasas/llm-wiki</code>）重写{" "}
            <code>package.json</code>，剥离工作区
            依赖 + 构建期依赖，并把原生包外部化
            （<code>better-sqlite3</code>、<code>keytar</code>，以及像{" "}
            <code>jsdom</code> 这样较重的纯 JS 包），让 <code>npm install</code>{" "}
            在安装时抓取对应平台的二进制文件。它还会展平独立的{" "}
            <code>.pnpm/</code> 存储，让 Node 常规的
            解析器无需 pnpm 的符号链接图就能找到一切。
          </li>
        </ul>
        <p><code>apps/web</code> 中有两个 pnpm 脚本：</p>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`pnpm build:publish    # build + assemble dist-publish/
pnpm pack:publish     # build:publish + npm pack (smoke test)`}
        </pre>
        <p>
          真正发布：<code>cd apps/web/dist-publish && npm publish --access public</code>
          {" "}—— 这一步有意做成手动的（上传不可撤销）。
        </p>
      </Section>

      <Section
        id="contributing"
        eyebrow="参与贡献"
        title="开放问题 + 指引"
      >
        <p>
          本项目采用 MIT 许可证，欢迎提交 PR。在开 PR 之前：
        </p>
        <ul className="space-y-1">
          <li>
            阅读仓库根目录的 <code>CLAUDE.md</code>，了解该做/不该做的
            清单。
          </li>
          <li>
            阅读 <code>docs/01-vision.md</code> 到{" "}
            <code>docs/11-attribution-license.md</code>，了解设计
            契约 —— V1 的范围是有意做小的。
          </li>
          <li>
            查看 <code>docs/dev-log.md</code> 了解执行历史与
            开放问题（V2 想法、推迟的打磨项等）。
          </li>
          <li>
            查看 <code>docs/dev-setup.md</code> 了解运行/停止/恢复
            步骤，以及“为什么 3000 端口被占用”的排查。
          </li>
        </ul>
        <p className="text-caption text-muted-foreground">
          v{APP_VERSION} · MIT ·{" "}
          <a
            href="https://github.com/ddsyasas/llm-wiki"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            github.com/ddsyasas/llm-wiki
          </a>
        </p>
      </Section>

      <div className="mt-12 flex flex-wrap gap-4">
        <Link
          href="/about"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          ← 关于
        </Link>
        <Link
          href="/help"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          ← 帮助
        </Link>
      </div>
    </PageContainer>
  );
}

// ---- pieces -------------------------------------------------------------

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-12 scroll-mt-20">
      <p className="text-caption uppercase tracking-wider text-muted-foreground">
        {eyebrow}
      </p>
      <h2 className="mt-1 mb-4 font-display text-h2 font-semibold tracking-tight">
        {title}
      </h2>
      <div className="space-y-3 text-body font-serif leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

function OpCard({
  name,
  file,
  entry,
  what,
}: {
  name: string;
  file: string;
  entry: string;
  what: string;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-card p-4">
      <p className="font-display text-h3 font-medium tracking-tight text-primary">
        {name}
      </p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
        {file}
      </p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
        → {entry}
      </p>
      <p className="mt-2 text-ui text-muted-foreground">{what}</p>
    </div>
  );
}

const TOC: Array<{ id: string; label: string }> = [
  { id: "stack", label: "技术栈" },
  { id: "layout", label: "Monorepo 目录结构" },
  { id: "ops", label: "三项操作" },
  { id: "contracts", label: "LLM JSON 契约" },
  { id: "storage", label: "存储 —— 文件 + SQLite" },
  { id: "extend", label: "添加一种新的来源格式" },
  { id: "swap-llm", label: "更换 LLM 提供商" },
  { id: "contracts-prompts", label: "提示词放在哪里" },
  { id: "quickfixes", label: "体检快速修复的分发" },
  { id: "graph", label: "3D 图谱视图" },
  { id: "testing", label: "测试套件" },
  { id: "distribution", label: "构建 + 发布流水线" },
  { id: "contributing", label: "参与贡献" },
];

const STACK: Array<{ label: string; value: string }> = [
  { label: "语言", value: "TypeScript 严格模式" },
  { label: "框架", value: "Next.js 14（App Router）" },
  { label: "界面", value: "React、Tailwind、shadcn 风格基础组件" },
  { label: "存储", value: "纯 markdown + SQLite（better-sqlite3）" },
  { label: "检索", value: "FTS5（内置于 SQLite）" },
  { label: "LLM SDK", value: "openai npm 包，指向 OpenRouter 基础 URL" },
  { label: "Schema 校验", value: "zod" },
  { label: "Frontmatter", value: "gray-matter" },
  { label: "文件监听", value: "chokidar" },
  { label: "测试", value: "vitest" },
  { label: "包管理器", value: "pnpm workspaces" },
  { label: "Node", value: "≥ 18.17" },
];
