"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import { PagePreviewProvider, useWikiLinkPreview } from "./page-preview";

// We preprocess [[slug]] / [[slug|Display]] into ordinary markdown links with a
// `#wikilink:slug` href so react-markdown emits them as <a>. The custom link
// renderer below converts that prefix into a Next.js <Link>.
const WIKILINK_RE = /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;
const WIKILINK_PREFIX = "#wikilink:";

function preprocessWikiLinks(md: string): string {
  return md.replace(WIKILINK_RE, (_, slug: string, label?: string) => {
    const display = (label && label.trim()) || slug;
    // Escape closing bracket in display to avoid breaking the link syntax.
    const safeDisplay = display.replace(/]/g, "\\]");
    return `[${safeDisplay}](${WIKILINK_PREFIX}${slug})`;
  });
}

export type MarkdownViewProps = {
  content: string;
  /** All slugs known to exist. Wikilinks to unknown slugs render strikethrough. */
  knownSlugs: ReadonlyArray<string>;
  className?: string;
};

/**
 * A single wikilink. Exists as its own component because the hover preview is a
 * hook: react-markdown's `a` renderer is called as a plain function, so a hook
 * cannot live inside it.
 */
function WikiLink({
  slug,
  exists,
  children,
}: {
  slug: string;
  exists: boolean;
  children: React.ReactNode;
}) {
  // Only links that resolve to a page can preview; a strikethrough link has
  // nothing to fetch and would 404 the preview endpoint on every hover.
  const preview = useWikiLinkPreview(exists ? slug : null);

  return (
    <Link
      href={`/wiki/${slug}`}
      className={cn(
        exists
          ? "text-primary underline underline-offset-2 hover:text-primary/80"
          : "text-muted-foreground line-through decoration-1 hover:text-foreground",
        // A quiet signal that the card is on its way. Without it the 800ms wait
        // reads as "nothing happened".
        preview.active && "rounded bg-primary/10",
      )}
      title={exists ? `→ ${slug}` : `页面“${slug}”尚不存在`}
      {...preview.handlers}
    >
      {children}
    </Link>
  );
}

export function MarkdownView({ content, knownSlugs, className }: MarkdownViewProps) {
  const knownSet = new Set(knownSlugs);
  const processed = preprocessWikiLinks(content);

  return (
    // One provider per rendered document: every link inside shares a single
    // card, a single cache and a single pair of timers.
    <PagePreviewProvider>
      <div
        className={cn(
          "prose prose-stone max-w-none dark:prose-invert",
          "prose-headings:font-semibold prose-headings:tracking-tight",
          "prose-a:text-primary prose-a:underline-offset-2",
          "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-[''] prose-code:after:content-['']",
          className,
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...rest }) => {
              if (href && href.startsWith(WIKILINK_PREFIX)) {
                const slug = href.slice(WIKILINK_PREFIX.length);
                return (
                  <WikiLink slug={slug} exists={knownSet.has(slug)}>
                    {children}
                  </WikiLink>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              );
            },
          }}
        >
          {processed}
        </ReactMarkdown>
      </div>
    </PagePreviewProvider>
  );
}
