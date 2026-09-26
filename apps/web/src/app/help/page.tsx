import Link from "next/link";

import { PageContainer } from "@/components/page-shell";

export const dynamic = "force-dynamic";

export default function HelpPage() {
  return (
    <PageContainer width="lg">
      <header className="mb-12">
        <p className="text-caption uppercase tracking-wider text-muted-foreground">
          帮助
        </p>
        <h1 className="mt-2 font-display text-display font-semibold tracking-tight">
          如何使用 LLM Wiki。
        </h1>
        <p className="mt-5 max-w-2xl text-body font-serif text-muted-foreground">
          这个应用中你能做的一切，按你通常的使用顺序排列。关于它为什么存在，见{" "}
          <Link href="/about" className="text-primary underline underline-offset-2">
            关于
          </Link>
          ；关于它是如何构建的，见{" "}
          <Link href="/developers" className="text-primary underline underline-offset-2">
            开发者
          </Link>
          。
        </p>
      </header>

      {/* Table of contents — long page, helps scanning. */}
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

      <Section id="overview" eyebrow="心智模型" title="三个层次">
        <p>
          你选定的知识库文件夹中有三个层次：
        </p>
        <ul className="space-y-2">
          <Layer
            name="raw/"
            what="你的Source，原封不动。无论你粘贴或上传了什么，都逐字节保留。应用永不删除它们。"
          />
          <Layer
            name="wiki/"
            what="由 LLM 维护的页面。互相链接、简短、结构化。有意做成有损的 —— 它们是对 raw/ 的概括。"
          />
          <Layer
            name="CLAUDE.md"
            what="schema。几段浅白的说明，告诉 LLM 这个知识库是关于什么的、该如何组织。LLM 在每次操作中都会读取它。"
          />
        </ul>
        <p className="mt-4">
          LLM 针对这些层次执行三项操作：
        </p>
        <ul className="space-y-2">
          <Op
            name="Ingest"
            what="读取一份新Source → 撰写/更新知识库页面、刷新索引、记录变更。"
          />
          <Op
            name="查询"
            what="读取你的问题 + 知识库 → 生成带引用的回答。"
          />
          <Op
            name="体检"
            what="通读整个知识库 → 标出矛盾、失效链接、孤岛页面、缺失页面、过时论断。"
          />
        </ul>
      </Section>

      <Section id="wikis" eyebrow="多个知识库" title="同时持有多个知识库">
        <p>
          一个知识库应聚焦于一个主题（首次运行时设置的 schema
          会告诉 LLM 它应该待在什么范围内）。对于彼此独立的主题 ——
          比如<em>物理学</em>、<em>机器学习研究</em>，以及一个
          <em>个人知识库</em> —— 你保留各自的知识库文件夹并在它们之间切换。
        </p>
        <p>
          打开{" "}
          <Link
            href="/settings"
            className="text-primary underline underline-offset-2"
          >
            设置 → 知识库
          </Link>
          。你会看到当前启用的知识库排在顶部，以及你创建或访问过的其他知识库。你可以做两件事：
        </p>
        <ul className="space-y-1">
          <li>
            <strong>切换</strong> —— 点击某一行的“切换”。整个应用会在下一次请求时重新指向
            该知识库。无需重启，无需改端口。你的另一个知识库依然原封不动地待在磁盘上。
          </li>
          <li>
            <strong>创建新知识库</strong> —— 填写主题 + 文件夹路径，点击“创建并切换”。
            文件夹会被创建，schema 会初始化，你会落在仪表盘上，可以开始添加Source。
          </li>
        </ul>
        <p>
          启用中的知识库是按应用安装实例记录的（不是按浏览器标签页）。如果你想真正并排浏览两个
          知识库，可在不同端口上运行两个开发服务器 —— 一个终端执行 <code>LLM_WIKI_PATH=~/wiki-a pnpm dev</code>，
          另一个执行 <code>LLM_WIKI_PATH=~/wiki-b pnpm dev</code>。
        </p>
        <p>
          从选择器中移除一个知识库只会改动配置 —— 文件夹和文件仍留在磁盘上。如果你确实想删除一个
          知识库，请自己删除文件夹（<code>rm -rf ~/wiki-foo</code>）。
        </p>
      </Section>

      <Section
        id="setup"
        eyebrow="首次运行"
        title="开始设置：主题 + API 密钥"
      >
        <p>
          第一次打开应用时，你会看到一张设置卡片，要求填写两项内容：
        </p>
        <ol className="ml-5 list-decimal space-y-2">
          <li>
            <strong>知识库主题。</strong>用一句话描述这个知识库是关于什么的
            （例如<em>“量子计算研究及其背后的算法”</em>）。LLM
            在每次操作中都会读取它，所以具体比泛泛更好。
          </li>
          <li>
            <strong>OpenRouter API 密钥。</strong>在{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              openrouter.ai/keys
            </a>{" "}
            获取 —— 按量付费，一个密钥即可访问 Claude、GPT、Gemini、Llama
            等更多模型。安全地存放在你的机器上。
            <br />
            <span className="text-xs text-muted-foreground">
              注意：如果你打算对所有模型都使用本地 Ollama，则不需要 OpenRouter 密钥！你可以在引导流程中跳过这一步，稍后在设置中配置 Ollama。
            </span>
          </li>
        </ol>
        <p>
          这两项之后都可以在 <Link href="/settings" className="text-primary underline underline-offset-2">设置</Link> 中修改。
        </p>
      </Section>

      <Section
        id="sources"
        eyebrow="向知识库添加内容"
        title="Source —— 把内容送进去"
      >
        <p>
          前往{" "}
          <Link href="/sources" className="text-primary underline underline-offset-2">
            Source
          </Link>{" "}
          并在顶部选择一种模式：
        </p>
        <ul className="space-y-1">
          <li>
            <strong>粘贴</strong> —— 把文本或 markdown 放进文本域。
            适合“我只想把这篇文章加进来”的情况，最快。
          </li>
          <li>
            <strong>文件</strong> —— 拖入文件，或点击选择。支持：{" "}
            <code>.md / .txt / .html / .pdf / .docx / .pptx / .xlsx / .png /
            .jpg / .webp</code>。PDF 和图片会走视觉模型；
            其余格式在本地做文本提取。
          </li>
          <li>
            <strong>URL</strong> —— 抓取页面，用 Mozilla 的 Readability
            去掉导航/广告/侧栏，Ingest干净的正文。
          </li>
        </ul>
        <p>
          Ingest前页面会显示<strong>成本预估</strong>，避免意外。
          点击<strong>Ingest</strong>；约 10–30 秒后，你会看到新增页面、更新页面，
          以及 LLM 标出的任何矛盾的摘要。
        </p>
        <p>
          表单上方，<strong>已IngestSource</strong>会列出你添加的一切，包含格式、大小、日期，
          以及它为多少个知识库页面做出了贡献。点击任意一行即可查看原始内容 + 完整脉络。
        </p>
      </Section>

      <Section
        id="wiki"
        eyebrow="阅读"
        title="知识库 —— 浏览你的页面"
      >
        <p>
          <Link href="/wiki" className="text-primary underline underline-offset-2">
            /wiki
          </Link>{" "}
          以卡片形式按类型分组显示你的页面（总览 → 概念 →
          实体 → 对比 → Source）。每张卡片显示标题、简短摘要、标签，
          以及最后修改时间。
        </p>
        <p>点击任意卡片，你会看到：</p>
        <ul className="space-y-1">
          <li>页面正文，以易读的散文形式渲染。</li>
          <li>
            底部的<strong>Source</strong> —— 链接到 LLM 据以编译此页面的原始输入。
          </li>
          <li>
            <strong>反向链接</strong> —— 所有提到本页的其他知识库页面。也就是列表形式的图谱视图。
          </li>
          <li>
            <strong>悬浮预览</strong> —— 正文里的 <code>[[wikilink]]</code>{" "}
            不必点开：鼠标停在链接上约一秒，会浮出一张小卡片，显示目标页面的标题、类型、标签和开头一段。
            把鼠标移进卡片可以直接点“打开页面”，按 Esc 或滚动即关闭。失效链接不会弹卡片。
          </li>
          <li>
            标题栏中的<strong>编辑</strong>按钮。编辑使用真正的分栏 markdown 编辑器；
            保存时会把先前版本备份到{" "}
            <code>.llm-wiki/page-history/</code>。
          </li>
        </ul>
        <p>
          侧边栏有一个筛选输入框 —— 输入即可缩小页面列表范围。或者在任何地方按{" "}
          <kbd className="rounded border border-border bg-muted/50 px-1 font-sans text-[11px]">⌘K</kbd>{" "}
          按标题模糊查找。
        </p>
      </Section>

      <Section
        id="query"
        eyebrow="提问"
        title="查询与对话 —— 何时用哪个"
      >
        <p>
          向知识库提问有两种方式：
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SubCard title="查询 —— 单次问答">
            适合“问一次就走”。每个问题彼此独立，互不记忆。回答会附带引用的页面，
            如果值得沉淀，还会有一个可选的<strong>保存为知识库页面</strong>按钮。
          </SubCard>
          <SubCard title="对话 —— 多轮线程">
            适合持续深入的调查。每个对话都是 <code>chats/</code> 下一个真正的 markdown
            文件。可置顶、重命名、在文件夹间移动。每条助手消息都有自己的
            <strong>保存为知识库页面</strong>
            {" "}链接；整个对话在标题栏有一个<strong>Ingest → 知识库</strong>{" "}
            按钮，让综合结论变成持久的页面。
          </SubCard>
        </div>
      </Section>

      <Section
        id="lint"
        eyebrow="知识库健康"
        title="体检 —— 在腐化蔓延前发现它"
      >
        <p>
          <Link href="/lint" className="text-primary underline underline-offset-2">
            /lint
          </Link>{" "}
          会跑两轮：一次快速的本地扫描（失效的{" "}
          <code>[[wikilinks]]</code>、孤岛页面）和一次 LLM
          检查，处理本地扫描看不到的问题（页面之间的矛盾、本该存在却缺失的页面、
          过时论断、内容缺口）。
        </p>
        <p>每个问题都有修复按钮：</p>
        <ul className="space-y-1">
          <li>
            <strong>移除失效链接</strong> —— 从宿主页面中剥除错误的{" "}
            <code>[[slug]]</code>。本地执行，免费，即时。
          </li>
          <li>
            <strong>创建页面</strong> / <strong>创建占位页</strong> ——
            利用引用该 slug 的页面所提供的上下文，起草一个小页面。由 LLM
            驱动，每次点击约 $0.01。
          </li>
          <li>
            <strong>应用建议的修复</strong> —— 把受影响的页面 +
            LLM 的建议发给体检模型，把重写后的页面写回。会备份到{" "}
            <code>.llm-wiki/page-history/</code>。
          </li>
        </ul>
        <p>页面顶部有批量修复：</p>
        <ul className="space-y-1">
          <li>
            <strong>重建索引</strong> —— 根据磁盘上的页面文件重写 <code>index.md</code>。
            补上缺失条目，移除孤岛。免费，本地执行。
          </li>
          <li>
            <strong>移除所有失效链接（N）</strong> —— 一次性确认并应用所有本地检测到的
            失效链接修复。
          </li>
        </ul>
        <p>
          <strong>最近运行</strong>面板显示趋势 —— 每次体检都会在 <code>log.md</code>
          中留下一行记录。修复之后重新运行，看计数下降（显示为绿色）。
        </p>
      </Section>

      <Section
        id="graph"
        eyebrow="看见它的形态"
        title="图谱 —— 你的知识作为一张 3D 网络"
      >
        <p>
          <Link href="/graph" className="text-primary underline underline-offset-2">
            /graph
          </Link>{" "}
          把你的知识库渲染成 3D 力导向图。每个页面是一个节点；
          两个页面之间的每一条 <code>[[wikilink]]</code> 是一条边。观感与 Obsidian
          的图谱视图一致，但有一个重要区别：
        </p>
        <p>
          <strong>节点按页面类型着色</strong>，而不是按标签或文件夹。LLM
          会在Ingest时为每个页面指定类型，因此图表让你一眼看出知识库中知识的构成：
        </p>
        <ul className="space-y-1">
          <li>
            <span className="font-medium" style={{ color: "#dc2626" }}>红色</span>
            {" "}—— 总览（高层次的综合页面）
          </li>
          <li>
            <span className="font-medium" style={{ color: "#0891b2" }}>青色</span>
            {" "}—— 概念（想法、技术、框架）
          </li>
          <li>
            <span className="font-medium" style={{ color: "#d97706" }}>琥珀色</span>
            {" "}—— 实体（人物、组织、地点）
          </li>
          <li>
            <span className="font-medium" style={{ color: "#7c3aed" }}>紫色</span>
            {" "}—— 对比（两个或多个事物的对照）
          </li>
          <li>
            <span className="font-medium" style={{ color: "#64748b" }}>石板灰</span>
            {" "}—— Source型页面
          </li>
        </ul>
        <p>
          <strong>节点大小</strong>随链接数（度）变化。连接密集的页面会变大 ——
          它们是知识库的核心概念。
          <strong>沿边流动的粒子</strong>表示方向。
        </p>
        <p>
          <strong>点击一个节点</strong>即可聚焦它：相机会飞向它，相邻节点保持完整颜色，
          非相邻节点淡出。侧面板显示该页面的预览、标签，以及所有相连页面的可点击列表 ——
          让你顺着关联而不是按名称在图中穿行。URL 会更新为 <code>/graph?node=&lt;slug&gt;</code>，
          以便你收藏或分享聚焦后的视图。
        </p>
        <p>
          随着你Ingest更多Source，你会看到图谱生长：新节点弹入位置，
          任何提到新页面的既有页面都会与之形成边。
        </p>
      </Section>

      <Section
        id="schema"
        eyebrow="告诉 LLM 你想要什么"
        title="Schema —— 编辑 CLAUDE.md"
      >
        <p>
          <Link href="/schema" className="text-primary underline underline-offset-2">
            /schema
          </Link>{" "}
          是一个分栏编辑器，用于编辑 LLM 每次操作都会读取的 schema 文件。
          默认内容是通用的；替换成你的具体说明，能让智能体的输出显著变好。
        </p>
        <p>一份好的 schema 里应该写：</p>
        <ul className="space-y-1">
          <li>这个知识库是关于什么的，用 1–3 句话说明。</li>
          <li>
            你想要（以及不想要）哪些类型的页面 —— 例如<em>“为研究者建实体页，但不为机构建”</em>。
          </li>
          <li>你在意的 slug 命名约定。</li>
          <li>
            LLM 应尊重的领域忌讳（例如<em>“不要把量子优势与量子霸权混为一谈”</em>）。
          </li>
        </ul>
        <p>
          保存时会把先前版本备份到{" "}
          <code>.llm-wiki/schema-history/</code>（保留最近 10 个）。
        </p>
      </Section>

      <Section
        id="settings"
        eyebrow="调校这个闭环"
        title="设置 —— 模型、花费、密钥"
      >
        <ul className="space-y-1">
          <li>
            <strong>通用</strong> —— 知识库主题、主题外观（浅色 / 深色 / 跟随系统）。
          </li>
          <li>
            <strong>模型</strong> —— 为每项操作（Ingest、查询、对话、体检、视觉）选择提供商（OpenRouter 或本地 Ollama）和模型。你可以混用云端模型与本地推理。下拉框提供精选选项，另有自定义 slug 输入框以支持其他模型。如果你在任何位置选择了 Ollama，请参阅{" "}
            <Link href="/local-models" className="text-primary underline underline-offset-2">
              本地模型设置指南
            </Link>{" "}
            了解安装步骤与各模型的硬件要求 —— 这些槽位生效前，Ollama 需要先在本地运行。
          </li>
          <li>
            <strong>API</strong> —— OpenRouter 密钥。保存前先测试；保存后掩码显示。（如果你只用本地 Ollama，则不需要！）。
          </li>
          <li>
            <strong>花费</strong> —— 按模型统计的输入/输出 token 滚动总和 + 估算的美元支出。
          </li>
          <li>
            <strong>关于</strong> —— 版本、许可证、链接。
          </li>
        </ul>
        <p>
          经验法则：Ingest用便宜快速的模型（你会频繁运行它），
          查询 / 体检 / 对话用更聪明的模型（面向用户的回答）。
        </p>
      </Section>

      <Section
        id="local-models"
        eyebrow="想在本地运行模型？"
        title="本地模型（Ollama）—— 单独的设置指南"
      >
        <p>
          Ollama 让你在自己的机器上免费运行 LLM（模型一次性下载之后），
          所有数据都留在本地。LLM Wiki 在 设置 → 模型
          中将它支持为按槽位可选的提供商。
        </p>
        <p>
          由于 Ollama 本身需要先安装并运行，LLM Wiki 才能与它通信，
          而且选择合适的模型很大程度上取决于你手上的硬件，完整设置说明放在单独页面：
        </p>
        <p>
          <Link
            href="/local-models"
            className="text-primary underline underline-offset-2"
          >
            → 打开 Ollama 设置指南
          </Link>
        </p>
        <p>
          涵盖：macOS / Linux / Windows 的安装步骤、拉取模型、一张展示常见机器上各模型
          RAM / 磁盘 / 速度的硬件要求表、根据你的配置选择入门模型的快速选择器，
          以及常见错误的排查。
        </p>
      </Section>

      <Section
        id="dashboard"
        eyebrow="跨所有知识库"
        title="健康仪表盘"
      >
        <p>
          每个知识库的主页（<Link href="/" className="text-primary underline underline-offset-2">/</Link>）
          显示当前启用知识库的各项数字。位于{" "}
          <Link href="/dashboard" className="text-primary underline underline-offset-2">/dashboard</Link>{" "}
          的仪表盘则并排显示你打开过的每个知识库的相同数字
          —— 页面、Source、对话、LLM 花费、最后修改时间。按新旧排序，
          让你真正在用的知识库浮到顶部。
        </p>
        <p>
          顶部一行汇总把它们加总 —— 累计花费回答了“我到底在这个应用上花了多少钱”，
          而按知识库统计的花费数字回答不了这个问题。
        </p>
        <p>
          三种到达方式：<strong>页脚链接</strong>（每个界面都有）、{" "}
          主页上的 <strong>LLM 花费</strong> 磁贴、<strong>⌘K → 仪表盘</strong>。
          每张卡片都有一个<em>切换 →</em>按钮，可直接跳进该知识库。
        </p>
      </Section>

      <Section
        id="disk"
        eyebrow="文件夹"
        title="一切在磁盘上的位置"
      >
        <p>
          你的知识库文件夹（默认 <code>~/llm-wiki-default</code>，可用{" "}
          <code>LLM_WIKI_PATH</code> 覆盖）：
        </p>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-4 text-[12px] leading-relaxed">
{`~/llm-wiki-default/
├── CLAUDE.md              # the schema you edit at /schema
├── index.md               # auto-maintained catalog of pages
├── log.md                 # every ingest / edit / lint / schema-save
├── raw/                   # original source files, untouched
├── wiki/                  # LLM-maintained pages
├── chats/                 # chat threads as .md files
└── .llm-wiki/             # SQLite + page-history + schema-history`}
        </pre>
        <p>
          你可以在应用内通过{" "}
          <Link href="/log" className="text-primary underline underline-offset-2">
            /log
          </Link>
          浏览 <code>log.md</code>。其他一切都是纯 markdown —— 用 Obsidian、VS Code、vim
          打开它，或用 iCloud / git 同步。即使你卸载应用，这个文件夹依然有效且有用。
        </p>
      </Section>

      <Section
        id="updating"
        eyebrow="保持最新"
        title="更新到新版本"
      >
        <p>
          应用以{" "}
          <a
            href="https://www.npmjs.com/package/@syasas/llm-wiki"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            @syasas/llm-wiki
          </a>
          发布到 npm。新版本以补丁 / 次要版本形式发布；更新日志见{" "}
          <a
            href="https://github.com/ddsyasas/llm-wiki/releases"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            GitHub Releases
          </a>
          。
        </p>
        <p>
          <strong>如果你是使用 <code>npm install -g</code> 安装的</strong>，
          先停止正在运行的服务器（<kbd>Ctrl</kbd>+<kbd>C</kbd>），
          然后在任意终端中执行：
        </p>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`npm install -g @syasas/llm-wiki@latest
llm-wiki version     # confirm the new version
llm-wiki start       # back up and running`}
        </pre>
        <p>
          <strong>如果你是从源码安装的</strong>（git clone）：在仓库根目录执行{" "}
          <code>git pull && pnpm install</code>，然后
          重启 <code>pnpm dev</code>。
        </p>
        <p>
          <strong>你的知识库数据在升级过程中是安全的。</strong>
          v1.x 内的磁盘格式是稳定的 —— 文件夹、schema、页面、
          对话、历史记录以及你的 OpenRouter 密钥都会完整保留。
          未来版本发布 schema 迁移时，会在下次服务器启动时
          自动运行；无需手动操作。
        </p>
        <p>
          如果升级后 <code>llm-wiki version</code> 仍打印旧版本号，
          请打开一个新的终端窗口 —— 有时
          （尤其在 Windows 上）在 <code>npm install -g</code> 替换二进制文件后，
          shell 需要重新解析 PATH。
        </p>
      </Section>

      <Section
        id="troubleshooting"
        eyebrow="出问题的时候"
        title="疑难排查"
      >
        <ul className="space-y-3">
          <Trouble
            symptom="“OpenRouter API key not configured”（未使用 Ollama 时）"
            fix="打开 设置 → API，粘贴来自 openrouter.ai/keys 的密钥。如果你想用本地 Ollama，请确认 设置 → 模型 中当前模块的提供商已设为 Ollama。"
          />
          <Trouble
            symptom="“server error from Ollama / LocalTunnel (502)”或连接挂起"
            fix="你本地 11434 端口上的 Ollama 实例已停止，或你的 LocalTunnel 端点已断开/超时。确认 `ollama serve` 正在你的本机运行，并且 `.env` 中的 `OLLAMA_BASE_URL` 正确。"
          />
          <Trouble
            symptom="“model not available on OpenRouter: anthropic/claude-3-5-sonnet”"
            fix="提供商会定期下线模型。进入 设置 → 模型 → 把受影响的槽位切换到下拉框中的当前模型。"
          />
          <Trouble
            symptom='"LLM response failed schema validation"'
            fix="模型返回了格式错误的 JSON。再次点击Ingest —— 小模型偶尔会跑偏。如果反复发生，把Ingest槽位换成更聪明的模型（Sonnet、GPT-4o）。"
          />
          <Trouble
            symptom="体检反复标出同一个已修复的问题"
            fix="页面已编辑，但索引摘要已过时。在体检页面的批量修复中点击重建索引。"
          />
          <Trouble
            symptom="开发服务器感觉很慢 / 点击没反应"
            fix="开发模式下的 Next.js 会惰性编译路由。首次点击某个路由较慢，之后很快。加载骨架应立即出现 —— 如果没有，请刷新浏览器。"
          />
          <Trouble
            symptom={<><code>npm install -g</code> 之后出现 <code>llm-wiki: command not found</code></>}
            fix={<>npm 把二进制文件放到了不在你 PATH 中的位置。运行 <code>npm prefix -g</code> 找出位置，然后执行 <code>{`echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`}</code>。在 npm prefix 非标准的 WSL Ubuntu 上很常见。</>}
          />
          <Trouble
            symptom="独立服务器安装后因原生模块错误立即崩溃"
            fix={<>如果没有匹配的预编译二进制文件，某些 Linux 发行版需要构建工具来编译 <code>better-sqlite3</code> / <code>keytar</code>。在 Debian/Ubuntu 上执行：<code>sudo apt install build-essential python3 libsecret-1-dev</code>，然后重新安装。</>}
          />
        </ul>
      </Section>

      <div className="mt-12 flex flex-wrap gap-4">
        <Link
          href="/about"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          ← 返回关于
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

function Layer({ name, what }: { name: string; what: string }) {
  return (
    <li className="rounded-md border border-border/70 bg-card p-3">
      <code className="font-mono text-[13px] text-primary">{name}</code>
      <span className="ml-2 text-ui text-muted-foreground">— {what}</span>
    </li>
  );
}

function Op({ name, what }: { name: string; what: string }) {
  return (
    <li className="rounded-md border border-border/70 bg-card p-3">
      <span className="font-display text-h3 font-medium text-primary">
        {name}
      </span>
      <span className="ml-2 text-ui text-muted-foreground">— {what}</span>
    </li>
  );
}

function SubCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-card p-4">
      <p className="font-display text-h3 font-medium tracking-tight">{title}</p>
      <div className="mt-1 text-ui text-muted-foreground">{children}</div>
    </div>
  );
}

function Trouble({
  symptom,
  fix,
}: {
  symptom: React.ReactNode;
  fix: React.ReactNode;
}) {
  return (
    <li className="rounded-md border border-border/70 bg-card p-3">
      <p className="font-medium">{symptom}</p>
      <p className="mt-1 text-ui text-muted-foreground">{fix}</p>
    </li>
  );
}

const TOC: Array<{ id: string; label: string }> = [
  { id: "overview", label: "心智模型 —— 三个层次、三项操作" },
  { id: "wikis", label: "多个知识库 —— 切换与创建" },
  { id: "setup", label: "首次运行：主题 + API 密钥" },
  { id: "sources", label: "Source —— 把内容送进去" },
  { id: "wiki", label: "知识库 —— 浏览你的页面" },
  { id: "query", label: "查询与对话" },
  { id: "lint", label: "体检 —— 知识库健康" },
  { id: "graph", label: "图谱 —— 3D 网络视图" },
  { id: "dashboard", label: "仪表盘 —— 跨所有知识库的统计" },
  { id: "schema", label: "Schema —— 编辑 CLAUDE.md" },
  { id: "settings", label: "设置 —— 模型、花费、密钥" },
  { id: "local-models", label: "本地模型（Ollama）—— 单独的设置指南" },
  { id: "disk", label: "一切在磁盘上的位置" },
  { id: "updating", label: "更新到新版本" },
  { id: "troubleshooting", label: "疑难排查" },
];
