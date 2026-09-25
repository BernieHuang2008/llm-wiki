import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { WIKI_PATHS, type SourceFormat } from "@llm-wiki/core";
import {
  detectFormat,
  extractDocx,
  extractHtml,
  extractImage,
  extractMarkdown,
  extractPdf,
  extractPlain,
  extractPptx,
  extractXlsx,
  type ExtractedSource,
} from "@llm-wiki/ingestion";

/**
 * Turns raw bytes into an extractable source. Shared by the upload route (to
 * fail fast on an unreadable file) and the background executor (to re-extract
 * when a task runs later, possibly in a different request).
 */
export async function extractBuffer(
  format: SourceFormat,
  buffer: Buffer,
  filename: string,
): Promise<ExtractedSource> {
  switch (format) {
    case "md":
      return extractMarkdown(buffer, filename);
    case "txt":
      return extractPlain(buffer, filename);
    case "html":
      return extractHtml(buffer);
    case "url":
      // URL detection only happens via a URL string, not via uploaded file.
      // If we somehow get here, fall back to HTML.
      return extractHtml(buffer);
    case "docx":
      return extractDocx(buffer, filename);
    case "pptx":
      return extractPptx(buffer, filename);
    case "xlsx":
      return extractXlsx(buffer, filename);
    case "pdf":
      return extractPdf(buffer, filename);
    case "image":
      return extractImage(buffer, filename);
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = format;
      void _exhaustive;
      throw new Error(`unsupported format: ${String(format)}`);
    }
  }
}

/** Format detection from a filename + bytes; thin wrapper for symmetry. */
export function detectSourceFormat(filename: string, buffer: Buffer): SourceFormat {
  return detectFormat(filename, buffer);
}

/**
 * Re-reads an already-saved source from `raw/`. Used by the task executor and
 * by the retry route, so both run exactly the same pipeline regardless of how
 * the source first arrived.
 *
 * Prefers the `.extracted.md` sibling (free — no re-parsing) and falls back to
 * re-running the extractor, which is also the path large vision sources take
 * in reverse: their `.extracted.md` holds the text layer, but a vision ingest
 * needs the original bytes, so callers that want vision ask for `buffer`.
 */
export async function readStoredSource(opts: {
  wikiPath: string;
  filename: string;
  format: SourceFormat;
  /** Skip the extracted-markdown cache and return the original file bytes. */
  preferOriginal?: boolean;
}): Promise<
  | { kind: "buffer"; buffer: Buffer }
  | { kind: "extracted"; extracted: ExtractedSource }
> {
  const rawPath = join(opts.wikiPath, WIKI_PATHS.raw, opts.filename);
  if (opts.preferOriginal) {
    return { kind: "buffer", buffer: await readFile(rawPath) };
  }

  const extractedPath = join(
    opts.wikiPath,
    WIKI_PATHS.raw,
    `${opts.filename}.extracted.md`,
  );
  try {
    const cached = await readFile(extractedPath, "utf8");
    if (cached.trim().length > 0) {
      return {
        kind: "extracted",
        extracted: {
          kind: "text",
          title: opts.filename,
          content: cached,
          format: opts.format,
          metadata: { fromCache: true },
        },
      };
    }
  } catch {
    // No cache — fall through to a fresh extraction.
  }

  const buffer = await readFile(rawPath);
  return { kind: "extracted", extracted: await extractBuffer(opts.format, buffer, opts.filename) };
}
