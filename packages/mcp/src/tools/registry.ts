/**
 * The seven read-only tools this MCP server exposes.
 *
 * The list is the single source of truth for three things that must never
 * drift apart: the tool registrations on the server, the per-tool switches in
 * Settings → MCP, and the OAuth scopes issued on the consent screen.
 */
export const MCP_TOOL_IDS = [
  "wiki_search",
  "wiki_read_page",
  "wiki_list_pages",
  "wiki_get_toc",
  "wiki_get_section",
  "wiki_backlinks",
  "wiki_get_graph",
] as const;

export type McpToolId = (typeof MCP_TOOL_IDS)[number];

export type McpToolMeta = {
  id: McpToolId;
  /** Shown in Settings → MCP next to the switch. */
  label: string;
  /** One line, shown as the row's info hint. */
  summary: string;
};

export const MCP_TOOLS: readonly McpToolMeta[] = [
  {
    id: "wiki_search",
    label: "搜索",
    summary: "全文检索：返回匹配页面的路径、标题、摘要与相关性得分。",
  },
  {
    id: "wiki_read_page",
    label: "读取页面",
    summary: "按路径读取整页：Markdown 正文、frontmatter、出站与入站链接。",
  },
  {
    id: "wiki_list_pages",
    label: "列出页面",
    summary: "浏览全部页面，可按分类、标签或类型过滤。",
  },
  {
    id: "wiki_get_toc",
    label: "读取目录",
    summary: "提取 H1–H6 标题层级、锚点、行号范围与内容预览。",
  },
  {
    id: "wiki_get_section",
    label: "读取章节",
    summary: "按标题路径读取单个章节，配合目录使用可显著降低 token 消耗。",
  },
  {
    id: "wiki_backlinks",
    label: "反向链接",
    summary: "查找所有指向指定页面的入站链接。",
  },
  {
    id: "wiki_get_graph",
    label: "知识图谱",
    summary: "返回节点与边，或按条件返回子图。",
  },
] as const;

export function isMcpToolId(value: unknown): value is McpToolId {
  return typeof value === "string" && (MCP_TOOL_IDS as readonly string[]).includes(value);
}

/** OAuth scope that unlocks every tool. */
export const SCOPE_ALL = "wiki:read";

/** Per-tool OAuth scope, e.g. `wiki:backlinks` for `wiki_backlinks`. */
export function toolScope(tool: McpToolId): string {
  return `wiki:${tool.slice("wiki_".length).replace(/_/g, "-")}`;
}

export const ALL_TOOL_SCOPES: readonly string[] = MCP_TOOL_IDS.map(toolScope);

export const SUPPORTED_SCOPES: readonly string[] = [SCOPE_ALL, ...ALL_TOOL_SCOPES];

/** Tools granted by a set of scopes. `wiki:read` implies all of them. */
export function toolsForScopes(scopes: readonly string[]): McpToolId[] {
  if (scopes.includes(SCOPE_ALL)) return [...MCP_TOOL_IDS];
  const granted = new Set(scopes);
  return MCP_TOOL_IDS.filter((id) => granted.has(toolScope(id)));
}
