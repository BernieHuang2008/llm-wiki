import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteChat,
  getChat,
  insertChat,
  listChatRows,
  updateChat,
} from "./db-chats";
import {
  deletePage,
  getPage,
  indexPageForSearch,
  insertPage,
  linkPageSource,
  listPageRows,
  listSourceIdsForPage,
  searchPages,
  updatePage,
  upsertPage,
} from "./db-pages";
import {
  deleteSource,
  getSource,
  insertSource,
  listSourceRows,
  updateSource,
} from "./db-sources";
import {
  getTotalCostCents,
  getUsageBreakdown,
  insertUsage,
  listUsageRows,
} from "./db-usage";
import { META_DB_FILENAME, openDb, openInMemoryDb, runMigrations, type Db } from "./db";
import { countRuns, getRun, listRuns, recordRun } from "./db-runs";
import {
  claimNextTask,
  createTask,
  failTask,
  finishTask,
  getTask,
  listActiveTasks,
  listTasksForSource,
  markStuckIngestTasksAsFailed,
  recoverInterruptedTasks,
  requeueTask,
} from "./tasks";
import type { ChatRow, PageRow, SourceRow } from "./types";
import { WIKI_PATHS } from "./wiki";

const ALL_TABLES = [
  "sources",
  "pages",
  "pages_fts",
  "page_sources",
  "chats",
  "usage",
  "response_cache",
  "tasks",
  "run_history",
];

function tableNames(db: Db): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("runMigrations", () => {
  it("creates all 7 docs/03 tables on an empty DB", () => {
    const db = openInMemoryDb();
    const names = tableNames(db);
    for (const t of ALL_TABLES) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("is idempotent — re-running does not throw or duplicate", () => {
    const db = openInMemoryDb();
    runMigrations(db);
    runMigrations(db);
    const names = tableNames(db);
    for (const t of ALL_TABLES) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("enables foreign keys (PRAGMA foreign_keys = ON)", () => {
    const db = openInMemoryDb();
    const row = db.pragma("foreign_keys", { simple: true });
    expect(row).toBe(1);
    db.close();
  });
});

describe("openDb (real filesystem)", () => {
  let wikiPath: string;

  beforeEach(async () => {
    wikiPath = await mkdtemp(join(tmpdir(), "llm-wiki-db-test-"));
  });

  afterEach(async () => {
    await rm(wikiPath, { recursive: true, force: true });
  });

  it("creates .llm-wiki/meta.sqlite on first open and runs migrations", async () => {
    const db = openDb(wikiPath);
    db.close();
    const s = await stat(join(wikiPath, WIKI_PATHS.tooling, META_DB_FILENAME));
    expect(s.isFile()).toBe(true);
    const db2 = openDb(wikiPath);
    expect(tableNames(db2)).toContain("pages");
    db2.close();
  });
});

describe("pages CRUD", () => {
  let db: Db;
  beforeEach(() => {
    db = openInMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  const sample: PageRow = {
    slug: "shors-algorithm",
    title: "Shor's Algorithm",
    type: "concept",
    created_at: "2026-04-15",
    updated_at: "2026-05-23",
    word_count: 312,
    tags: ["quantum", "algorithm"],
  };

  it("round-trips a row with tags serialized as JSON", () => {
    insertPage(db, sample);
    const got = getPage(db, sample.slug);
    expect(got).toEqual(sample);
  });

  it("getPage returns null for missing slug", () => {
    expect(getPage(db, "nope")).toBeNull();
  });

  it("updatePage updates fields and throws when slug is missing", () => {
    insertPage(db, sample);
    updatePage(db, { ...sample, word_count: 999, tags: ["quantum"] });
    const got = getPage(db, sample.slug);
    expect(got?.word_count).toBe(999);
    expect(got?.tags).toEqual(["quantum"]);
    expect(() => updatePage(db, { ...sample, slug: "ghost" })).toThrow(/no row with slug/);
  });

  it("upsertPage inserts or updates depending on existence", () => {
    upsertPage(db, sample);
    expect(getPage(db, sample.slug)?.word_count).toBe(312);
    upsertPage(db, { ...sample, word_count: 42 });
    expect(getPage(db, sample.slug)?.word_count).toBe(42);
  });

  it("deletePage removes the row", () => {
    insertPage(db, sample);
    deletePage(db, sample.slug);
    expect(getPage(db, sample.slug)).toBeNull();
  });

  it("listPageRows returns rows sorted by slug", () => {
    insertPage(db, { ...sample, slug: "zeta", title: "Zeta" });
    insertPage(db, { ...sample, slug: "alpha", title: "Alpha" });
    const rows = listPageRows(db);
    expect(rows.map((r) => r.slug)).toEqual(["alpha", "zeta"]);
  });
});

describe("sources CRUD", () => {
  let db: Db;
  beforeEach(() => {
    db = openInMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  const sample: SourceRow = {
    id: "src-001",
    filename: "2026-04-15-shor.pdf",
    original_name: "Shor_1994.pdf",
    format: "pdf",
    size_bytes: 184_320,
    added_at: "2026-04-15T10:00:00Z",
    ingested_at: null,
    url: null,
    title: "Shor 1994",
    ingest_error: null,
  };

  it("round-trips and exposes nullable fields", () => {
    insertSource(db, sample);
    expect(getSource(db, sample.id)).toEqual(sample);
  });

  it("updateSource fails loudly on missing id", () => {
    expect(() => updateSource(db, sample)).toThrow(/no row with id/);
  });

  it("deleteSource removes the row", () => {
    insertSource(db, sample);
    deleteSource(db, sample.id);
    expect(getSource(db, sample.id)).toBeNull();
  });

  it("listSourceRows returns all rows", () => {
    insertSource(db, sample);
    insertSource(db, { ...sample, id: "src-002", added_at: "2026-04-16T10:00:00Z" });
    expect(listSourceRows(db)).toHaveLength(2);
  });
});

describe("page_sources cascading FK", () => {
  it("deletes link rows when the page is deleted", () => {
    const db = openInMemoryDb();
    insertPage(db, {
      slug: "p",
      title: "P",
      type: "concept",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      word_count: 1,
      tags: [],
    });
    insertSource(db, {
      id: "s",
      filename: "f",
      original_name: null,
      format: "md",
      size_bytes: 1,
      added_at: "2026-01-01",
      ingested_at: null,
      url: null,
      title: null,
      ingest_error: null,
    });
    linkPageSource(db, "p", "s");
    expect(listSourceIdsForPage(db, "p")).toEqual(["s"]);
    deletePage(db, "p");
    expect(listSourceIdsForPage(db, "p")).toEqual([]);
    db.close();
  });
});

describe("chats CRUD", () => {
  let db: Db;
  beforeEach(() => {
    db = openInMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  const sample: ChatRow = {
    id: "c-001",
    filename: "2026-05-23-1430-error-correction.md",
    folder: "inbox",
    title: "Error correction approaches",
    created_at: "2026-05-23T14:30:00Z",
    updated_at: "2026-05-23T15:12:00Z",
    pinned: false,
    message_count: 6,
  };

  it("round-trips pinned as boolean", () => {
    insertChat(db, sample);
    expect(getChat(db, sample.id)).toEqual(sample);
    updateChat(db, { ...sample, pinned: true });
    expect(getChat(db, sample.id)?.pinned).toBe(true);
  });

  it("listChatRows sorts pinned first then by updated_at desc", () => {
    insertChat(db, { ...sample, id: "old", pinned: false, updated_at: "2026-05-20T00:00:00Z" });
    insertChat(db, { ...sample, id: "new", pinned: false, updated_at: "2026-05-23T00:00:00Z" });
    insertChat(db, { ...sample, id: "pin", pinned: true, updated_at: "2026-05-19T00:00:00Z" });
    const rows = listChatRows(db);
    expect(rows.map((r) => r.id)).toEqual(["pin", "new", "old"]);
  });

  it("listChatRows can filter by folder", () => {
    insertChat(db, { ...sample, id: "a", folder: "inbox" });
    insertChat(db, { ...sample, id: "b", folder: "archive" });
    expect(listChatRows(db, "archive").map((r) => r.id)).toEqual(["b"]);
  });

  it("deleteChat removes the row", () => {
    insertChat(db, sample);
    deleteChat(db, sample.id);
    expect(getChat(db, sample.id)).toBeNull();
  });
});

describe("usage", () => {
  it("inserts return the autoincrement id and totals sum cost_cents", () => {
    const db = openInMemoryDb();
    const id1 = insertUsage(db, {
      operation: "ingest",
      model: "anthropic/claude-3-5-haiku",
      input_tokens: 1200,
      output_tokens: 300,
      cost_cents: 0.5,
      created_at: "2026-05-23T14:30:00Z",
    });
    const id2 = insertUsage(db, {
      operation: "query",
      model: "anthropic/claude-3-5-sonnet",
      input_tokens: 800,
      output_tokens: 200,
      cost_cents: 1.25,
      created_at: "2026-05-23T14:45:00Z",
    });
    expect(id2).toBeGreaterThan(id1);
    expect(getTotalCostCents(db)).toBeCloseTo(1.75);
    const rows = listUsageRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.operation).toBe("query");
    db.close();
  });

  it("getUsageBreakdown groups by (model, operation) with token + cost totals", () => {
    const db = openInMemoryDb();
    insertUsage(db, {
      operation: "ingest",
      model: "anthropic/claude-3-5-haiku",
      input_tokens: 1000,
      output_tokens: 200,
      cost_cents: 0.5,
      created_at: "2026-05-23T14:30:00Z",
    });
    insertUsage(db, {
      operation: "ingest",
      model: "anthropic/claude-3-5-haiku",
      input_tokens: 500,
      output_tokens: 100,
      cost_cents: 0.25,
      created_at: "2026-05-23T14:35:00Z",
    });
    insertUsage(db, {
      operation: "query",
      model: "anthropic/claude-3-5-sonnet",
      input_tokens: 9000,
      output_tokens: 800,
      cost_cents: 5.0,
      created_at: "2026-05-23T14:40:00Z",
    });
    const rows = getUsageBreakdown(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe("anthropic/claude-3-5-sonnet");
    expect(rows[0]?.total_input_tokens).toBe(9000);
    expect(rows[0]?.call_count).toBe(1);
    expect(rows[1]?.call_count).toBe(2);
    expect(rows[1]?.total_input_tokens).toBe(1500);
    expect(rows[1]?.total_cost_cents).toBeCloseTo(0.75);
    db.close();
  });
});

describe("pages_fts search", () => {
  it("returns a matching page after indexing", () => {
    const db = openInMemoryDb();
    indexPageForSearch(db, {
      slug: "shors-algorithm",
      title: "Shor's Algorithm",
      content:
        "A quantum algorithm for integer factorization in polynomial time. Discovered by Peter Shor.",
      tags: ["quantum", "algorithm"],
    });
    indexPageForSearch(db, {
      slug: "grover",
      title: "Grover's Algorithm",
      content: "An unstructured search quantum algorithm with quadratic speedup.",
      tags: ["quantum", "search"],
    });

    const hits = searchPages(db, "factorization");
    expect(hits.map((h) => h.slug)).toContain("shors-algorithm");
    expect(hits.find((h) => h.slug === "shors-algorithm")?.snippet).toMatch(/\[factorization\]/);

    const both = searchPages(db, "quantum");
    expect(both.map((h) => h.slug).sort()).toEqual(["grover", "shors-algorithm"]);
    db.close();
  });

  it("re-indexing the same slug replaces prior content (no dupes)", () => {
    const db = openInMemoryDb();
    indexPageForSearch(db, { slug: "p", title: "P", content: "first", tags: [] });
    indexPageForSearch(db, { slug: "p", title: "P", content: "second", tags: [] });
    expect(searchPages(db, "first")).toEqual([]);
    expect(searchPages(db, "second").map((h) => h.slug)).toEqual(["p"]);
    db.close();
  });
});

describe("background tasks", () => {
  let db: Db;
  beforeEach(() => {
    db = openInMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  it("creates a pending task and parses its JSON payload back", () => {
    const task = createTask(db, "/tmp/wiki", "query", { question: "什么是量子纠缠？" });
    expect(task.status).toBe("pending");
    expect(task.source_id).toBeNull();

    const read = getTask(db, task.id);
    expect(read?.kind).toBe("query");
    expect((read?.input as { question?: string }).question).toBe("什么是量子纠缠？");
  });

  it("links ingest tasks to their source row", () => {
    const task = createTask(db, "/tmp/wiki", "ingest_file", {
      sourceId: "src-1",
      filename: "a.pdf",
      title: "A",
      sizeBytes: 10,
    });
    expect(task.source_id).toBe("src-1");
    expect(listTasksForSource(db, "src-1").map((t) => t.id)).toEqual([task.id]);
  });

  it("claims the oldest pending task exactly once", () => {
    const first = createTask(db, "/tmp/wiki", "query", { question: "one" });
    createTask(db, "/tmp/wiki", "query", { question: "two" });

    const claimed = claimNextTask(db);
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    // A second claim must not see the same row again.
    expect(claimNextTask(db)?.id).not.toBe(first.id);
    expect(getTask(db, first.id)?.status).toBe("running");
  });

  it("filters claims by kind so ingest stays on its own lane", () => {
    const query = createTask(db, "/tmp/wiki", "query", { question: "q" });
    const claimed = claimNextTask(db, ["ingest_text"]);
    expect(claimed).toBeNull();
    expect(getTask(db, query.id)?.status).toBe("pending");
  });

  it("finishTask stores the result and clears the active list", () => {
    const task = createTask(db, "/tmp/wiki", "query", { question: "q" });
    claimNextTask(db);
    expect(listActiveTasks(db).map((t) => t.id)).toEqual([task.id]);

    finishTask(db, task.id, { answer: "42" });
    const done = getTask(db, task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.output).toEqual({ answer: "42" });
    expect(listActiveTasks(db)).toEqual([]);
  });

  it("failTask records the reason and the attempt count survives requeue", () => {
    const task = createTask(db, "/tmp/wiki", "ingest_text", {
      sourceId: "src-9",
      title: "T",
    });
    claimNextTask(db);
    requeueTask(db, task.id, "重试中");
    expect(getTask(db, task.id)?.status).toBe("pending");

    claimNextTask(db);
    failTask(db, task.id, "模型返回了无效 JSON");
    const failed = getTask(db, task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("模型返回了无效 JSON");
    expect(failed?.finished_at).not.toBeNull();
  });

  it("recoverInterruptedTasks marks rows left running as interrupted", () => {
    const task = createTask(db, "/tmp/wiki", "chat", { chatId: "c1", message: "hi" });
    claimNextTask(db);
    expect(recoverInterruptedTasks(db)).toBe(1);

    const recovered = getTask(db, task.id);
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.error).toContain("中断");
  });

  it("markStuckIngestTasksAsFailed closes out an unfinished source", () => {
    const task = createTask(db, "/tmp/wiki", "ingest_file", {
      sourceId: "src-7",
      filename: "x.md",
      title: "X",
      sizeBytes: 1,
    });
    claimNextTask(db);
    expect(markStuckIngestTasksAsFailed(db, "src-7", "已被重试取代")).toBe(1);
    const closed = getTask(db, task.id);
    expect(closed?.status).toBe("failed");
    expect(closed?.error).toBe("已被重试取代");
  });
});

describe("run history", () => {
  let db: Db;
  beforeEach(() => {
    db = openInMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  it("round-trips the full output payload", () => {
    const id = recordRun(db, {
      kind: "query",
      label: "什么是量子纠缠？",
      model: "deepseek-flash",
      input: { question: "什么是量子纠缠？" },
      output: { answer: "……", pagesUsed: ["quantum-entanglement"], confidence: "high" },
    });

    const run = getRun(db, id);
    expect(run?.kind).toBe("query");
    expect(run?.label).toBe("什么是量子纠缠？");
    expect((run?.output as { answer?: string }).answer).toBe("……");
    expect((run?.output as { pagesUsed?: string[] }).pagesUsed).toEqual(["quantum-entanglement"]);
  });

  it("lists newest first and filters by kind", () => {
    // Two runs can share a millisecond; insertion order must still decide.
    const q1 = recordRun(db, { kind: "query", label: "first" });
    const l1 = recordRun(db, { kind: "lint", label: "0 issues — excellent" });
    const q2 = recordRun(db, { kind: "query", label: "second" });

    expect(listRuns(db, { kind: "query" }).map((r) => r.id)).toEqual([q2, q1]);
    expect(listRuns(db, { kind: "lint" }).map((r) => r.id)).toEqual([l1]);
    expect(listRuns(db).map((r) => r.id)).toEqual([q2, l1, q1]);
  });

  it("honours the limit and the time window", () => {
    for (let i = 0; i < 5; i++) recordRun(db, { kind: "query", label: `q${i}` });
    expect(listRuns(db, { kind: "query", limit: 2 })).toHaveLength(2);

    // A window that starts in the future excludes everything.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(listRuns(db, { kind: "query", since: future })).toEqual([]);
    expect(countRuns(db, "query", future)).toBe(0);
    expect(countRuns(db, "query")).toBe(5);
  });

  it("keeps a failed run's reason instead of dropping the row", () => {
    const id = recordRun(db, { kind: "lint", label: "失败", error: "模型返回了无效 JSON" });
    expect(getRun(db, id)?.error).toBe("模型返回了无效 JSON");
  });

  it("survives a malformed payload without breaking the list", () => {
    const id = recordRun(db, { kind: "query", label: "broken" });
    db.prepare(`UPDATE run_history SET output = ? WHERE id = ?`).run("{not json", id);
    const rows = listRuns(db, { kind: "query" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.output).toBeNull();
  });

  it("rejects an unknown kind read back from the DB", () => {
    const id = recordRun(db, { kind: "query", label: "x" });
    db.prepare(`UPDATE run_history SET kind = ? WHERE id = ?`).run("bogus", id);
    expect(() => getRun(db, id)).toThrow(/unknown kind/);
  });
});
