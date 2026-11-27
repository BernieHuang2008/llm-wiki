import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openInMemoryDb, type Db } from "./db";
import { insertSource } from "./db-sources";
import { listRawSources, readRawSource } from "./raw";
import type { SourceRow } from "./types";
import { initWikiFolder, WIKI_PATHS } from "./wiki";

let wikiPath: string;
let db: Db;

const NOTES_FILENAME = "2026-01-01-notes.md";
const PAPER_FILENAME = "2026-01-02-paper.pdf";

function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "source-1",
    filename: NOTES_FILENAME,
    original_name: "notes.md",
    format: "md",
    size_bytes: 20,
    added_at: "2026-01-01T00:00:00.000Z",
    ingested_at: null,
    url: null,
    title: "My Notes",
    ingest_error: null,
    ...overrides,
  };
}

beforeEach(async () => {
  wikiPath = await mkdtemp(join(tmpdir(), "llm-wiki-raw-test-"));
  await initWikiFolder(wikiPath);
  db = openInMemoryDb();

  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, NOTES_FILENAME),
    "# Raw notes\n\nThe original period-finding derivation.\n",
    "utf8",
  );
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, PAPER_FILENAME),
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]),
  );
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, `${PAPER_FILENAME}.extracted.md`),
    "The extracted text layer of the paper.\n",
    "utf8",
  );

  insertSource(db, sourceRow());
});

afterEach(async () => {
  db.close();
  await rm(wikiPath, { recursive: true, force: true });
});

describe("listRawSources", () => {
  it("lists raw files with source metadata and text-layer status", async () => {
    const sources = await listRawSources(wikiPath, db);
    expect(sources.map((s) => s.filename)).toEqual([NOTES_FILENAME, PAPER_FILENAME]);

    const notes = sources.find((s) => s.filename === NOTES_FILENAME);
    expect(notes).toMatchObject({
      id: "source-1",
      path: `raw/${NOTES_FILENAME}`,
      title: "My Notes",
      format: "md",
      hasExtractedText: false,
    });

    const paper = sources.find((s) => s.filename === PAPER_FILENAME);
    expect(paper).toMatchObject({ id: null, format: "pdf", hasExtractedText: true });
  });

  it("does not expose .extracted.md siblings as separate sources", async () => {
    const sources = await listRawSources(wikiPath, db);
    expect(sources.some((s) => s.filename.endsWith(".extracted.md"))).toBe(false);
  });
});

describe("readRawSource", () => {
  it("reads a text original by source id", async () => {
    const result = await readRawSource(wikiPath, db, "source-1");
    expect(result.mode).toBe("original");
    expect(result.source.id).toBe("source-1");
    expect(result.text).toContain("period-finding derivation");
    expect(result.truncated).toBe(false);
  });

  it("accepts raw/ paths and original upload names", async () => {
    const byPath = await readRawSource(wikiPath, db, `raw/${NOTES_FILENAME}`);
    expect(byPath.text).toContain("Raw notes");

    const byOriginalName = await readRawSource(wikiPath, db, "notes.md");
    expect(byOriginalName.source.filename).toBe(NOTES_FILENAME);
  });

  it("caps output at maxChars and reports the full length", async () => {
    const result = await readRawSource(wikiPath, db, NOTES_FILENAME, { maxChars: 10 });
    expect(result.text).toHaveLength(10);
    expect(result.totalChars).toBeGreaterThan(10);
    expect(result.truncated).toBe(true);
  });

  it("auto-reads the extracted text layer for binary originals", async () => {
    const result = await readRawSource(wikiPath, db, PAPER_FILENAME);
    expect(result.mode).toBe("extracted");
    expect(result.text).toContain("extracted text layer");
    expect(result.source.hasExtractedText).toBe(true);
  });

  it("refuses to decode binary bytes as original text", async () => {
    await expect(readRawSource(wikiPath, db, PAPER_FILENAME, { mode: "original" })).rejects.toThrow(
      /二进制/,
    );
  });

  it("reports a missing extracted layer instead of returning empty text", async () => {
    await expect(
      readRawSource(wikiPath, db, NOTES_FILENAME, { mode: "extracted" }),
    ).rejects.toThrow(/没有已提取的文本/);
  });

  it("rejects path traversal", async () => {
    await expect(readRawSource(wikiPath, db, "../CLAUDE.md")).rejects.toThrow(/不合法/);
    await expect(readRawSource(wikiPath, db, "nested/file.md")).rejects.toThrow(/不合法/);
  });
});
