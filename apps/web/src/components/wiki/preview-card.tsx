"use client";

import { useLayoutEffect, useRef, useState } from "react";

import type { PageType } from "@llm-wiki/core";

import { cn } from "@/lib/utils";

export type PagePreview = {
  slug: string;
  title: string;
  type: PageType;
  tags: string[];
  updated: string;
  excerpt: string;
  truncated: boolean;
};

export type PreviewAnchor = {
  /** Viewport rect of the link the card belongs to. */
  rect: { top: number; left: number; bottom: number; width: number };
};

// Display labels for the stored page-type values (same mapping the page header
// uses). The values stay English because they are frontmatter keys.
const TYPE_LABEL: Record<PageType, string> = {
  entity: "实体",
  concept: "概念",
  source: "Source",
  comparison: "对比",
  overview: "概览",
};

export const PREVIEW_CARD_WIDTH = 360;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 12;
/** Fallback height used for the first paint, before the card is measured. */
const ASSUMED_HEIGHT = 150;
/** Longest excerpt the card will ever render, for the fade-out mask. */
const MAX_VISIBLE_LINES = 8;

type Position = { top: number; left: number; width: number; above: boolean };

function computePosition(anchor: PreviewAnchor, height: number): Position {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(PREVIEW_CARD_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN);

  const spaceBelow = viewportHeight - anchor.rect.bottom - CARD_GAP - VIEWPORT_MARGIN;
  const spaceAbove = anchor.rect.top - CARD_GAP - VIEWPORT_MARGIN;

  // Prefer below the link, flip above only when below genuinely cannot fit and
  // above is roomier — otherwise short viewports would flip needlessly.
  const above = spaceBelow < height && spaceAbove > spaceBelow;
  const top = above
    ? Math.max(VIEWPORT_MARGIN, anchor.rect.top - CARD_GAP - height)
    : Math.min(anchor.rect.bottom + CARD_GAP, viewportHeight - height - VIEWPORT_MARGIN);

  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.rect.left),
    viewportWidth - width - VIEWPORT_MARGIN,
  );

  return { top, left, width, above };
}

export type PreviewCardProps = {
  preview: PagePreview;
  anchor: PreviewAnchor;
  /** True when the preview data is still being fetched. */
  loading: boolean;
  /** True when the fetch returned 404 — the card should say so, not look broken. */
  missing: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
};

export function PreviewCard({
  preview,
  anchor,
  loading,
  missing,
  onPointerEnter,
  onPointerLeave,
}: PreviewCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position>(() => computePosition(anchor, ASSUMED_HEIGHT));

  // Measure after layout so the flip decision uses the real card height, then
  // re-measure whenever the preview changes (loading → loaded changes the size).
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? ASSUMED_HEIGHT;
    setPosition((current) => {
      const next = computePosition(anchor, height);
      return current.top === next.top &&
        current.left === next.left &&
        current.width === next.width &&
        current.above === next.above
        ? current
        : next;
    });
  }, [anchor, preview, loading, missing]);

  return (
    <div
      ref={ref}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
      }}
      className={cn(
        "fixed z-[60] overflow-hidden rounded-lg border border-border bg-card text-left",
        "shadow-xl shadow-black/10 ring-1 ring-black/[0.02] dark:shadow-black/40",
        // 250ms fade-in. The provider this card lives in is skipped entirely for
        // users who asked for reduced motion, so no animation is defined there.
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200",
        "dark:border-border/80",
      )}
    >
      <div className="flex items-baseline gap-2 border-b border-border/60 px-3 py-2">
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          {TYPE_LABEL[preview.type]}
        </span>
        <span className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-foreground">
          {preview.title}
        </span>
      </div>

      <div className="px-3 py-2">
        {missing ? (
          <p className="text-[13px] text-muted-foreground">
            页面
            <code className="mx-1 font-mono text-[12px]">{preview.slug}</code>
            尚不存在，可能已被删除或改名。
          </p>
        ) : loading ? (
          // Skeleton keeps the card from popping in at a different height than
          // the loading state, which reads as a jump.
          <div className="space-y-1.5" aria-hidden>
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ) : preview.excerpt.length > 0 ? (
          <p
            className="overflow-hidden text-[13px] leading-relaxed text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical]"
            style={{ WebkitLineClamp: MAX_VISIBLE_LINES }}
          >
            {preview.excerpt}
            {preview.truncated ? "…" : null}
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">这个页面还没有正文内容。</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {preview.tags.length > 0 ? preview.tags.join(" · ") : `更新于 ${preview.updated}`}
        </span>
        {!missing ? (
          <a
            href={`/wiki/${preview.slug}`}
            className="shrink-0 text-[11px] font-medium text-primary underline underline-offset-2 hover:text-primary/80"
          >
            打开页面 →
          </a>
        ) : null}
      </div>
    </div>
  );
}
