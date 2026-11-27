// Tools the built-in chat agent can call.
//
// Deliberately separate from the MCP server: MCP tools are a network contract
// for external clients, while these run in-process against the same wiki. The
// names and shapes are close enough that a model moving between the two does
// not have to relearn them.

import { z } from "zod";

import type { LlmToolDefinition } from "@llm-wiki/llm";

import type { Db } from "./db";
import { listPageRows } from "./db-pages";
import { extractWikiLinks, findBacklinks } from "./links";
import { listRawSources, readRawSource } from "./raw";
import { searchRawSources } from "./raw-search";
import { searchPagesUnified } from "./search-meili";
import { readPage } from "./wiki";

export type AgentToolContext = {
  wikiPath: string;
  db: Db;
};

export type AgentToolResult = {
  ok: boolean;
  /** Human-facing one-liner shown on the chat tool card. */
  summary: string;
  /** JSON text sent back to the model as the tool message. */
  content: string;
};

export const AGENT_TOOLS: readonly LlmToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki_search",
      description:
        "Search wiki pages by full text. Use this first to find relevant compiled pages. Returns slug, title and a snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Max results. Default 8.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_read_page",
      description:
        "Read one compiled wiki page by slug. Returns frontmatter, body, outbound wikilinks and inbound backlinks.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Page slug, e.g. shors-algorithm." },
          max_chars: {
            type: "integer",
            minimum: 500,
            maximum: 200000,
            description: "Max body characters. Default 24000.",
          },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_list_pages",
      description: "List wiki page slugs and titles, optionally filtered by type or tag.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["entity", "concept", "source", "comparison", "overview"],
          },
          tag: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_backlinks",
      description: "Find pages that link to a page, plus the page's outbound links.",
      parameters: {
        type: "object",
        properties: { slug: { type: "string", description: "Target page slug." } },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "raw_search",
      description:
        "Search the raw/ source layer by keywords. Use this when the answer needs the original source rather than a compiled page.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "raw_list",
      description: "List raw/ source files with id, filename, format, title and ingestion status.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "raw_read",
      description:
        "Read a raw/ source by id, filename, raw/ path or original upload name. Text files return the original; PDF/DOCX/images return the extracted text layer.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source id, filename, raw/ path or original name.",
          },
          mode: {
            type: "string",
            enum: ["auto", "original", "extracted"],
            description: "Default auto.",
          },
          max_chars: {
            type: "integer",
            minimum: 500,
            maximum: 200000,
            description: "Default 50000.",
          },
        },
        required: ["source"],
      },
    },
  },
];

const SearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

const Slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, "slug must be kebab-case (lowercase, digits, hyphens)");

const ReadPageArgs = z.object({
  slug: Slug,
  max_chars: z.number().int().min(500).max(200_000).optional(),
});

const ListPagesArgs = z.object({
  type: z.enum(["entity", "concept", "source", "comparison", "overview"]).optional(),
  tag: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const BacklinksArgs = z.object({ slug: Slug });

const RawSearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

const RawListArgs = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

const RawReadArgs = z.object({
  source: z.string().min(1),
  mode: z.enum(["auto", "original", "extracted"]).optional(),
  max_chars: z.number().int().min(500).max(200_000).optional(),
});

export async function executeAgentTool(
  name: string,
  rawArguments: string,
  ctx: AgentToolContext,
): Promise<AgentToolResult> {
  let args: unknown;
  try {
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch (err) {
    return errorResult(`参数不是合法 JSON：${(err as Error).message}`);
  }

  try {
    switch (name) {
      case "wiki_search": {
        const parsed = SearchArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const hits = await searchPagesUnified(
          ctx.wikiPath,
          ctx.db,
          parsed.data.query,
          parsed.data.limit ?? 8,
        );
        return okResult(`搜索「${parsed.data.query}」：${hits.length} 个页面`, {
          query: parsed.data.query,
          count: hits.length,
          results: hits,
        });
      }
      case "wiki_read_page": {
        const parsed = ReadPageArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const page = await readPage(ctx.wikiPath, parsed.data.slug);
        const limit = parsed.data.max_chars ?? 24000;
        const truncated = page.content.length > limit;
        const body = truncated ? page.content.slice(0, limit) : page.content;
        const outbound = extractWikiLinks(page.content).map((link) => ({
          slug: link.slug,
          display: link.display,
        }));
        const inbound = await findBacklinks(ctx.db, ctx.wikiPath, page.slug);
        return okResult(`读取页面 [[${page.slug}]]`, {
          slug: page.slug,
          title: page.frontmatter.title,
          type: page.frontmatter.type,
          tags: page.frontmatter.tags ?? [],
          content: body,
          truncated,
          totalChars: page.content.length,
          outbound,
          inbound: inbound.map((b) => ({ slug: b.slug, title: b.title, excerpt: b.excerpt })),
        });
      }
      case "wiki_list_pages": {
        const parsed = ListPagesArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const rows = listPageRows(ctx.db)
          .filter((row) => (parsed.data.type ? row.type === parsed.data.type : true))
          .filter((row) =>
            parsed.data.tag
              ? row.tags.map((tag) => tag.toLowerCase()).includes(parsed.data.tag.toLowerCase())
              : true,
          )
          .slice(0, parsed.data.limit ?? 100)
          .map((row) => ({ slug: row.slug, title: row.title, type: row.type, tags: row.tags }));
        return okResult(`列出 ${rows.length} 个页面`, { count: rows.length, pages: rows });
      }
      case "wiki_backlinks": {
        const parsed = BacklinksArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const page = await readPage(ctx.wikiPath, parsed.data.slug);
        const inbound = await findBacklinks(ctx.db, ctx.wikiPath, page.slug);
        const outbound = extractWikiLinks(page.content).map((link) => ({
          slug: link.slug,
          display: link.display,
        }));
        return okResult(`[[${page.slug}]]：入站 ${inbound.length}，出站 ${outbound.length}`, {
          slug: page.slug,
          inbound: inbound.map((b) => ({ slug: b.slug, title: b.title, excerpt: b.excerpt })),
          outbound,
        });
      }
      case "raw_search": {
        const parsed = RawSearchArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const hits = await searchRawSources(ctx.wikiPath, ctx.db, parsed.data.query, {
          limit: parsed.data.limit ?? 5,
        });
        return okResult(`搜索 raw/「${parsed.data.query}」：${hits.length} 个片段`, {
          query: parsed.data.query,
          count: hits.length,
          results: hits,
        });
      }
      case "raw_list": {
        const parsed = RawListArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const sources = await listRawSources(ctx.wikiPath, ctx.db);
        const page = sources.slice(0, parsed.data.limit ?? 100);
        return okResult(`列出 ${page.length}/${sources.length} 个原始文件`, {
          total: sources.length,
          count: page.length,
          sources: page,
        });
      }
      case "raw_read": {
        const parsed = RawReadArgs.safeParse(args);
        if (!parsed.success) return invalidArgs(name, parsed.error.message);
        const result = await readRawSource(ctx.wikiPath, ctx.db, parsed.data.source, {
          mode: parsed.data.mode,
          maxChars: parsed.data.max_chars,
        });
        return okResult(
          `读取原始文件 ${result.source.filename}（${result.mode === "extracted" ? "文本层" : "原文"}${result.truncated ? "，已截断" : ""}）`,
          result,
        );
      }
      default:
        return errorResult(`未知工具：${name}`);
    }
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

export function agentToolNames(): string[] {
  return AGENT_TOOLS.map((tool) => tool.function.name);
}

function okResult(summary: string, data: unknown): AgentToolResult {
  return { ok: true, summary, content: JSON.stringify(data) };
}

function errorResult(message: string): AgentToolResult {
  return { ok: false, summary: message, content: JSON.stringify({ error: message }) };
}

function invalidArgs(name: string, message: string): AgentToolResult {
  return errorResult(`工具 ${name} 参数不合法：${message}`);
}
