import Link from "next/link";

import { buildGraph } from "@llm-wiki/core";

import { PageContainer, PageHeader } from "@/components/page-shell";
import { VaultGraph } from "@/components/graph/vault-graph";
import { openWikiContext, requireSetup } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

// Single param so the route is bookmarkable. The client component reads
// initialSelectedId on mount and flies the camera to that node once the
// force layout has settled.
type SearchParams = { node?: string };

export default async function GraphPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  await requireSetup();
  const ctx = await openWikiContext();
  let data;
  try {
    data = await buildGraph(ctx.wikiPath, ctx.db);
  } finally {
    ctx.db.close();
  }

  if (data.nodes.length === 0) {
    return (
      <PageContainer width="lg">
        <PageHeader
          eyebrow="知识图谱"
          title="图谱"
          description="你的知识库的 3D 视图——页面为节点，[[wikilinks]] 为边。拖动可旋转，滚动可缩放，点击节点可聚焦。"
        />
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <p className="font-display text-h3 font-semibold">
            暂无可绘制的节点
          </p>
          <p className="mx-auto mt-2 max-w-md text-ui text-muted-foreground">
            在{" "}
            <Link
              href="/sources"
              className="text-primary underline underline-offset-2"
            >
              Source
            </Link>{" "}
            页面添加一个Source。智能体会在此创建页面，随着你持续摄取，图谱会不断生长。
          </p>
        </div>
      </PageContainer>
    );
  }

  return <VaultGraph data={data} initialSelectedId={searchParams?.node} />;
}
