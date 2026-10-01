// Tool registrations.
//
// Every tool answers in structured content (JSON) *and* a short human summary
// in a text block. The JSON is what a model consumes; the text is what a human
// sees when they inspect a call in a client's transcript, which is the only
// debugging surface most MCP clients give the user.

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/server";

import { pageFileExists, type WikiConnection, type WikiRegistry } from "../wiki/registry";
import { childHeadings, extractHeadings, findHeading, sliceLines } from "../wiki/outline";
import {
  PAGE_TYPES,
  backlinkReport,
  buildOverview,
  listPageRefs,
  normalizePagePath,
  pagePath,
  queryGraph,
  readPageDetail,
  suggestTerms,
} from "./pages";
import { fallbackSearch, search, snippetFromBody } from "./search";
import type { McpToolId } from "./registry";

export type ToolContext = {
  registry: WikiRegistry;
  /** Tool ids this credential may call. */
  allowedTools: readonly McpToolId[];
  /** Principal label, used in the audit line appended to log.md. */
  principalLabel: string;
  /**
   * Wiki path prefix from the request URL, e.g. `research/quantum`. Empty for a
   * single-wiki install. Consulted before the `wiki` argument so a client that
   * was pointed at a specific wiki reads that one.
   */
  basePath?: string;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const WIKI_ARG = z
  .string()
  .optional()
  .describe(
    "知识库名称或路径。只在开放了多个知识库、且请求地址未指明时使用；省略时读取当前活动或地址对应的知识库。",
  );

const MAX_RESULTS_CAP = 50;
const MAX_DEPTH_CAP = 4;
const MAX_NODES_CAP = 500;

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const enabled = (id: McpToolId): boolean => ctx.allowedTools.includes(id);

  const withWiki = async (
    wikiArg: string | undefined,
    fn: (conn: WikiConnection) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const ref = ctx.registry.resolve(wikiArg, ctx.basePath ?? null);
    if ("error" in ref) return errorResult(ref.error);
    try {
      const conn = await ctx.registry.open(ref);
      return await fn(conn);
    } catch (err) {
      return errorResult(`读取知识库失败：${(err as Error).message}`);
    }
  };

  if (enabled("wiki_search")) {
    server.registerTool(
      "wiki_search",
      {
        title: "搜索知识库",
        description:
          "在知识库中做全文检索，返回匹配页面的路径、标题、摘要片段与相关性得分（0–1，越高越相关）。" +
          "先用它定位页面，再用 wiki_read_page 或 wiki_get_section 读取内容。",
        inputSchema: z.object({
          query: z.string().describe("查询词。多个词默认按 AND 组合。"),
          max_results: z
            .number()
            .int()
            .min(1)
            .max(MAX_RESULTS_CAP)
            .optional()
            .describe(`返回条数，默认 10，上限 ${MAX_RESULTS_CAP}。`),
          snippet_length: z
            .number()
            .int()
            .min(40)
            .max(2000)
            .optional()
            .describe("每个摘要片段的最大字符数，默认 240。"),
          type: z.enum(PAGE_TYPES).optional().describe("只返回该类型的页面。"),
          tags: z.array(z.string()).optional().describe("只返回同时带有这些标签的页面。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const options = {
            query: args.query,
            maxResults: args.max_results ?? 10,
            snippetLength: args.snippet_length ?? 240,
            type: args.type ?? null,
            tags: args.tags ?? [],
          };
          const { hits, mode } = search(conn.db, options);

          if (hits.length === 0) {
            // Metadata-only fallback: keeps the tool useful while a page edited
            // outside the app has not been re-indexed yet.
            const fallback = fallbackSearch(conn.db, options);
            for (const hit of fallback) {
              const slug = normalizePagePath(hit.path);
              if (!slug) continue;
              const { loadPageBody } = await import("../wiki/registry");
              const body = await loadPageBody(conn.ref.path, slug);
              hit.snippet = body ? snippetFromBody(body, options.snippetLength) : "";
            }
            if (fallback.length > 0) {
              return jsonResult(
                {
                  query: args.query,
                  strategy: "metadata-fallback",
                  wiki: conn.ref.name,
                  count: fallback.length,
                  results: fallback,
                },
                `索引未命中「${args.query}」，已按标题/标签匹配到 ${fallback.length} 个页面。`,
              );
            }
            return jsonResult(
              { query: args.query, strategy: mode, wiki: conn.ref.name, count: 0, results: [] },
              `没有匹配「${args.query}」的页面。`,
            );
          }

          return jsonResult(
            {
              query: args.query,
              strategy: mode,
              wiki: conn.ref.name,
              count: hits.length,
              results: hits,
            },
            `命中 ${hits.length} 个页面：${hits.map((h) => h.title).join("、")}`,
          );
        }),
    );
  }

  if (enabled("wiki_read_page")) {
    server.registerTool(
      "wiki_read_page",
      {
        title: "读取页面",
        description:
          "按路径读取一个页面的完整内容：Markdown 正文、frontmatter 元数据、出站与入站 Wikilink。" +
          "正文超过约 24k 字符时会退回「开头摘要 + 章节大纲」，此时改用 wiki_get_section 取具体小节。",
        inputSchema: z.object({
          path: z.string().describe("页面路径，如 wiki/shors-algorithm.md，也可直接给 slug。"),
          max_chars: z
            .number()
            .int()
            .min(500)
            .max(200000)
            .optional()
            .describe("正文最大字符数，默认 24000。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const slug = normalizePagePath(args.path);
          if (!slug) return errorResult(`页面路径不合法：${args.path}`);
          const detail = await readPageDetail(conn, slug, { maxChars: args.max_chars });
          if (!detail) return errorResult(`页面不存在：${args.path}`);
          return jsonResult(
            detail as unknown as Record<string, unknown>,
            `# ${detail.page.title}（${detail.page.type}，${detail.page.wordCount} 词，出站 ${detail.outbound.length} / 入站 ${detail.inbound.length}）`,
          );
        }),
    );
  }

  if (enabled("wiki_list_pages")) {
    server.registerTool(
      "wiki_list_pages",
      {
        title: "列出页面",
        description:
          "列出知识库中的页面，可按类型、标签过滤。用于「浏览」而非「定位」——" +
          "没有明确查询目标时先用它了解知识库全貌，再决定读哪些页面。",
        inputSchema: z.object({
          type: z.enum(PAGE_TYPES).optional().describe("按页面类型过滤。"),
          tags: z.array(z.string()).optional().describe("只返回同时带有这些标签的页面。"),
          limit: z.number().int().min(1).max(2000).optional().describe("返回条数上限，默认 200。"),
          offset: z.number().int().min(0).optional().describe("分页偏移，默认 0。"),
          overview: z
            .boolean()
            .optional()
            .describe("同时返回知识库概况（页面总数、类型分布、标签、index.md 与 CLAUDE.md）。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const all = listPageRefs(conn.db, { type: args.type ?? null, tags: args.tags ?? [] });
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 200;
          const page = all.slice(offset, offset + limit);
          const overview = args.overview ? await buildOverview(conn) : undefined;
          return jsonResult(
            {
              wiki: conn.ref.name,
              total: all.length,
              offset,
              limit,
              count: page.length,
              pages: page.map((p) => ({
                path: pagePath(p.slug),
                title: p.title,
                type: p.type,
                updated: p.updated,
              })),
              ...(overview ? { overview } : {}),
            },
            `${conn.ref.name}：共 ${all.length} 页，返回 ${page.length} 页。`,
          );
        }),
    );
  }

  if (enabled("wiki_get_toc")) {
    server.registerTool(
      "wiki_get_toc",
      {
        title: "读取页面目录",
        description:
          "返回页面的标题层级（H1–H6）、锚点、行号范围与各节内容预览。" +
          "长页面先看目录再用 wiki_get_section 精确取节，可以显著减少 token 消耗。",
        inputSchema: z.object({
          path: z.string().describe("页面路径或 slug。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const slug = normalizePagePath(args.path);
          if (!slug) return errorResult(`页面路径不合法：${args.path}`);
          if (!pageFileExists(conn.ref.path, slug)) return errorResult(`页面不存在：${args.path}`);

          const { loadPageBody } = await import("../wiki/registry");
          const body = (await loadPageBody(conn.ref.path, slug)) ?? "";
          const headings = extractHeadings(body);
          const detail = await readPageDetail(conn, slug);
          return jsonResult(
            {
              path: pagePath(slug),
              title: detail?.page.title ?? slug,
              lineCount: body.split(/\r?\n/).length,
              charCount: body.length,
              headings: headings.map((h) => ({
                level: h.level,
                title: h.title,
                id: h.id,
                path: h.path,
                startLine: h.startLine,
                endLine: h.endLine,
                preview: h.preview,
              })),
            },
            `${detail?.page.title ?? slug}：${headings.length} 个标题。`,
          );
        }),
    );
  }

  if (enabled("wiki_get_section")) {
    server.registerTool(
      "wiki_get_section",
      {
        title: "读取章节",
        description:
          "按标题路径读取页面中某个章节的内容（配合 wiki_get_toc 使用）。" +
          "返回正文、行号范围与直接子章节列表；子章节正文按需再取，避免整页读取。",
        inputSchema: z.object({
          path: z.string().describe("页面路径或 slug。"),
          heading: z
            .string()
            .describe("标题路径（如 `显著性 > 对 RSA 的影响`）、标题原文或锚点 id。"),
          include_subsections: z
            .boolean()
            .optional()
            .describe("是否连同子章节正文一起返回，默认 false。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const slug = normalizePagePath(args.path);
          if (!slug) return errorResult(`页面路径不合法：${args.path}`);

          const { loadPageBody } = await import("../wiki/registry");
          const body = await loadPageBody(conn.ref.path, slug);
          if (body === null) return errorResult(`页面不存在：${args.path}`);

          const headings = extractHeadings(body);
          const heading = findHeading(headings, args.heading);
          if (!heading) {
            return errorResult(
              `未找到章节「${args.heading}」。可用章节：` + headings.map((h) => h.path).join(" | "),
            );
          }

          const endLine = args.include_subsections ? heading.endLine : heading.ownEndLine;
          const content = sliceLines(body, heading.startLine, endLine);
          const children = childHeadings(headings, heading);
          return jsonResult(
            {
              path: pagePath(slug),
              heading: {
                title: heading.title,
                level: heading.level,
                id: heading.id,
                path: heading.path,
              },
              startLine: heading.startLine,
              endLine,
              content,
              subsections: children.map((c) => ({
                title: c.title,
                level: c.level,
                path: c.path,
                startLine: c.startLine,
                endLine: c.endLine,
                preview: c.preview,
              })),
            },
            `${heading.path}（第 ${heading.startLine}–${endLine} 行，${children.length} 个子章节）`,
          );
        }),
    );
  }

  if (enabled("wiki_backlinks")) {
    server.registerTool(
      "wiki_backlinks",
      {
        title: "查找反向链接",
        description:
          "查找所有指向指定页面的入站链接，并返回该页面的出站链接。" +
          "用于理解知识图谱中的关系、发现相关上下文。",
        inputSchema: z.object({
          path: z.string().describe("目标页面路径或 slug。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const slug = normalizePagePath(args.path);
          if (!slug) return errorResult(`页面路径不合法：${args.path}`);
          const report = await backlinkReport(conn, slug);
          if (!report) return errorResult(`页面不存在：${args.path}`);
          return jsonResult(
            { wiki: conn.ref.name, ...report },
            `${slug}：入站 ${report.inbound.length}，出站 ${report.outbound.length}。`,
          );
        }),
    );
  }

  if (enabled("wiki_get_graph")) {
    server.registerTool(
      "wiki_get_graph",
      {
        title: "读取知识图谱",
        description:
          "返回知识图谱的节点与边；给出 roots（起始页面）时返回限定跳数的子图，用于多跳推理与关系探索。" +
          "只统计正文中的 [[wikilink]]，frontmatter 的 sources 不计入边。",
        inputSchema: z.object({
          roots: z
            .array(z.string())
            .optional()
            .describe("起始页面（路径或 slug）。省略时返回整张图。"),
          depth: z
            .number()
            .int()
            .min(0)
            .max(MAX_DEPTH_CAP)
            .optional()
            .describe(`从 roots 出发的最大跳数，默认 1，上限 ${MAX_DEPTH_CAP}。`),
          types: z.array(z.enum(PAGE_TYPES)).optional().describe("只保留这些类型的节点。"),
          tags: z.array(z.string()).optional().describe("只保留同时带有这些标签的节点。"),
          max_nodes: z
            .number()
            .int()
            .min(1)
            .max(MAX_NODES_CAP)
            .optional()
            .describe(`节点数上限，默认 120，上限 ${MAX_NODES_CAP}。`),
          include_broken_links: z
            .boolean()
            .optional()
            .describe("是否列出指向不存在页面的链接目标（知识缺口）。"),
          wiki: WIKI_ARG,
        }),
      },
      async (args) =>
        withWiki(args.wiki, async (conn) => {
          const result = await queryGraph(conn, {
            roots: args.roots,
            depth: args.depth ?? 1,
            types: args.types,
            tags: args.tags,
            maxNodes: args.max_nodes ?? 120,
            includeBrokenLinks: args.include_broken_links ?? false,
          });
          return jsonResult(
            { wiki: conn.ref.name, ...result },
            `${result.nodes.length} 个节点、${result.edges.length} 条边。`,
          );
        }),
    );
  }
}

/** Suggestions appended to an empty search, when the index can offer any. */
export function suggestionsFor(
  ctx: ToolContext,
  db: WikiConnection["db"],
  query: string,
): string[] {
  void ctx;
  return suggestTerms(db, query);
}

function jsonResult(payload: Record<string, unknown>, summary: string): ToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: payload,
  };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
