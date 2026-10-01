// Markdown structure helpers for `wiki_get_toc` and `wiki_get_section`.
//
// The whole point of these two tools is that a model can read a twenty-page
// wiki page for the price of its table of contents, then pull only the section
// it needs. That only works if the line ranges are exact, so this module is
// deliberately a small, pure, well-tested function rather than a dependency on
// a full markdown AST.

export type Heading = {
  /** 1–6, matching the `#` count. */
  level: number;
  title: string;
  /** GitHub-style anchor, unique within the page. */
  id: string;
  /** 1-based line index of the heading itself. */
  startLine: number;
  /** 1-based inclusive last line of this section, including subsections. */
  endLine: number;
  /** 1-based inclusive last line before the first sub-heading. */
  ownEndLine: number;
  /** Heading chain, e.g. `Alpha > Beta`; the stable id for `wiki_get_section`. */
  path: string;
  /** First ~120 characters of the section's own prose, markdown-flattened. */
  preview: string;
};

export type TocOptions = {
  /** Return the leading H1 (which usually repeats the page title). Off by default. */
  includeTitleHeading?: boolean;
};

const ATX_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const PREVIEW_LEN = 120;

/**
 * Extracts the heading tree.
 *
 * Fenced code blocks are tracked and skipped: a `# comment` inside a shell
 * snippet is not a section, and treating it as one would make the line ranges
 * wrong for every heading after it.
 */
export function extractHeadings(content: string, options: TocOptions = {}): Heading[] {
  const lines = content.split(/\r?\n/);
  const raw: Array<{ level: number; title: string; line: number }> = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```";
      if (fence === null) fence = marker.slice(0, 3);
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const match = ATX_RE.exec(line);
    if (!match) continue;
    const hashes = match[1] ?? "";
    const title = stripInline(match[2] ?? "");
    if (title.length === 0) continue;
    raw.push({ level: hashes.length, title, line: i + 1 });
  }

  const headings: Heading[] = [];
  const seenIds = new Map<string, number>();
  const pathStack: Array<{ level: number; title: string }> = [];

  for (let i = 0; i < raw.length; i++) {
    const current = raw[i];
    if (current === undefined) continue;

    const next = raw[i + 1];
    const nextLine = next?.line ?? lines.length + 1;
    const ownEndLine = nextLine - 1;

    // The section runs to the next heading of the same or higher level.
    let endLine = ownEndLine;
    for (let j = i + 1; j < raw.length; j++) {
      const candidate = raw[j];
      if (candidate === undefined) continue;
      if (candidate.level <= current.level) {
        endLine = candidate.line - 1;
        break;
      }
      endLine = lines.length;
    }

    while (pathStack.length > 0 && (pathStack[pathStack.length - 1]?.level ?? 0) >= current.level) {
      pathStack.pop();
    }
    pathStack.push({ level: current.level, title: current.title });
    const path = pathStack.map((p) => p.title).join(" > ");

    const id = uniqueSlug(current.title, seenIds);
    const body = lines.slice(current.line, ownEndLine).join("\n");
    headings.push({
      level: current.level,
      title: current.title,
      id,
      startLine: current.line,
      endLine,
      ownEndLine,
      path,
      preview: previewOf(body),
    });
  }

  if (options.includeTitleHeading === false && headings[0]?.level === 1) {
    return headings.slice(1);
  }
  return headings;
}

/** Lines of one section: `startLine`..`endLine`, 1-based inclusive. */
export function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
}

/** Matches a heading by its `path`, its bare title, or its anchor id. */
export function findHeading(headings: Heading[], query: string): Heading | null {
  const needle = query.trim();
  if (needle.length === 0) return null;
  const lowered = needle.toLowerCase();

  for (const pass of ["path", "title", "id"] as const) {
    for (const heading of headings) {
      if (heading[pass].toLowerCase() === lowered) return heading;
    }
  }
  // Last resort: substring, so a model that only remembers part of a title
  // still gets an answer instead of an error.
  for (const heading of headings) {
    if (heading.title.toLowerCase().includes(lowered)) return heading;
  }
  return null;
}

/** Direct children of `heading` (the next heading level down, until peers). */
export function childHeadings(headings: Heading[], heading: Heading): Heading[] {
  const index = headings.indexOf(heading);
  if (index === -1) return [];
  const children: Heading[] = [];
  for (let i = index + 1; i < headings.length; i++) {
    const candidate = headings[i];
    if (candidate === undefined) continue;
    if (candidate.level <= heading.level) break;
    if (candidate.level === heading.level + 1) children.push(candidate);
  }
  return children;
}

/**
 * GitHub's anchor algorithm: lowercase, drop anything that is not a word
 * character, space or hyphen, then spaces → hyphens. Close enough that the ids
 * line up with what the web UI links to.
 */
function uniqueSlug(title: string, seen: Map<string, number>): string {
  const base = slugify(title);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[``*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function previewOf(body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => stripInline(p.replace(/^[ \t]*[-*+>][ \t]?/gm, "")))
    .filter((p) => p.length > 0);
  const first = paragraphs[0] ?? "";
  return first.length <= PREVIEW_LEN ? first : `${first.slice(0, PREVIEW_LEN).trimEnd()}…`;
}

function stripInline(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/<[^>\n]{1,64}>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
