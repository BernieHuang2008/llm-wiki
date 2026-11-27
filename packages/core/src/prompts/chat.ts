import type { RawSourceSnippet } from "../raw-search";
import type { ExistingPageSnippet } from "./ingest";

const SYSTEM_RULES = `You are answering questions in a persistent chat thread against a personal LLM Wiki.

Rules:
- Cite wiki pages with [[slug]] (use the slugs from the index — kebab-case, lowercase).
- Raw-source excerpts (when present) are first-hand originals from raw/. Prefer them over compiled pages when more specific, and cite them as [raw:<filename>].
- Reference earlier turns in the thread when relevant.
- If the wiki doesn't cover something, say so honestly — don't invent.
- Use markdown freely (lists, headings, tables). No JSON output unless explicitly asked.
- Be concise but complete. Prioritize the user's question over restating context.`;

const AGENT_RULES = `You are an agentic assistant answering inside a persistent chat thread about a personal LLM Wiki.

You have tools. Use them instead of guessing:
- wiki_search / wiki_list_pages to locate compiled wiki pages.
- wiki_read_page to read a page; wiki_backlinks to see how it connects.
- raw_search / raw_list / raw_read to consult the original raw/ sources. Prefer raw originals when they are more specific than a compiled summary.
- wiki_create_page / wiki_update_page to add or edit compiled pages. Only do this when the user explicitly asks you to change the wiki; read the page with wiki_read_page before updating it.
- The first write in a turn pauses for the user's approval. If they deny it, do not retry — answer with the proposed content instead.
- Cite compiled pages with [[slug]] and raw sources with [raw:<filename>].
- Do not invent facts. If neither the wiki nor raw layer covers something, say so.
- Work in a few focused tool calls, then write the final answer as normal markdown. Do NOT output JSON.
- Reference earlier turns in the thread when relevant.
- Be concise but complete.`;

export type BuildChatAgentSystemPromptOpts = {
  schema: string;
  index: string;
};

export function buildChatAgentSystemPrompt(opts: BuildChatAgentSystemPromptOpts): string {
  return [
    AGENT_RULES,
    "",
    "User schema (CLAUDE.md):",
    fenceMarkdown(opts.schema),
    "",
    "Current wiki index:",
    fenceMarkdown(opts.index),
  ].join("\n");
}

export type BuildChatSystemPromptOpts = {
  schema: string;
  index: string;
  relevantPages: ExistingPageSnippet[];
  /** First-hand excerpts from raw/ most relevant to the latest user turn. */
  rawSources?: RawSourceSnippet[];
};

export function buildChatSystemPrompt(opts: BuildChatSystemPromptOpts): string {
  const pagesBlock =
    opts.relevantPages.length > 0
      ? opts.relevantPages
          .map(
            (p) =>
              `### ${p.title} (slug: ${p.slug}, type: ${p.type})\n${truncateToWords(p.excerpt, 800)}`,
          )
          .join("\n\n---\n\n")
      : "(no pages currently match — the wiki may not cover this thread's topic yet)";

  const rawBlock = renderRawSources(opts.rawSources ?? []);

  return [
    SYSTEM_RULES,
    "",
    "User schema (CLAUDE.md):",
    fenceMarkdown(opts.schema),
    "",
    "Current wiki index:",
    fenceMarkdown(opts.index),
    "",
    `Possibly relevant pages (top ${opts.relevantPages.length}):`,
    fenceMarkdown(pagesBlock),
    ...(rawBlock
      ? ["", "Relevant raw-source excerpts (first-hand):", fenceMarkdown(rawBlock)]
      : []),
  ].join("\n");
}

function renderRawSources(sources: RawSourceSnippet[]): string {
  if (sources.length === 0) return "";
  return sources
    .map((s) => `### ${s.title} (raw: ${s.path}, mode: ${s.mode})\n${s.excerpt}`)
    .join("\n\n---\n\n");
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}\n\n[truncated: ${words.length - maxWords} more words]`;
}

function fenceMarkdown(text: string): string {
  return `\`\`\`\`markdown\n${text}\n\`\`\`\``;
}
