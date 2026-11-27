import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "./db";
import { searchRawSources } from "./raw-search";
import type { SourceRow } from "./types";
import { initWikiFolder, WIKI_PATHS } from "./wiki";

let wikiPath: string;
let db: Db;

const NOTES = "2026-01-01-shor-notes.md";
const PAPER = "2026-01-02-grover.pdf";
const CJK = "2026-01-03-量子笔记.md";
const SCAN = "2026-01-04-scan.pdf";

function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "src-shor",
    filename: NOTES,
    original_name: "shor-notes.md",
    format: "md",
    size_bytes: 100,
    added_at: "2026-01-01T00:00:00.000Z",
    ingested_at: null,
    url: null,
    title: "Shor notes",
    ingest_error: null,
    ...overrides,
  };
}

beforeEach(async () => {
  wikiPath = await mkdtemp(join(tmpdir(), "llm-wiki-raw-search-test-"));
  await initWikiFolder(wikiPath);

  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, NOTES),
    "Shor's algorithm uses period finding. The quantum Fourier transform is central.\n",
    "utf8",
  );
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, PAPER),
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]),
  );
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, `${PAPER}.extracted.md`),
    "Grover search uses amplitude amplification. It is not period finding.\n",
    "utf8",
  );
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, CJK),
    "量子退火依赖绝热计算，与量子门模型不同。\n",
    "utf8",
  );
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, SCAN),
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x02]),
  );

  const rows = [
    sourceRow(),
    sourceRow({
      id: "src-grover",
      filename: PAPER,
      original_name: "grover.pdf",
      format: "pdf",
      title: "Grover paper",
    }),
  ];
  db = { prepare: () => ({ all: () => rows }) } as unknown as Db;
});

afterEach(async () => {
  await rm(wikiPath, { recursive: true, force: true });
});

describe("searchRawSources", () => {
  it("finds matching text in a raw markdown original", async () => {
    const hits = await searchRawSources(wikiPath, db, "period finding");
    expect(hits[0]).toMatchObject({ filename: NOTES, mode: "original" });
    expect(hits[0]?.excerpt).toContain("period finding");
  });

  it("searches the extracted text layer of a binary source", async () => {
    const hits = await searchRawSources(wikiPath, db, "amplitude amplification");
    expect(hits[0]).toMatchObject({ filename: PAPER, mode: "extracted" });
    expect(hits[0]?.excerpt).toContain("amplitude amplification");
  });

  it("supports CJK bigram retrieval", async () => {
    const hits = await searchRawSources(wikiPath, db, "绝热计算");
    expect(hits[0]?.filename).toBe(CJK);
    expect(hits[0]?.excerpt).toContain("绝热计算");
  });

  it("excludes the source currently being ingested", async () => {
    const hits = await searchRawSources(wikiPath, db, "quantum Fourier transform", {
      excludeSourceId: "src-shor",
    });
    expect(hits.some((hit) => hit.filename === NOTES)).toBe(false);
  });

  it("skips binary files without an extracted text layer", async () => {
    const hits = await searchRawSources(wikiPath, db, "scan");
    expect(hits.some((hit) => hit.filename === SCAN)).toBe(false);
  });
});
