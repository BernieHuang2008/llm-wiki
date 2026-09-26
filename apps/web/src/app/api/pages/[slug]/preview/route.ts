import { NextResponse } from "next/server";

import { buildExcerpt, readPage, type PageType } from "@llm-wiki/core";

import { openWikiContext } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

type RouteParams = { params: { slug: string } };

export type PagePreview = {
  slug: string;
  title: string;
  type: PageType;
  tags: string[];
  updated: string;
  excerpt: string;
  truncated: boolean;
};

/**
 * GET /api/pages/[slug]/preview — the payload for a hover preview card.
 *
 * Deliberately narrower than GET /api/pages/[slug]: a preview fires on a mouse
 * hover, so it must not ship a whole page body or the file-walking sync that a
 * full page read implies. Only the fields the card renders come back.
 *
 * 404 is expected in normal use (a link can outlive its page between syncs), so
 * the client treats it as "no preview" rather than an error.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const ctx = await openWikiContext();
  try {
    const page = await readPage(ctx.wikiPath, params.slug);
    const { text, truncated } = buildExcerpt(page.content);

    const preview: PagePreview = {
      slug: page.slug,
      title: page.frontmatter.title,
      type: page.frontmatter.type,
      tags: page.frontmatter.tags ?? [],
      updated: page.frontmatter.updated,
      excerpt: text,
      truncated,
    };
    return NextResponse.json(preview);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: `page not found: ${params.slug}` }, { status: 404 });
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "failed to build preview" },
      { status: 500 },
    );
  } finally {
    ctx.db.close();
  }
}
