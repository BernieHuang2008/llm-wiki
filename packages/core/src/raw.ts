// Raw-source access.
//
// The wiki is compiled from `raw/` originals, but the LLM normally only sees
// the compiled pages. These helpers let read-only surfaces (MCP, the sources
// UI) open the original file instead of the digest.
//
// Binary originals (pdf, docx, images, …) are not readable as text. When an
// `.extracted.md` sibling exists, callers can read that text layer through the
// same API; `mode: "original"` deliberately refuses to decode binary bytes as
// if they were UTF-8.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import type { Db } from "./db";
import { listSourceRows } from "./db-sources";
import type { SourceFormat, SourceRow } from "./types";
import { WIKI_PATHS } from "./wiki";

export const EXTRACTED_SUFFIX = ".extracted.md";
export const DEFAULT_RAW_MAX_CHARS = 50_000;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".html",
  ".htm",
  ".xml",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".log",
  ".rst",
  ".tex",
  ".org",
]);

const EXTENSION_FORMATS: Record<string, SourceFormat> = {
  md: "md",
  markdown: "md",
  txt: "txt",
  text: "txt",
  html: "html",
  htm: "html",
  url: "url",
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  svg: "image",
};

export class RawSourceError extends Error {
  override readonly name = "RawSourceError";
}

export type RawSourceEntry = {
  /** `sources.id` when the file was uploaded through the app, else null. */
  id: string | null;
  filename: string;
  /** Path relative to the wiki folder, e.g. `raw/2026-01-01-paper.pdf`. */
  path: string;
  title: string;
  format: SourceFormat | null;
  sizeBytes: number;
  addedAt: string | null;
  ingestedAt: string | null;
  url: string | null;
  originalName: string | null;
  /** True when `<filename>.extracted.md` is available for binary originals. */
  hasExtractedText: boolean;
};

export type RawSourceReadMode = "auto" | "original" | "extracted";

export type RawSourceContent = {
  source: RawSourceEntry;
  /** Which file the text actually came from. */
  mode: "original" | "extracted";
  text: string;
  totalChars: number;
  truncated: boolean;
};

export type ReadRawSourceOptions = {
  mode?: RawSourceReadMode;
  maxChars?: number;
};

/**
 * Every file in `raw/`, enriched with its `sources` row when one exists.
 *
 * `.extracted.md` siblings are not separate sources; they mark their original
 * as having a text layer. The filesystem is the source of truth, so a raw file
 * dropped in by hand shows up even before it has a database row.
 */
export async function listRawSources(
  wikiPath: string,
  db: Db | null = null,
): Promise<RawSourceEntry[]> {
  const files = await listRawFiles(wikiPath);
  const rows = db ? listSourceRows(db) : [];
  const rowByFilename = new Map(rows.map((row) => [row.filename, row]));

  const names = new Set(files.map((file) => file.filename));
  const extracted = new Set(
    [...names]
      .filter((name) => name.endsWith(EXTRACTED_SUFFIX))
      .map((name) => name.slice(0, -EXTRACTED_SUFFIX.length)),
  );

  return files
    .filter((file) => !file.filename.endsWith(EXTRACTED_SUFFIX))
    .map((file) =>
      buildEntry(
        file.filename,
        file.sizeBytes,
        rowByFilename.get(file.filename) ?? null,
        extracted.has(file.filename),
      ),
    )
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/**
 * Reads one raw source.
 *
 * `selector` accepts a `sources.id`, the on-disk filename, a `raw/...` path, or
 * the original upload name. Ambiguous titles are intentionally not matched.
 */
export async function readRawSource(
  wikiPath: string,
  db: Db | null,
  selector: string,
  options: ReadRawSourceOptions = {},
): Promise<RawSourceContent> {
  const { filename, row } = await resolveRawSource(wikiPath, db, selector);
  const dir = join(wikiPath, WIKI_PATHS.raw);
  const rawPath = join(dir, filename);

  const rawStat = await stat(rawPath).catch(() => null);
  if (!rawStat || !rawStat.isFile()) {
    throw new RawSourceError(`原始文件不存在：${WIKI_PATHS.raw}/${filename}`);
  }

  const extractedPath = join(dir, `${filename}${EXTRACTED_SUFFIX}`);
  const extracted = await readTextFileIfExists(extractedPath);
  const hasExtracted = extracted !== null && extracted.trim().length > 0;
  const source = buildEntry(filename, rawStat.size, row, hasExtracted);

  const mode = options.mode ?? "auto";
  let chosen: "original" | "extracted";

  if (mode === "extracted") {
    if (!hasExtracted) {
      throw new RawSourceError(
        `原始文件没有已提取的文本：${WIKI_PATHS.raw}/${filename}${EXTRACTED_SUFFIX}。` +
          `可改用 mode="auto" 或 mode="original"，或重新入库生成文本层。`,
      );
    }
    chosen = "extracted";
  } else if (mode === "original") {
    chosen = "original";
  } else if (isRawTextFilename(filename)) {
    chosen = "original";
  } else if (hasExtracted) {
    chosen = "extracted";
  } else if ((await readTextFile(rawPath)) !== null) {
    chosen = "original";
  } else {
    throw new RawSourceError(
      `${WIKI_PATHS.raw}/${filename} 是二进制文件，且没有已提取的文本层。` +
        `请先重新入库生成 ${filename}${EXTRACTED_SUFFIX}，或直接读取原始二进制文件。`,
    );
  }

  const text = chosen === "extracted" ? (extracted ?? "") : await readTextFile(rawPath);
  if (text === null) {
    throw new RawSourceError(
      `${WIKI_PATHS.raw}/${filename} 是二进制文件，不能按 UTF-8 文本读取。` +
        `请改用 mode="auto" 或 mode="extracted" 读取已提取的文本层。`,
    );
  }

  const maxChars =
    options.maxChars !== undefined && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : DEFAULT_RAW_MAX_CHARS;
  const truncated = text.length > maxChars;

  return {
    source,
    mode: chosen,
    text: truncated ? text.slice(0, maxChars) : text,
    totalChars: text.length,
    truncated,
  };
}

async function resolveRawSource(
  wikiPath: string,
  db: Db | null,
  selector: string,
): Promise<{ filename: string; row: SourceRow | null }> {
  const input = selector.trim();
  if (input.length === 0) throw new RawSourceError("source 不能为空。");

  const rows = db ? listSourceRows(db) : [];
  const byId = rows.find((row) => row.id === input);
  if (byId) return { filename: assertSafeFilename(wikiPath, byId.filename), row: byId };

  const name = normalizeRawPath(input);
  const byFilename = rows.find((row) => row.filename === name);
  if (byFilename)
    return { filename: assertSafeFilename(wikiPath, byFilename.filename), row: byFilename };

  const byOriginalName = rows.find((row) => row.original_name === name);
  if (byOriginalName) {
    return {
      filename: assertSafeFilename(wikiPath, byOriginalName.filename),
      row: byOriginalName,
    };
  }

  return { filename: assertSafeFilename(wikiPath, name), row: null };
}

/** `raw/foo.md` → `foo.md`; rejects traversal instead of silently truncating it. */
function normalizeRawPath(input: string): string {
  let name = input.replace(/\\/g, "/");
  if (name.startsWith(`${WIKI_PATHS.raw}/`)) name = name.slice(WIKI_PATHS.raw.length + 1);
  if (name.startsWith("./")) name = name.slice(2);
  return name;
}

function assertSafeFilename(wikiPath: string, filename: string): string {
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw new RawSourceError(`原始文件名不合法：${filename}`);
  }

  const dir = resolve(wikiPath, WIKI_PATHS.raw);
  const full = resolve(dir, filename);
  const rel = relative(dir, full);
  if (rel.length === 0 || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new RawSourceError(`原始文件名不合法：${filename}`);
  }
  return filename;
}

async function listRawFiles(
  wikiPath: string,
): Promise<Array<{ filename: string; sizeBytes: number }>> {
  const dir = join(wikiPath, WIKI_PATHS.raw);
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const files: Array<{ filename: string; sizeBytes: number }> = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || dirent.name.startsWith(".")) continue;
    try {
      const info = await stat(join(dir, dirent.name));
      files.push({ filename: dirent.name, sizeBytes: info.size });
    } catch {
      // The file vanished between readdir and stat; skip it.
    }
  }
  return files;
}

function buildEntry(
  filename: string,
  sizeBytes: number,
  row: SourceRow | null,
  hasExtractedText: boolean,
): RawSourceEntry {
  return {
    id: row?.id ?? null,
    filename,
    path: `${WIKI_PATHS.raw}/${filename}`,
    title: row?.title?.trim() || row?.original_name?.trim() || filename,
    format: row?.format ?? formatFromFilename(filename),
    sizeBytes,
    addedAt: row?.added_at ?? null,
    ingestedAt: row?.ingested_at ?? null,
    url: row?.url ?? null,
    originalName: row?.original_name ?? null,
    hasExtractedText,
  };
}

function formatFromFilename(filename: string): SourceFormat | null {
  const ext = extname(filename).slice(1).toLowerCase();
  return EXTENSION_FORMATS[ext] ?? null;
}

export function isRawTextFilename(filename: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filename).toLowerCase());
}

async function readTextFileIfExists(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Returns null for binary bytes instead of a string full of U+FFFD. */
async function readTextFile(path: string): Promise<string | null> {
  const buffer = await readFile(path);
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return null;
  const text = buffer.toString("utf8");
  return text.includes("\uFFFD") ? null : text;
}
