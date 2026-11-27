// Lexical retrieval over the raw/ layer.
//
// Built-in LLM operations (query, chat, ingest) historically only received
// compiled wiki pages. This module makes the originals available too: it scans
// the raw sources, scores short excerpts against the user's question, and
// returns the best few so a prompt can include first-hand evidence next to the
// compiled pages.
//
// Deliberately in-process and dependency-free. A personal wiki has hundreds of
// sources, not millions of documents; a bounded lexical scan is enough and
// works with no Meilisearch instance.

import type { Db } from "./db";
import { isRawTextFilename, listRawSources, readRawSource, type RawSourceEntry } from "./raw";
import type { SourceFormat } from "./types";

export type RawSourceSnippet = {
  id: string | null;
  filename: string;
  path: string;
  title: string;
  format: SourceFormat | null;
  /** Whether the excerpt came from the file itself or its extracted text layer. */
  mode: "original" | "extracted";
  score: number;
  excerpt: string;
};

export type SearchRawSourcesOptions = {
  limit?: number;
  maxExcerptChars?: number;
  /** Skip this source — used by ingest so the new source is not repeated. */
  excludeSourceId?: string | null;
  maxFiles?: number;
  maxCharsPerFile?: number;
};

const DEFAULT_LIMIT = 4;
const DEFAULT_EXCERPT_CHARS = 1600;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_CHARS_PER_FILE = 200_000;
const CHUNK_CHARS = 1600;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS_PER_SOURCE = 2;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "should",
  "so",
  "than",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "yes",
  "you",
  "your",
  "一个",
  "一些",
  "什么",
  "以及",
  "他们",
  "你们",
  "关于",
  "可以",
  "哪些",
  "如何",
  "它们",
  "是否",
  "这个",
  "这些",
  "那个",
  "那些",
  "为什么",
  "我们",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "也",
  "就",
  "都",
  "而",
  "及",
  "或",
  "对",
  "中",
  "上",
  "下",
  "吗",
  "呢",
]);

/**
 * Returns the raw excerpts most relevant to `query`.
 *
 * Text originals are read directly; binary sources are read through their
 * `.extracted.md` sibling. Sources with neither a text body nor an extracted
 * layer are skipped.
 */
export async function searchRawSources(
  wikiPath: string,
  db: Db | null,
  query: string,
  options: SearchRawSourcesOptions = {},
): Promise<RawSourceSnippet[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, 20);
  const maxExcerptChars = clamp(options.maxExcerptChars ?? DEFAULT_EXCERPT_CHARS, 200, 8000);
  const maxFiles = clamp(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 2000);
  const maxCharsPerFile = clamp(
    options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE,
    1000,
    2_000_000,
  );

  const excluded = options.excludeSourceId ?? null;
  const sources = (await listRawSources(wikiPath, db))
    .filter((source) => excluded === null || source.id !== excluded)
    .filter(canReadText)
    .slice(0, maxFiles);

  type Candidate = {
    source: RawSourceEntry;
    mode: "original" | "extracted";
    text: string;
    score: number;
  };

  const candidates: Candidate[] = [];
  for (const source of sources) {
    let text: string;
    let mode: "original" | "extracted";
    try {
      const read = await readRawSource(wikiPath, db, source.id ?? source.filename, {
        mode: "auto",
        maxChars: maxCharsPerFile,
      });
      text = read.text;
      mode = read.mode;
    } catch {
      continue;
    }

    const lower = text.toLowerCase();
    const titleHaystack = `${source.title} ${source.filename}`.toLowerCase();
    const titleScore = terms.reduce((sum, term) => sum + (titleHaystack.includes(term) ? 6 : 0), 0);
    const contentMatches = terms.some((term) => lower.includes(term));
    if (!contentMatches && titleScore === 0) continue;

    const chunks = chunkText(text);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index] ?? "";
      const lowerChunk = chunk.toLowerCase();
      let hits = 0;
      let total = 0;
      for (const term of terms) {
        const count = countOccurrences(lowerChunk, term);
        if (count > 0) {
          hits++;
          total += count;
        }
      }

      // A title-only match still yields the opening of the file: a question
      // like "what does the Shor notes raw say?" may not share vocabulary with
      // the note itself.
      const score = hits > 0 ? total + hits + titleScore : index === 0 ? titleScore : 0;
      if (score <= 0) continue;
      candidates.push({ source, mode, text: chunk, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const picked: Candidate[] = [];
  const perSource = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.source.id ?? candidate.source.filename;
    const count = perSource.get(key) ?? 0;
    if (count >= MAX_CHUNKS_PER_SOURCE) continue;
    perSource.set(key, count + 1);
    picked.push(candidate);
    if (picked.length >= limit) break;
  }

  return picked.map((candidate) => ({
    id: candidate.source.id,
    filename: candidate.source.filename,
    path: candidate.source.path,
    title: candidate.source.title,
    format: candidate.source.format,
    mode: candidate.mode,
    score: candidate.score,
    excerpt: excerptAround(candidate.text, terms, maxExcerptChars),
  }));
}

function canReadText(source: RawSourceEntry): boolean {
  if (source.hasExtractedText) return true;
  return isRawTextFilename(source.filename);
}

function queryTerms(query: string): string[] {
  const text = query.toLowerCase();
  const terms = new Set<string>();

  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    const term = match[0];
    if (term !== undefined && term.length >= 2 && !STOPWORDS.has(term)) terms.add(term);
  }

  // CJK text has no spaces. Bigrams keep retrieval useful without a
  // language-specific tokenizer; single-character runs still count.
  for (const match of text.matchAll(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  )) {
    const run = match[0];
    if (run === undefined) continue;
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) terms.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const term = run.slice(i, i + 2);
      if (!STOPWORDS.has(term)) terms.add(term);
    }
  }

  return [...terms].slice(0, 64);
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  const step = CHUNK_CHARS - CHUNK_OVERLAP;
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + CHUNK_CHARS);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
  }
  return chunks;
}

function excerptAround(text: string, terms: string[], maxChars: number): string {
  if (text.length <= maxChars) return text.trim();
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  const start = first > maxChars / 3 ? first - Math.floor(maxChars / 3) : 0;
  const end = start + maxChars;
  const body = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
