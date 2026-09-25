"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export function AboutTab() {
  const router = useRouter();
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  async function replayTour() {
    if (!confirm("要重新播放首次使用的欢迎向导吗？你的主题和 API 密钥会保持不变。")) return;
    setReplayBusy(true);
    setReplayError(null);
    try {
      const res = await fetch("/api/onboarding", { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // /, triggers the wizard since onboardingCompletedAt is now absent.
      router.push("/");
      router.refresh();
    } catch (err) {
      setReplayError((err as Error).message);
      setReplayBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 className="text-lg font-medium">LLM Wiki</h2>
        <p className="mt-1 text-muted-foreground">
          由大语言模型智能体维护的本地优先知识库。作者{" "}
          <a
            href="https://github.com/ddsyasas"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Yasas
          </a>
          。
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          模式
        </h3>
        <p className="mt-1 text-muted-foreground">
          实现了{" "}
          <a
            href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Andrej Karpathy 的 LLM Wiki 模式
          </a>{" "}
          ——三个层次（原始Source、wiki、schema）、三项操作（Ingest、查询、体检），
          全部存放在一个装满 markdown 文件的文件夹里。wiki 是持续积累的长期成果，
          而不是查询时才做的检索。
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          隐私
        </h3>
        <p className="mt-1 text-muted-foreground">
          一切都运行在你的机器上。没有遥测、没有统计分析、没有远程存储。
          API 调用只发往 OpenRouter。你的 wiki 内容只存在于你选择的文件夹中——
          想用 git／Dropbox／iCloud 同步就同步，不想同步也无妨。
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          许可
        </h3>
        <p className="mt-1 text-muted-foreground">
          MIT。源代码位于{" "}
          <a
            href="https://github.com/ddsyasas/llm-wiki"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            github.com/ddsyasas/llm-wiki
          </a>
          。
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          致谢
        </h3>
        <p className="mt-1 text-muted-foreground">
          基于 Next.js、Tailwind、shadcn/ui、better-sqlite3、mammoth、gray-matter、
          chokidar，以及指向 OpenRouter 的 openai SDK 构建。
        </p>
      </div>

      <div className="border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          首次使用引导
        </h3>
        <p className="mt-1 text-muted-foreground">
          4 步欢迎向导（简介 + 主题 + 密钥 + 功能导览）只会在首次打开应用时出现。
          你可以随时重新播放：
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={replayTour}
          disabled={replayBusy}
          className="mt-2"
        >
          {replayBusy ? "重置中…" : "重新播放欢迎向导"}
        </Button>
        {replayError ? (
          <p className="mt-2 text-xs text-destructive">{replayError}</p>
        ) : null}
      </div>
    </div>
  );
}
