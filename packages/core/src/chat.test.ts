import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "@llm-wiki/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendMessage,
  createChat,
  deleteChat,
  deleteChatMessage,
  listChatFolders,
  listChats,
  moveChat,
  pinChat,
  purgeOldTrash,
  readChat,
  renameChat,
  sendChatMessage,
} from "./chat";
import { openInMemoryDb, type Db } from "./db";
import { initWikiFolder, WIKI_PATHS } from "./wiki";

let wikiPath: string;
let db: Db;

beforeEach(async () => {
  wikiPath = await mkdtemp(join(tmpdir(), "llm-wiki-chat-test-"));
  await initWikiFolder(wikiPath);
  db = openInMemoryDb();
});

afterEach(async () => {
  db.close();
  await rm(wikiPath, { recursive: true, force: true });
});

describe("createChat + readChat", () => {
  it("creates a chat file with frontmatter and registers it in DB", async () => {
    const row = await createChat(wikiPath, db, {
      folder: "inbox",
      title: "Error correction",
      model: "anthropic/claude-3-5-sonnet",
    });
    expect(row.title).toBe("Error correction");
    expect(row.folder).toBe("inbox");
    expect(row.filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-error-correction\.md$/);
    expect(row.message_count).toBe(0);

    const filePath = join(wikiPath, WIKI_PATHS.chats, "inbox", row.filename);
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("title: Error correction");
    expect(raw).toContain("folder: inbox");
    expect(raw).toContain(`id: ${row.id}`);

    const chat = await readChat(wikiPath, row.id, db);
    expect(chat.messages).toEqual([]);
  });

  it("defaults the folder to inbox and title to 'Untitled chat'", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model" });
    expect(row.folder).toBe("inbox");
    expect(row.title).toBe("Untitled chat");
  });
});

describe("appendMessage", () => {
  it("appends a user message + assistant message to the file and bumps count", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "T" });
    await appendMessage(wikiPath, db, row.id, "user", "First question");
    const result = await appendMessage(wikiPath, db, row.id, "assistant", "First answer");
    expect(result.row.message_count).toBe(2);

    const chat = await readChat(wikiPath, row.id, db);
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chat.messages[0]?.content).toBe("First question");
    expect(chat.messages[1]?.content).toBe("First answer");
    expect(chat.messages[0]?.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("deleteChatMessage", () => {
  it("removes one message from the file + DB and updates the count", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "T" });
    await appendMessage(wikiPath, db, row.id, "user", "keep first");
    await appendMessage(wikiPath, db, row.id, "assistant", "remove me");
    await appendMessage(wikiPath, db, row.id, "user", "keep last");

    const result = await deleteChatMessage(wikiPath, db, row.id, 1);
    expect(result.deleted.content).toBe("remove me");
    expect(result.row.message_count).toBe(2);

    const chat = await readChat(wikiPath, row.id, db);
    expect(chat.messages.map((m) => m.content)).toEqual(["keep first", "keep last"]);
    expect(chat.row.message_count).toBe(2);

    const raw = await readFile(join(wikiPath, WIKI_PATHS.chats, "inbox", row.filename), "utf8");
    expect(raw).toContain("message_count: 2");
    expect(raw).not.toContain("remove me");
  });

  it("keeps the trace on messages that remain", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "Trace" });
    await appendMessage(wikiPath, db, row.id, "assistant", "with trace", {
      thinking: "thought process",
      tools: [],
    });
    await appendMessage(wikiPath, db, row.id, "user", "delete me");

    await deleteChatMessage(wikiPath, db, row.id, 1);

    const chat = await readChat(wikiPath, row.id, db);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.trace?.thinking).toBe("thought process");
  });

  it("rejects an out-of-range index without touching the file", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "Bounds" });
    await appendMessage(wikiPath, db, row.id, "user", "only message");

    await expect(deleteChatMessage(wikiPath, db, row.id, 5)).rejects.toThrow(/out of range/);

    const chat = await readChat(wikiPath, row.id, db);
    expect(chat.messages.map((m) => m.content)).toEqual(["only message"]);
  });
});

describe("renameChat + moveChat + pinChat", () => {
  it("rename updates frontmatter title + DB row but keeps filename", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "Old" });
    const filenameBefore = row.filename;
    const renamed = await renameChat(wikiPath, db, row.id, "New title");
    expect(renamed.title).toBe("New title");
    expect(renamed.filename).toBe(filenameBefore);
    const raw = await readFile(join(wikiPath, WIKI_PATHS.chats, "inbox", filenameBefore), "utf8");
    expect(raw).toContain("title: New title");
  });

  it("move uses fs.rename + updates folder field on disk and in DB", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "Mover" });
    const moved = await moveChat(wikiPath, db, row.id, "archive");
    expect(moved.folder).toBe("archive");
    await expect(access(join(wikiPath, WIKI_PATHS.chats, "inbox", row.filename))).rejects.toThrow();
    const newPath = join(wikiPath, WIKI_PATHS.chats, "archive", row.filename);
    const raw = await readFile(newPath, "utf8");
    expect(raw).toContain("folder: archive");
  });

  it("move creates the destination folder if it doesn't exist", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "M" });
    await moveChat(wikiPath, db, row.id, "deep-dives");
    const s = await stat(join(wikiPath, WIKI_PATHS.chats, "deep-dives"));
    expect(s.isDirectory()).toBe(true);
  });

  it("pin toggles the frontmatter + DB column", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "P" });
    expect(row.pinned).toBe(false);
    const pinned = await pinChat(wikiPath, db, row.id, true);
    expect(pinned.pinned).toBe(true);
    const raw = await readFile(join(wikiPath, WIKI_PATHS.chats, "inbox", row.filename), "utf8");
    expect(raw).toContain("pinned: true");
  });
});

describe("deleteChat", () => {
  it("moves the file to .llm-wiki/trash/chats/ and removes the DB row", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "Doomed" });
    const r = await deleteChat(wikiPath, db, row.id);
    expect(r.trashedPath.replace(/\\/g, "/")).toContain(".llm-wiki/trash/chats/");
    await expect(access(join(wikiPath, WIKI_PATHS.chats, "inbox", row.filename))).rejects.toThrow();
    expect(listChats(db)).toEqual([]);
  });
});

describe("listChatFolders", () => {
  it("returns default folders even before chats are created", async () => {
    const folders = await listChatFolders(wikiPath);
    expect(folders).toEqual(expect.arrayContaining(["inbox", "pinned", "archive"]));
  });

  it("includes any custom folders created via moveChat", async () => {
    const row = await createChat(wikiPath, db, { model: "any/model", title: "X" });
    await moveChat(wikiPath, db, row.id, "custom-bucket");
    const folders = await listChatFolders(wikiPath);
    expect(folders).toContain("custom-bucket");
  });
});

describe("purgeOldTrash", () => {
  it("returns 0 when the trash dir does not exist", async () => {
    expect(await purgeOldTrash(wikiPath)).toBe(0);
  });

  it("deletes trashed files older than the TTL and leaves recent ones alone", async () => {
    const a = await createChat(wikiPath, db, { model: "m", title: "Old" });
    const b = await createChat(wikiPath, db, { model: "m", title: "Fresh" });
    const trashedA = (await deleteChat(wikiPath, db, a.id)).trashedPath;
    await deleteChat(wikiPath, db, b.id);

    const { utimes, readdir, access } = await import("node:fs/promises");
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(trashedA, sixtyDaysAgo, sixtyDaysAgo);

    const removed = await purgeOldTrash(wikiPath);
    expect(removed).toBe(1);

    const remaining = await readdir(join(wikiPath, ".llm-wiki", "trash", "chats"));
    expect(remaining).toHaveLength(1);
    await expect(access(trashedA)).rejects.toThrow();
  });
});

describe("sendChatMessage", () => {
  it("appends user + assistant turns, records usage, and returns parsed messages", async () => {
    const row = await createChat(wikiPath, db, {
      model: "stub/sonnet",
      title: "Talk",
    });

    // The chat turn runs through the agent loop, which consumes the provider's
    // streaming API. A non-streaming completion object is no longer enough.
    const create = vi.fn(async () =>
      (async function* () {
        yield {
          model: "stub/sonnet",
          choices: [{ delta: { content: "Here's an answer with [[some-page]]." } }],
        };
        yield {
          model: "stub/sonnet",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
        };
      })(),
    );
    const client = { chat: { completions: { create } } } as unknown as LlmClient;

    const r = await sendChatMessage({
      wikiPath,
      db,
      chatId: row.id,
      userMessage: "What's the deal?",
      client,
    });
    expect(r.user.content).toBe("What's the deal?");
    expect(r.assistant.content).toContain("[[some-page]]");
    expect(r.row.message_count).toBe(2);

    const chat = await readChat(wikiPath, row.id, db);
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]?.role).toBe("user");
    expect(chat.messages[1]?.role).toBe("assistant");
  });
});
