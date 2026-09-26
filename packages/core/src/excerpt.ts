// Plain-text excerpt extraction for hover previews (and anything else that
// needs a one-glance summary of a wiki page body).
//
// Kept in @llm-wiki/core rather than in a React component so the "what does the
// preview say" logic is a pure function with unit tests, independent of the DOM.

/**
 * Structural markdown that never belongs in a preview. Fenced code blocks and
 * tables are dropped whole (including their content) because half a code block
 * is worse than no code block.
 */
const FENCED_CODE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
const TABLE_ROW_RE = /^[ \t]*\|.*\|[ \t]*$/gm;
const HORIZONTAL_RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm;
const ATX_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm;
const SETEXT_UNDERLINE_RE = /^[ \t]{0,3}(?:={2,}|-{2,})[ \t]*$/gm;
const BLOCKQUOTE_MARKER_RE = /^[ \t]{0,3}>[ \t]?/gm;
const LIST_MARKER_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm;

const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const REFERENCE_LINK_RE = /\[([^\]]*)\]\[[^\]]*\]/g;
const AUTOLINK_RE = /<((?:https?|mailto):[^>\s]+)>/g;
const INLINE_CODE_RE = /`([^`]*)`/g;
const EMPHASIS_RE = /(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1/g;
const STRIKETHROUGH_RE = /~~(?=\S)([\s\S]*?\S)~~/g;
const HTML_TAG_RE = /<[^>\n]{1,64}>/g;

// Same shape as the renderer's inline wikilink form, but deliberately bounded
// to a single line: links.ts's WIKILINK_RE lets the display group span newlines
// when a `]` is missing, which would swallow whole paragraphs here.
const INLINE_WIKILINK_RE = /\[\[([a-z0-9-]+)(?:\|([^\]\n]*))?\]\]/g;

const WHITESPACE_RE = /\s+/g;
const SENTENCE_END_RE = /[。．.！!？?；;：:]["'”’）)】」』]?\s*$/;

/**
 * A paragraph is an "empty shell" when it is short *and* what remains after
 * removing every link and image is negligible. Both halves matter: a paragraph
 * that is nothing but `[[links]]` must be skipped so the preview shows the real
 * prose further down, while a short but complete sentence — very common in CJK,
 * where 20 characters is already a full clause — is real content.
 */
const MIN_SHELL_LENGTH = 24;
const MIN_PROSE_OUTSIDE_LINKS = 12;

const LINK_OR_IMAGE_RE = /!?\[[^\]\n]*\]\([^)\n]*\)|\[\[[a-z0-9-]+(?:\|[^\]\n]*)?\]\]/g;

export type PageExcerpt = {
  /** Plain text: markdown stripped, wikilinks reduced to their display text. */
  text: string;
  /** True when the body's prose is longer than `text` — i.e. the text was cut. */
  truncated: boolean;
};

export type ExcerptOptions = {
  /** Hard character budget for the returned text. */
  limit?: number;
};

export const DEFAULT_EXCERPT_LIMIT = 450;

/** `[[slug|Display]]` → `Display`, `[[slug]]` → `slug`. */
function renderWikiLinks(text: string): string {
  return text.replace(INLINE_WIKILINK_RE, (_full, slug: string, display?: string) => {
    const label = (display ?? "").trim();
    return label.length > 0 ? label : slug;
  });
}

function stripInline(raw: string): string {
  let text = renderWikiLinks(raw);
  text = text.replace(IMAGE_RE, (_full, alt: string) => alt);
  text = text.replace(LINK_RE, "$1");
  text = text.replace(REFERENCE_LINK_RE, "$1");
  text = text.replace(AUTOLINK_RE, "$1");
  text = text.replace(INLINE_CODE_RE, "$1");
  text = text.replace(EMPHASIS_RE, "$2");
  text = text.replace(STRIKETHROUGH_RE, "$1");
  text = text.replace(HTML_TAG_RE, "");
  return text.replace(WHITESPACE_RE, " ").trim();
}

/**
 * A paragraph worth previewing: real visible text, not a link list, not a bare
 * label. Takes the *raw* paragraph, because the amount of markup it sheds is
 * exactly the signal that it was link-only.
 */
function isShell(raw: string): boolean {
  const text = stripInline(raw);
  if (text.length === 0) return true;
  if (text.length >= MIN_SHELL_LENGTH) return false;
  // Reference-link definitions: "[1]: https://…".
  if (/^\[[^\]]*\]:/.test(text)) return true;
  // Link markup is not content: for "[[qubit]]" or "See [[qc]]" almost nothing
  // is left once the links go, but a real short sentence keeps all its words.
  const outsideLinks = raw.replace(LINK_OR_IMAGE_RE, "").replace(WHITESPACE_RE, "").length;
  return outsideLinks < MIN_PROSE_OUTSIDE_LINKS;
}

/**
 * Fills the budget, then rewinds to the last sentence boundary and, failing
 * that, the last word boundary — so the preview ends on a complete thought
 * instead of mid-clause. A rewound cut that gives back too much is discarded in
 * favour of the hard cut, otherwise a page whose opening sentence happens to be
 * tiny would preview as five words.
 */
function truncateAt(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };

  const window = text.slice(0, limit);
  const minUseful = Math.floor(limit * 0.6);

  for (let i = window.length; i >= minUseful; i--) {
    const candidate = window.slice(0, i);
    if (SENTENCE_END_RE.test(candidate)) {
      return { text: candidate.trimEnd(), truncated: true };
    }
  }

  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace >= minUseful) {
    return { text: window.slice(0, lastSpace).trimEnd(), truncated: true };
  }

  return { text: window.trimEnd(), truncated: true };
}

/**
 * Builds the sentence shown in a hover preview from a page body (frontmatter
 * already stripped by readPage).
 *
 * Paragraphs are tried in order and the first one that actually says something
 * wins, which is what makes the ingest pipeline's link-only opening sections
 * fall through to real prose.
 */
export function buildExcerpt(content: string, options: ExcerptOptions = {}): PageExcerpt {
  const limit = options.limit ?? DEFAULT_EXCERPT_LIMIT;

  const headings: string[] = [];
  const stripped = content
    .replace(FENCED_CODE_RE, "\n\n")
    .replace(TABLE_ROW_RE, "\n\n")
    .replace(HORIZONTAL_RULE_RE, "\n\n")
    .replace(ATX_HEADING_RE, (_full, heading: string) => {
      const label = stripInline(heading);
      if (label.length > 0) headings.push(label);
      return "\n\n";
    })
    .replace(SETEXT_UNDERLINE_RE, "\n\n")
    .replace(BLOCKQUOTE_MARKER_RE, "")
    .replace(LIST_MARKER_RE, "");

  // Strip once per paragraph up front (the shell test needs the raw form too,
  // so both are kept): doing the stripping inside the scan below made the
  // "is there more prose after this?" check quadratic on long pages.
  const paragraphs = stripped
    .split(/\n{2,}/)
    .map((raw) => ({
      raw: raw.trim(),
      text: stripInline(raw),
    }))
    .filter((p) => p.text.length > 0);

  // No prose at all — the section headings are a far better preview than the
  // bare link labels the editor happened to use, so prefer them.
  const hasProse = paragraphs.some((p) => !isShell(p.raw));
  if (!hasProse) {
    if (headings.length > 0) return truncateAt(headings.join(" · "), limit);
    const stub = paragraphs[0];
    return stub === undefined ? { text: "", truncated: false } : truncateAt(stub.text, limit);
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (paragraph === undefined) continue;

    // A shell is skipped in favour of a later paragraph, so a page whose lead
    // section is nothing but links previews as the prose further down.
    if (isShell(paragraph.raw)) continue;

    const cut = truncateAt(paragraph.text, limit);
    // `truncated` describes the excerpt text only — whether the body holds more
    // prose than fits the budget. Other sections existing is not truncation: the
    // card simply is not the page.
    return { text: cut.text, truncated: cut.truncated };
  }

  // Unreachable: `hasProse` above guarantees the loop returns.
  return { text: "", truncated: false };
}
