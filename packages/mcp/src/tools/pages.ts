// Reads shared by more than one tool: page listing, full page reads and the
// graph. Kept out of the tool modules so the wire schemas stay declarative.

import { basename } from "node:path";

import {
  buildExcerpt,
  buildGraph,
  extractWikiLinks,
  findBacklinks,
  getPage,
  listPageRows,
  readIndex,
  readSchema,
  searchPages,
  type Db,
  type PageRow,
} from "@llm-wiki/core";

import { loadPageBody, pageFileExists, type WikiConnection } from "../wiki/registry";
import { extractHeadings, type Heading } from "../wiki/outline";

export const PAGE_TYPES = ["entity", "concept", "source", "comparison", "overview"] as const;

export type PageRef = { slug: string; title: string; type: string; updated: string };

/** `wiki/foo.md` → `foo`. Accepts a bare slug too, which models often send. */
export function normalizePagePath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return null;
  const withoutDir = trimmed.startsWith("wiki/") ? trimmed.slice("wiki/".length) : trimmed;
  const slug = withoutDir.endsWith(".md") ? withoutDir.slice(0, -3) : withoutDir;
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

export function pagePath(slug: string): string {
  return `wiki/${slug}.md`;
}

export function listPageRefs(
  db: Db,
  filters: { type?: string | null; tags?: string[] },
): PageRef[] {
  const wanted = (filters.tags ?? []).map((t) => t.toLowerCase());
  return listPageRows(db)
    .filter((row) => (filters.type ? row.type === filters.type : true))
    .filter((row) =>
      wanted.length === 0
        ? true
        : wanted.every((t) => row.tags.map((x) => x.toLowerCase()).includes(t)),
    )
    .map((row) => ({ slug: row.slug, title: row.title, type: row.type, updated: row.updated_at }));
}

export type PageDetail = {
  page: {
    path: string;
    slug: string;
    title: string;
    type: string;
    tags: string[];
    created: string;
    updated: string;
    wordCount: number;
    frontmatter: Record<string, unknown>;
  };
  body: string;
  headings: Array<Pick<Heading, "level" | "title" | "id" | "path" | "startLine" | "endLine">>;
  outbound: Array<{ slug: string; display: string; exists: boolean }>;
  inbound: Array<{ slug: string; title: string; excerpt: string }>;
  sources: string[];
  truncated: boolean;
};

/** Character budget before `wiki_read_page` switches to excerpt mode. */
export const READ_BODY_LIMIT = 24000;

export async function readPageDetail(
  conn: WikiConnection,
  slug: string,
  options: { maxChars?: number } = {},
): Promise<PageDetail | null> {
  const rows = listPageRows(conn.db);
  const row = rows.find((r) => r.slug === slug) ?? getPage(conn.db, slug);
  const existsOnDisk = pageFileExists(conn.ref.path, slug);
  if (!row && !existsOnDisk) return null;

  const body = (await loadPageBody(conn.ref.path, slug)) ?? "";
  const knownSlugs = new Set(rows.map((r) => r.slug));
  const outbound = dedupeLinks(
    extractWikiLinks(body).map((link) => ({
      slug: link.slug,
      display: link.display,
      exists: knownSlugs.has(link.slug),
    })),
  );
  const inbound = await findBacklinks(conn.db, conn.ref.path, slug);

  const title = row?.title ?? basename(slug);
  const type = row?.type ?? "concept";
  const limit = options.maxChars ?? READ_BODY_LIMIT;
  const bodyOut = body.length <= limit ? body : excerptForModel(body, limit);

  return {
    page: {
      path: pagePath(slug),
      slug,
      title,
      type,
      tags: row?.tags ?? [],
      created: row?.created_at ?? "",
      updated: row?.updated_at ?? "",
      wordCount: row?.word_count ?? body.split(/\s+/).filter(Boolean).length,
      frontmatter: {
        title,
        slug,
        type,
        created: row?.created_at ?? "",
        updated: row?.updated_at ?? "",
        tags: row?.tags ?? [],
      },
    },
    body: bodyOut,
    headings: extractHeadings(body).map((h) => ({
      level: h.level,
      title: h.title,
      id: h.id,
      path: h.path,
      startLine: h.startLine,
      endLine: h.endLine,
    })),
    outbound,
    inbound: inbound.map((b) => ({ slug: b.slug, title: b.title, excerpt: b.excerpt })),
    sources: listSources(conn.db, slug),
    truncated: bodyOut.length < body.length,
  };
}

/**
 * Long body: keep the opening prose (which is what a model usually needs) and
 * replace the rest with the table of contents, so the model can pull the exact
 * section with `wiki_get_section` instead of paying for the whole page.
 */
function excerptForModel(body: string, limit: number): string {
  const excerpt = buildExcerpt(body, { limit });
  const toc = extractHeadings(body)
    .map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.title} (${h.path})`)
    .join("\n");
  return [
    excerpt.text,
    "",
    `[正文过长，已截断；完整页面共 ${body.length} 字符。章节大纲：]`,
    toc,
    "",
    "[用 wiki_get_section 按标题路径读取需要的小节。]",
  ].join("\n");
}

function dedupeLinks(
  links: Array<{ slug: string; display: string; exists: boolean }>,
): Array<{ slug: string; display: string; exists: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ slug: string; display: string; exists: boolean }> = [];
  for (const link of links) {
    if (seen.has(link.slug)) continue;
    seen.add(link.slug);
    out.push(link);
  }
  return out;
}

function listSources(db: Db, slug: string): string[] {
  try {
    const rows = db
      .prepare(`SELECT source_id FROM page_sources WHERE page_slug = ? ORDER BY source_id`)
      .all(slug) as Array<{ source_id: string }>;
    return rows.map((r) => r.source_id);
  } catch {
    return [];
  }
}

/** A short, model-friendly summary of the wiki itself. */
export async function buildOverview(conn: WikiConnection): Promise<{
  wiki: string;
  path: string;
  topic: string | null;
  pageCount: number;
  byType: Record<string, number>;
  tags: string[];
  index: string | null;
  schema: string | null;
}> {
  const rows = listPageRows(conn.db);
  const byType: Record<string, number> = {};
  const tags = new Set<string>();
  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    for (const tag of row.tags) tags.add(tag);
  }

  const [index, schema] = await Promise.all([
    readIndex(conn.ref.path).catch(() => null),
    readSchema(conn.ref.path).catch(() => null),
  ]);

  return {
    wiki: basename(conn.ref.path),
    path: conn.ref.path,
    topic: conn.topic,
    pageCount: rows.length,
    byType,
    tags: [...tags].sort(),
    index,
    schema,
  };
}

export type GraphQuery = {
  roots?: string[];
  depth: number;
  types?: string[];
  tags?: string[];
  maxNodes: number;
  includeBrokenLinks: boolean;
};

export type GraphResult = {
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    tags: string[];
    degree: number;
    preview?: string;
  }>;
  edges: Array<{ source: string; target: string }>;
  /** Slugs referenced by an edge but not present as pages. */
  brokenTargets: string[];
  truncatedNodes: boolean;
  truncatedEdges: boolean;
};

export async function queryGraph(conn: WikiConnection, query: GraphQuery): Promise<GraphResult> {
  const full = await buildGraph(conn.ref.path, conn.db);
  const nodeIds = new Set(full.nodes.map((n) => n.id));

  // Neighbour map in both directions: "explore around this page" should not
  // depend on which way the author happened to write the link.
  const neighbours = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const set = neighbours.get(from);
    if (set) set.add(to);
    else neighbours.set(from, new Set([to]));
  };
  for (const edge of full.links) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  let selected = new Set(nodeIds);
  const roots = (query.roots ?? [])
    .map((r) => normalizePagePath(r) ?? r.trim())
    .filter((r) => r.length > 0);
  if (roots.length > 0) {
    selected = new Set<string>();
    const queue = roots.map((id) => ({ id, level: 0 }));
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      if (selected.has(current.id)) continue;
      if (!nodeIds.has(current.id)) continue;
      selected.add(current.id);
      if (current.level >= query.depth) continue;
      for (const next of neighbours.get(current.id) ?? []) {
        if (!selected.has(next)) queue.push({ id: next, level: current.level + 1 });
      }
    }
  }

  const typeFilter = new Set(query.types ?? []);
  const tagFilter = (query.tags ?? []).map((t) => t.toLowerCase());

  const nodes = full.nodes.filter((node) => {
    if (!selected.has(node.id)) return false;
    if (typeFilter.size > 0 && !typeFilter.has(node.group)) return false;
    if (
      tagFilter.length > 0 &&
      !tagFilter.every((t) => node.tags.map((x) => x.toLowerCase()).includes(t))
    ) {
      return false;
    }
    return true;
  });

  const visible = new Set(nodes.map((n) => n.id));
  const edges = full.links.filter((l) => visible.has(l.source) && visible.has(l.target));

  const brokenTargets = new Set<string>();
  for (const link of full.links) {
    if (!nodeIds.has(link.target)) brokenTargets.add(link.target);
  }

  const nodeLimit = Math.max(1, query.maxNodes);
  const edgeLimit = nodeLimit * 4;
  const nodesOut = nodes.slice(0, nodeLimit);
  // Previews are only attached while they are not the dominant cost of the
  // response; a 200-node graph would otherwise be mostly preview text.
  const withPreview = nodesOut.length <= 60;

  return {
    nodes: nodesOut.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.group,
      tags: n.tags,
      degree: n.degree,
      ...(withPreview ? { preview: n.preview } : {}),
    })),
    edges: edges.slice(0, edgeLimit),
    brokenTargets: query.includeBrokenLinks ? [...brokenTargets].sort() : [],
    truncatedNodes: nodes.length > nodesOut.length,
    truncatedEdges: edges.length > edgeLimit,
  };
}

/** Backlinks plus the outgoing side of the same relationship. */
export async function backlinkReport(
  conn: WikiConnection,
  slug: string,
): Promise<{
  slug: string;
  inbound: Array<{ path: string; title: string; excerpt: string }>;
  outbound: Array<{ path: string; title: string; exists: boolean }>;
} | null> {
  const rows = listPageRows(conn.db);
  const row = rows.find((r) => r.slug === slug);
  if (!row && !pageFileExists(conn.ref.path, slug)) return null;

  const body = (await loadPageBody(conn.ref.path, slug)) ?? "";
  const titles = new Map(rows.map((r) => [r.slug, r.title]));
  const inbound = await findBacklinks(conn.db, conn.ref.path, slug);

  return {
    slug,
    inbound: inbound.map((b) => ({ path: pagePath(b.slug), title: b.title, excerpt: b.excerpt })),
    outbound: dedupeLinks(
      extractWikiLinks(body).map((link) => ({
        slug: link.slug,
        display: link.display,
        exists: titles.has(link.slug),
      })),
    ).map((link) => ({
      path: pagePath(link.slug),
      title: titles.get(link.slug) ?? link.display,
      exists: link.exists,
    })),
  };
}

/** Slugs that share vocabulary with a query that returned nothing. */
export function suggestTerms(db: Db, query: string, limit = 8): string[] {
  const first = query.trim().split(/\s+/)[0];
  if (!first || first.length < 3) return [];
  try {
    return searchPages(db, first, limit).map((h) => h.slug);
  } catch {
    return [];
  }
}

/** Rows for a page, used by the section reader to confirm existence. */
export function findPageRow(db: Db, slug: string): PageRow | null {
  return getPage(db, slug);
}

/** Outline for a page, without reading it twice. */
export function outlineFor(body: string): Heading[] {
  return extractHeadings(body);
}
