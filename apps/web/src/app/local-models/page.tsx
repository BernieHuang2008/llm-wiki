import Link from "next/link";

import { PageContainer } from "@/components/page-shell";

export const dynamic = "force-dynamic";

// Standalone setup guide for using Ollama (local LLM runtime) with LLM Wiki.
// Linked from:
//  - Settings → Models tab (amber banner when any slot uses Ollama)
//  - /help (under the Settings section)
//  - /developers (under the LLM provider section)
// Public route, no auth, no setup-gate — should be reachable even before
// the user has configured anything else.
export default function LocalModelsPage() {
  return (
    <PageContainer width="lg">
      <header className="mb-12">
        <p className="text-caption uppercase tracking-wider text-muted-foreground">
          设置指南
        </p>
        <h1 className="mt-2 font-display text-display font-semibold tracking-tight">
          使用 Ollama 运行本地模型。
        </h1>
        <p className="mt-5 max-w-2xl text-body font-serif text-muted-foreground">
          在{" "}
          <Link href="/settings" className="text-primary underline underline-offset-2">
            设置 → 模型
          </Link>{" "}
          中选择 <strong>Ollama（本地）</strong>{" "}
          作为提供商，会把该操作路由到你本机上运行的本地 LLM。
          每次查询免费、完全私密，但需要先自行安装 Ollama 并拉取模型。
          本页会逐步讲解这两件事，以及你的硬件实际上能跑什么。
        </p>
      </header>

      {/* TOC — long page, helps scanning */}
      <nav className="mb-12 rounded-md border border-border/70 bg-card p-4">
        <p className="mb-2 text-caption uppercase tracking-wider text-muted-foreground">
          本页内容
        </p>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-ui sm:grid-cols-2">
          {TOC.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} className="text-foreground/80 hover:text-primary">
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="why" eyebrow="何时该用它" title="本地与云端 —— 各自适合什么情况">
        <p>
          如果符合以下任一条，你大概会想用 Ollama：
        </p>
        <ul className="space-y-1">
          <li>
            <strong>隐私很重要。</strong>Source文档永不离开你的机器。适用于机密研究、法律笔记、医疗记录，以及任何你不会粘进 ChatGPT 的内容。
          </li>
          <li>
            <strong>你会Ingest很多内容。</strong>如果你要给知识库喂进数百份Source，
            按 token 计费的成本会累积起来。本地在模型一次性下载完成后按查询计费为零
            （只花电费）。
          </li>
          <li>
            <strong>你需要离线能力。</strong>模型拉取完成后，
            Ollama 无需联网即可工作。适用于航班上、安全环境中，或网络不稳时。
          </li>
          <li>
            <strong>你在做实验。</strong>尝试不同的模型规模、
            对比输出风格、了解 LLM 实际的行为方式 —— 全程不消耗 API 额度。
          </li>
        </ul>
        <p>
          如果符合以下情况，你大概会想用 OpenRouter（云端）：
        </p>
        <ul className="space-y-1">
          <li>
            <strong>质量最重要</strong> —— 前沿模型（Claude 4.6、
            GPT-4o、Gemini 2.5 Pro）仍然明显比你能在本地运行的最好的
            开源模型更聪明。
          </li>
          <li>
            <strong>你的硬件比较一般。</strong>一台 5 年前、8 GB 内存的笔记本
            能跑小模型，但又慢又差。云端总是很快。
          </li>
          <li>
            <strong>你只是偶尔需要它。</strong>5 美元的 OpenRouter
            额度用默认模型可以撑好几周。低于这个门槛时，
            管理本地模型的心力成本高于云端模型的美元成本。
          </li>
        </ul>
        <p>
          <strong>混用完全没问题。</strong>你可以把Ingest设为 Ollama
          （重、你不想盯着看）而把对话设为 OpenRouter（交互式、
          想要前沿质量）。LLM Wiki 按槽位选择。
        </p>
      </Section>

      <Section id="install" eyebrow="第 1 步" title="安装 Ollama">
        <p>
          一次性安装。选择你的操作系统：
        </p>

        <h3 className="mt-6 font-display text-h3 font-semibold tracking-tight">macOS</h3>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`# With Homebrew (recommended — auto-starts a background service)
brew install ollama

# Or download the .dmg installer from https://ollama.com/download`}
        </pre>
        <p className="mt-2 text-caption text-muted-foreground">
          Apple Silicon（M1 及以上）开箱即得 GPU 加速。Intel Mac
          也能用，但更慢。
        </p>

        <h3 className="mt-6 font-display text-h3 font-semibold tracking-tight">Linux</h3>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`curl -fsSL https://ollama.com/install.sh | sh`}
        </pre>
        <p className="mt-2 text-caption text-muted-foreground">
          NVIDIA GPU 会通过 CUDA 自动检测。AMD 支持有限 —— 见{" "}
          <a
            href="https://github.com/ollama/ollama/blob/main/docs/gpu.md"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Ollama GPU 文档
          </a>
          。
        </p>

        <h3 className="mt-6 font-display text-h3 font-semibold tracking-tight">Windows</h3>
        <p>
          从{" "}
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            ollama.com/download
          </a>
          下载安装程序。在 Windows 10/11 上原生运行；如果你愿意，也可在 WSL 中运行。
        </p>

        <h3 className="mt-6 font-display text-h3 font-semibold tracking-tight">验证它正在运行</h3>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`curl http://localhost:11434/api/version`}
        </pre>
        <p>
          应该会打印类似 <code>{`{"version":"0.x.x"}`}</code> 的内容。如果
          得到<em>连接被拒绝</em>，请在终端运行 <code>ollama serve</code>{" "}
          手动启动服务。
        </p>
      </Section>

      <Section id="pull" eyebrow="第 2 步" title="拉取一个模型">
        <p>
          模型并不随 Ollama 本身一起提供 —— 每个模型你下载一次，
          之后会缓存在本地。在终端中：
        </p>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`# General-purpose, fast, good default
ollama pull llama3

# Smaller + faster, lower quality
ollama pull phi3

# Vision-capable (for PDFs and images)
ollama pull llava

# Full library: https://ollama.com/library`}
        </pre>
        <p>
          下载大小和速度取决于你的网络 —— 在宽带上一个 4-5 GB 的模型预计需要 1-2 分钟。
          模型持久保存在{" "}
          <code className="font-mono">~/.ollama/models/</code>，每个只需
          拉取一次。
        </p>
        <p>
          查看已拉取的模型：<code>ollama list</code>。删除某个模型：
          <code>ollama rm &lt;name&gt;</code>。
        </p>
      </Section>

      <Section id="hardware" eyebrow="如何选择" title="各模型的硬件要求">
        <p>
          决定本地模型是好用还是难受的唯一最大因素，
          就是你的硬件能否舒适地运行它。下面的数字假设使用{" "}
          <strong>4 位量化</strong>版本（Ollama 的默认设置 —— 内存占用是完整精度的一半，
          在大多数使用场景下质量几乎相同）。
        </p>
        <p>
          <strong>速度数字</strong>是在所列硬件上的 token/秒，
          大致量级。实际情况会有 ±50% 的波动。
        </p>

        <div className="overflow-x-auto">
          <table className="my-6 w-full min-w-[700px] border-collapse text-ui">
            <thead>
              <tr className="border-b-2 border-border text-left">
                <th className="py-2 pr-4 font-display font-semibold">模型</th>
                <th className="py-2 pr-4 font-display font-semibold">磁盘</th>
                <th className="py-2 pr-4 font-display font-semibold">内存（最低 / 推荐）</th>
                <th className="py-2 pr-4 font-display font-semibold">M3 Mac</th>
                <th className="py-2 pr-4 font-display font-semibold">仅现代 CPU</th>
                <th className="py-2 font-display font-semibold">最适合</th>
              </tr>
            </thead>
            <tbody className="text-[13px]">
              {HARDWARE_TABLE.map((row) => (
                <tr key={row.model} className="border-b border-border/50">
                  <td className="py-2 pr-4 font-mono">{row.model}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{row.disk}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{row.ram}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{row.mac}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{row.cpu}</td>
                  <td className="py-2 text-muted-foreground">{row.useFor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="mt-6 font-display text-h3 font-semibold tracking-tight">快速选择</h3>
        <ul className="space-y-2">
          <li>
            <strong>大多数现代笔记本（8-16 GB 内存）</strong> → <code>llama3</code> 或 <code>mistral</code>。可靠、均衡。
          </li>
          <li>
            <strong>老旧 / 性能不足的机器（≤8 GB 内存）</strong> → <code>phi3</code>。仍可用，但输出质量下降。
          </li>
          <li>
            <strong>Apple Silicon 16-32 GB</strong> → 通用选 <code>llama3</code>，想要更高质量且不介意更慢时选 <code>phi3:medium</code>。
          </li>
          <li>
            <strong>Apple Silicon 64+ GB 统一内存，或 64+ GB 内存的工作站</strong> → <code>llama3:70b</code> 或 <code>mixtral</code>。接近前沿的质量，完全本地。
          </li>
          <li>
            <strong>需要视觉（PDF、图片）</strong> → 重质量选 <code>llava</code>，重速度选 <code>moondream</code>。
          </li>
        </ul>

        <p className="mt-6">
          <strong>关于内存的经验法则</strong>：模型大致需要与其文件大小相当的内存，
          外加 2-4 GB 给操作系统，再加上上下文窗口的开销。
          运行一个比你空闲内存还大的模型会使用交换分区，速度会下降 10-50 倍，
          通常慢到无法使用。
        </p>
      </Section>

      <Section id="connect" eyebrow="第 3 步" title="把它接到 LLM Wiki 上">
        <p>
          Ollama 正在运行且至少拉取了一个模型之后：
        </p>
        <ol className="ml-5 list-decimal space-y-2">
          <li>
            打开{" "}
            <Link href="/settings" className="text-primary underline underline-offset-2">
              设置 → 模型
            </Link>
          </li>
          <li>
            对任意操作槽位（Ingest / 查询 / 对话 / 体检 / 视觉）：
            把<strong>提供商</strong>下拉框从{" "}
            <em>OpenRouter</em> 改为 <em>Ollama（本地）</em>
          </li>
          <li>
            从下拉框中选择模型 —— 只选你确实用{" "}
            <code>ollama pull &lt;name&gt;</code> 拉取过的模型
          </li>
          <li>
            点击<strong>保存</strong>。该槽位之后的新操作会立即路由到
            Ollama。
          </li>
        </ol>
        <p>
          你可以按槽位混用提供商。常见做法：Ingest用 Ollama
          （慢但免费，适合批量作业），对话用 OpenRouter（交互时又快又
          聪明），视觉用在你场景下视觉模型更好的那一个。
        </p>
        <p>
          <strong>如果你把所有槽位都设为 Ollama</strong>，就完全不需要
          OpenRouter API 密钥了。只要至少有一个槽位是 Ollama，首次运行引导中的密钥步骤
          就变为可选。
        </p>
      </Section>

      <Section id="custom-url" eyebrow="进阶" title="指向非默认的 Ollama URL">
        <p>
          Ollama 默认运行在 <code>http://localhost:11434</code>。如果
          你的实例运行在别处（不同端口、通过隧道运行在另一台机器上、
          在 Docker 网络内），请在启动 LLM Wiki 之前设置 <code>OLLAMA_BASE_URL</code>{" "}
          环境变量：
        </p>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-card p-3 text-[12px]">
{`# Example: Ollama running on a different port
export OLLAMA_BASE_URL=http://localhost:12345
llm-wiki start

# Example: Ollama on another machine on your LAN
export OLLAMA_BASE_URL=http://192.168.1.100:11434
llm-wiki start

# Example: Ollama exposed via a tunnel
export OLLAMA_BASE_URL=https://my-tunnel.example.com
llm-wiki start`}
        </pre>
        <p>
          LLM Wiki 会把你设置的地址后追加 <code>/v1</code>，以匹配
          Ollama 的 OpenAI 兼容 API。你不需要自己加上。
        </p>
      </Section>

      <Section id="troubleshooting" eyebrow="当它不工作时" title="疑难排查">
        <ul className="space-y-3">
          <Trouble
            symptom={<>运行操作时出现&ldquo;Connection error&rdquo;</>}
            fix={<>Ollama 没有在运行。试试 <code>curl http://localhost:11434/api/version</code> —— 如果失败，请在终端运行 <code>ollama serve</code>。</>}
          />
          <Trouble
            symptom={<>Ollama 返回&ldquo;Model not found&rdquo;或 404</>}
            fix={<>你在设置里选的模型还没有拉取。运行 <code>ollama list</code> 查看已有模型；用 <code>ollama pull &lt;name&gt;</code> 添加一个。</>}
          />
          <Trouble
            symptom="响应非常慢（低于 5 token/秒，读起来很难受）"
            fix="你的硬件低于该模型的舒适运行区间。试试更小的模型（用 phi3 而不是 mistral，用 mistral 而不是 mixtral）。或者接受批量操作（Ingest、体检）可以正常跑、只有对话难受这一现实 —— 对话改用 OpenRouter。"
          />
          <Trouble
            symptom="操作过程中内存不足 / 系统疯狂使用交换分区"
            fix="和慢的解决办法一样：选更小的模型。或者关掉其他应用腾出内存。作为一条硬性规则，模型文件大小 + 4 GB 应能舒适地放进你的空闲内存。"
          />
          <Trouble
            symptom="GPU 没有被使用（CPU 满载，GPU 空闲）"
            fix={<>NVIDIA：在查询运行时检查 <code>nvidia-smi</code>。AMD：支持不完整。Apple Silicon：始终使用 GPU，没有开关。见 <a href="https://github.com/ollama/ollama/blob/main/docs/gpu.md" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">Ollama GPU 文档</a>。</>}
          />
          <Trouble
            symptom={<>即使只有部分槽位使用 OpenRouter，仍提示&ldquo;OpenRouter API key not configured&rdquo;</>}
            fix="至少还有一个槽位设为了 OpenRouter，需要密钥。要么把所有槽位都设为 Ollama，要么在 设置 → API 中添加 OpenRouter 密钥。"
          />
        </ul>
      </Section>

      <Section id="more" eyebrow="进一步了解" title="参考资料">
        <ul className="space-y-1">
          <li>
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              ollama.com/library
            </a>{" "}
            —— 可用模型的完整列表，含大小 + 基准测试
          </li>
          <li>
            <a
              href="https://github.com/ollama/ollama"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              github.com/ollama/ollama
            </a>{" "}
            —— 源代码 + 问题追踪
          </li>
          <li>
            <a
              href="https://github.com/ollama/ollama/blob/main/docs/gpu.md"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              GPU 兼容性文档
            </a>{" "}
            —— 什么能在什么上跑
          </li>
          <li>
            <a
              href="https://huggingface.co/spaces/lmsys/chatbot-arena-leaderboard"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              Chatbot Arena 排行榜
            </a>{" "}
            —— 独立的 LLM 质量排名（开源 + 闭源）
          </li>
        </ul>
      </Section>

      <div className="mt-12 flex flex-wrap gap-4">
        <Link
          href="/settings"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          ← 返回设置
        </Link>
        <Link
          href="/help"
          className="rounded-md border border-border bg-card px-4 py-2 text-ui hover:border-primary/40 hover:bg-accent/40"
        >
          阅读帮助指南 →
        </Link>
      </div>
    </PageContainer>
  );
}

// ─── small components (only used on this page) ────────────────────────────

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
    <section id={id} className="mb-16 scroll-mt-20">
      <p className="text-caption uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-2 font-display text-h1 font-semibold tracking-tight">{title}</h2>
      <div className="mt-5 space-y-4 font-serif text-body text-foreground/85">{children}</div>
    </section>
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

// ─── content ──────────────────────────────────────────────────────────────

const TOC: Array<{ id: string; label: string }> = [
  { id: "why", label: "本地与云端 —— 各自适合什么情况" },
  { id: "install", label: "第 1 步：安装 Ollama" },
  { id: "pull", label: "第 2 步：拉取模型" },
  { id: "hardware", label: "各模型的硬件要求" },
  { id: "connect", label: "第 3 步：把它接到 LLM Wiki 上" },
  { id: "custom-url", label: "指向非默认的 Ollama URL" },
  { id: "troubleshooting", label: "疑难排查" },
  { id: "more", label: "参考资料" },
];

// Rough order-of-magnitude numbers. 4-bit quantized variants (Ollama default).
// Tokens/sec estimates from various reports; real-world ±50%.
const HARDWARE_TABLE = [
  {
    model: "phi3",
    disk: "2.3 GB",
    ram: "8 / 8 GB",
    mac: "50+ t/s",
    cpu: "15-25 t/s",
    useFor: "轻量对话、快速Ingest",
  },
  {
    model: "moondream",
    disk: "1.6 GB",
    ram: "4 / 8 GB",
    mac: "80+ t/s",
    cpu: "20-30 t/s",
    useFor: "快速视觉，质量较低",
  },
  {
    model: "llama3",
    disk: "4.7 GB",
    ram: "8 / 16 GB",
    mac: "30-40 t/s",
    cpu: "8-12 t/s",
    useFor: "通用默认选择",
  },
  {
    model: "mistral",
    disk: "4.1 GB",
    ram: "8 / 16 GB",
    mac: "30-40 t/s",
    cpu: "8-15 t/s",
    useFor: "输出简洁，擅长代码",
  },
  {
    model: "gemma2",
    disk: "5.5 GB",
    ram: "16 / 16 GB",
    mac: "25-35 t/s",
    cpu: "5-10 t/s",
    useFor: "推理能力强",
  },
  {
    model: "llava",
    disk: "4.7 GB",
    ram: "8 / 16 GB",
    mac: "25-35 t/s",
    cpu: "5-10 t/s",
    useFor: "视觉（PDF/图片）",
  },
  {
    model: "phi3:medium",
    disk: "7.9 GB",
    ram: "16 / 16 GB",
    mac: "20-30 t/s",
    cpu: "4-8 t/s",
    useFor: "质量更好，速度更慢",
  },
  {
    model: "mixtral",
    disk: "26 GB",
    ram: "32 / 48 GB",
    mac: "15-25 t/s",
    cpu: "无法使用",
    useFor: "最好的中量级开源模型",
  },
  {
    model: "llama3:70b",
    disk: "40 GB",
    ram: "48 / 64 GB",
    mac: "5-15 t/s",
    cpu: "无法使用",
    useFor: "开源中质量最高，需要强劲硬件",
  },
];
