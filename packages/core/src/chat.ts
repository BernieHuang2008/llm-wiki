import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

import { DEFAULT_MODELS, estimateCostCents, type LlmClient } from "@llm-wiki/llm";
import matter from "gray-matter";

import { loadWikiSettings } from "./config";
import type { Db } from "./db";
import {
  deleteChat as deleteChatRow,
  getChat,
  insertChat,
  listChatRows,
  updateChat,
} from "./db-chats";
import {
  ChatAgentAbortedError,
  runChatAgent,
  type ChatAgentEvent,
  type ChatAgentTrace,
} from "./chat-agent";
import { insertUsage } from "./db-usage";
import { buildChatAgentSystemPrompt } from "./prompts/chat";
import type { ChatRow } from "./types";
import { readIndex, readSchema, WIKI_PATHS } from "./wiki";
import { withWriteLock } from "./write-lock";

export const DEFAULT_CHAT_FOLDERS = ["inbox", "pinned", "archive"] as const;
const TRASH_DIR = "trash/chats";

// ---- file <-> structure --------------------------------------------------

export type ChatMessage = {
  role: "user" | "assistant";
  /** HH:MM:SS local time as written by the app. */
  time: string;
  content: string;
  /** Agent reasoning and tool calls, encoded into the chat file as a comment. */
  trace?: ChatAgentTrace;
};

export type ChatFile = {
  row: ChatRow;
  messages: ChatMessage[];
};

function chatPath(wikiPath: string, folder: string, filename: string): string {
  return join(wikiPath, WIKI_PATHS.chats, folder, filename);
}

function nowFilenamePrefix(): { date: string; hhmm: string } {
  const d = new Date();
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

function nowHms(): string {
  const d = new Date();
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

// ---- create --------------------------------------------------------------

export type CreateChatOptions = {
  folder?: string;
  title?: string;
  model: string;
  tags?: string[];
};

export async function createChat(
  wikiPath: string,
  db: Db,
  opts: CreateChatOptions,
): Promise<ChatRow> {
  const folder = opts.folder ?? "inbox";
  const title = (opts.title ?? "Untitled chat").trim() || "Untitled chat";
  const id = randomUUID();
  const { date, hhmm } = nowFilenamePrefix();
  const filename = `${date}-${hhmm}-${slugify(title)}.md`;
  const folderDir = join(wikiPath, WIKI_PATHS.chats, folder);
  await mkdir(folderDir, { recursive: true });

  const createdIso = new Date().toISOString();
  const frontmatter = {
    id,
    title,
    folder,
    created: createdIso,
    updated: createdIso,
    model: opts.model,
    pinned: false,
    message_count: 0,
    ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
  };
  const body = matter.stringify("", frontmatter as unknown as Record<string, unknown>);
  await writeFile(join(folderDir, filename), body, "utf8");

  const row: ChatRow = {
    id,
    filename,
    folder,
    title,
    created_at: createdIso,
    updated_at: createdIso,
    pinned: false,
    message_count: 0,
  };
  insertChat(db, row);
  return row;
}

// ---- read ----------------------------------------------------------------

export async function readChat(wikiPath: string, chatId: string, db: Db): Promise<ChatFile> {
  const row = getChat(db, chatId);
  if (!row) throw chatNotFound(chatId);
  const raw = await readFile(chatPath(wikiPath, row.folder, row.filename), "utf8");
  const parsed = matter(raw);
  const messages = parseMessages(parsed.content);
  return { row, messages };
}

const MESSAGE_HEADER_RE = /^##\s+(user|assistant)\s+\[(\d{2}:\d{2}:\d{2})\]\s*$/i;
const TRACE_RE = /^<!--llm-wiki-trace:([A-Za-z0-9+/=]+)-->\r?\n?/;
const MAX_PERSISTED_THINKING = 32_000;

function encodeTrace(trace: ChatAgentTrace): string {
  const trimmed: ChatAgentTrace = {
    ...trace,
    thinking:
      trace.thinking.length > MAX_PERSISTED_THINKING
        ? `${trace.thinking.slice(0, MAX_PERSISTED_THINKING)}\n\n[trace truncated]`
        : trace.thinking,
  };
  return `<!--llm-wiki-trace:${Buffer.from(JSON.stringify(trimmed), "utf8").toString("base64")}-->\n`;
}

function decodeTrace(content: string): { content: string; trace?: ChatAgentTrace } {
  const match = content.match(TRACE_RE);
  if (!match?.[1]) return { content };
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as ChatAgentTrace;
    if (typeof parsed.thinking !== "string" || !Array.isArray(parsed.tools)) {
      return { content: content.slice(match[0].length) };
    }
    return { content: content.slice(match[0].length), trace: parsed };
  } catch {
    return { content: content.slice(match[0].length) };
  }
}

function parseMessages(body: string): ChatMessage[] {
  const lines = body.split(/\r?\n/);
  const messages: ChatMessage[] = [];
  let current: ChatMessage | null = null;
  let buf: string[] = [];

  function flush() {
    if (current) {
      const decoded = decodeTrace(buf.join("\n").trim());
      current.content = decoded.content.trim();
      if (decoded.trace) current.trace = decoded.trace;
      messages.push(current);
    }
    buf = [];
    current = null;
  }

  for (const line of lines) {
    const match = line.match(MESSAGE_HEADER_RE);
    if (match) {
      flush();
      current = {
        role: match[1]!.toLowerCase() as ChatMessage["role"],
        time: match[2]!,
        content: "",
      };
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return messages;
}

function serializeMessages(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  const body = messages
    .map((message) => {
      const traceBlock = message.trace ? encodeTrace(message.trace) : "";
      return `## ${message.role} [${message.time}]\n${traceBlock}${message.content}`;
    })
    .join("\n\n");
  return `${body}\n`;
}

// ---- append message ------------------------------------------------------

export async function appendMessage(
  wikiPath: string,
  db: Db,
  chatId: string,
  role: ChatMessage["role"],
  content: string,
  trace?: ChatAgentTrace,
): Promise<{ row: ChatRow; message: ChatMessage }> {
  return withWriteLock(wikiPath, async () => {
    const row = getChat(db, chatId);
    if (!row) throw chatNotFound(chatId);
    const filePath = chatPath(wikiPath, row.folder, row.filename);
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);

    const message: ChatMessage = {
      role,
      time: nowHms(),
      content: content.trim(),
      ...(trace ? { trace } : {}),
    };

    // Rebuild body: keep prior content, append a separator + new message block.
    const trimmedPrior = parsed.content.replace(/\s+$/u, "");
    const sep = trimmedPrior.length > 0 ? "\n\n" : "";
    const traceBlock = trace ? encodeTrace(trace) : "";
    const block = `## ${message.role} [${message.time}]\n${traceBlock}${message.content}\n`;
    const newBody = `${trimmedPrior}${sep}${block}`;

    const updatedIso = new Date().toISOString();
    const newFrontmatter = {
      ...(parsed.data as Record<string, unknown>),
      updated: updatedIso,
      message_count: row.message_count + 1,
    };
    const out = matter.stringify(newBody, newFrontmatter);
    await writeFile(filePath, out, "utf8");

    const nextRow: ChatRow = {
      ...row,
      updated_at: updatedIso,
      message_count: row.message_count + 1,
    };
    updateChat(db, nextRow);
    return { row: nextRow, message };
  });
}

/**
 * Removes one message by its position in the thread, then rewrites the chat
 * file from the remaining messages. Index-based because the markdown format
 * has no per-message id; the UI always passes the index it rendered.
 */
export async function deleteChatMessage(
  wikiPath: string,
  db: Db,
  chatId: string,
  index: number,
): Promise<{ row: ChatRow; messages: ChatMessage[]; deleted: ChatMessage }> {
  return withWriteLock(wikiPath, async () => {
    const row = getChat(db, chatId);
    if (!row) throw chatNotFound(chatId);
    const filePath = chatPath(wikiPath, row.folder, row.filename);
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const messages = parseMessages(parsed.content);

    if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
      throw new Error(`deleteChatMessage: message index out of range: ${index}`);
    }

    const deleted = messages[index]!;
    const remaining = messages.filter((_, i) => i !== index);
    const updatedIso = new Date().toISOString();
    const newFrontmatter = {
      ...(parsed.data as Record<string, unknown>),
      updated: updatedIso,
      message_count: remaining.length,
    };

    await writeFile(
      filePath,
      matter.stringify(serializeMessages(remaining), newFrontmatter),
      "utf8",
    );

    const nextRow: ChatRow = {
      ...row,
      updated_at: updatedIso,
      message_count: remaining.length,
    };
    updateChat(db, nextRow);
    return { row: nextRow, messages: remaining, deleted };
  });
}

// ---- rename / move / pin / delete ----------------------------------------

export async function renameChat(
  wikiPath: string,
  db: Db,
  chatId: string,
  newTitle: string,
): Promise<ChatRow> {
  const cleanTitle = newTitle.trim();
  if (!cleanTitle) throw new Error("renameChat: newTitle must be non-empty");
  const row = getChat(db, chatId);
  if (!row) throw chatNotFound(chatId);

  // Update frontmatter `title` only; we keep the timestamped filename for
  // stable sort order even after a rename.
  const filePath = chatPath(wikiPath, row.folder, row.filename);
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const newFrontmatter = { ...(parsed.data as Record<string, unknown>), title: cleanTitle };
  await writeFile(filePath, matter.stringify(parsed.content, newFrontmatter), "utf8");

  const nextRow: ChatRow = { ...row, title: cleanTitle };
  updateChat(db, nextRow);
  return nextRow;
}

export async function moveChat(
  wikiPath: string,
  db: Db,
  chatId: string,
  newFolder: string,
): Promise<ChatRow> {
  const folder = newFolder.trim();
  if (!folder) throw new Error("moveChat: newFolder must be non-empty");
  const row = getChat(db, chatId);
  if (!row) throw chatNotFound(chatId);
  if (folder === row.folder) return row;

  const src = chatPath(wikiPath, row.folder, row.filename);
  const destDir = join(wikiPath, WIKI_PATHS.chats, folder);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, row.filename);
  await rename(src, dest);

  // Update frontmatter `folder` to keep file + DB consistent.
  const raw = await readFile(dest, "utf8");
  const parsed = matter(raw);
  const newFrontmatter = { ...(parsed.data as Record<string, unknown>), folder };
  await writeFile(dest, matter.stringify(parsed.content, newFrontmatter), "utf8");

  const nextRow: ChatRow = { ...row, folder };
  updateChat(db, nextRow);
  return nextRow;
}

export async function pinChat(
  wikiPath: string,
  db: Db,
  chatId: string,
  pinned: boolean,
): Promise<ChatRow> {
  const row = getChat(db, chatId);
  if (!row) throw chatNotFound(chatId);
  const filePath = chatPath(wikiPath, row.folder, row.filename);
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const newFrontmatter = { ...(parsed.data as Record<string, unknown>), pinned };
  await writeFile(filePath, matter.stringify(parsed.content, newFrontmatter), "utf8");

  const nextRow: ChatRow = { ...row, pinned };
  updateChat(db, nextRow);
  return nextRow;
}

export async function deleteChat(
  wikiPath: string,
  db: Db,
  chatId: string,
): Promise<{ trashedPath: string }> {
  const row = getChat(db, chatId);
  if (!row) throw chatNotFound(chatId);
  const src = chatPath(wikiPath, row.folder, row.filename);
  const trashDir = join(wikiPath, WIKI_PATHS.tooling, TRASH_DIR);
  await mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(trashDir, `${stamp}-${basename(src)}`);
  await rename(src, dest);
  deleteChatRow(db, chatId);
  return { trashedPath: dest };
}

// ---- list folders --------------------------------------------------------

export async function listChatFolders(wikiPath: string): Promise<string[]> {
  const chatsDir = join(wikiPath, WIKI_PATHS.chats);
  try {
    const entries = await readdir(chatsDir, { withFileTypes: true });
    const fromDisk = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const set = new Set<string>([...DEFAULT_CHAT_FOLDERS, ...fromDisk]);
    return Array.from(set).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [...DEFAULT_CHAT_FOLDERS];
    throw err;
  }
}

// ---- LLM round-trip ------------------------------------------------------

export type SendChatMessageOptions = {
  wikiPath: string;
  db: Db;
  chatId: string;
  userMessage: string;
  client: LlmClient;
  /** Override the chat's saved model for this turn only. */
  modelOverride?: string;
  /**
   * Background-task path: a preceding HTTP request already appended the user
   * turn (so the UI could show it immediately) and the executor only needs the
   * assistant reply. Without this the message would be written twice.
   */
  skipUserAppend?: boolean;
  /**
   * Liveness hook only. The reply is still persisted in one write after the
   * stream ends, so a half-finished answer can never land in the chat file —
   * viewers get the text, the file gets the finished answer.
   */
  onDelta?: (delta: string) => void;
  /** Reasoning, tool-call and content events from the agent loop. */
  onEvent?: (event: ChatAgentEvent) => void;
  /** Aborts the turn; the user's Stop button is wired to this. */
  signal?: AbortSignal;
};

export type SendChatMessageResult = {
  row: ChatRow;
  user: ChatMessage;
  assistant: ChatMessage;
  modelUsed: string;
};

export async function sendChatMessage(
  opts: SendChatMessageOptions,
): Promise<SendChatMessageResult> {
  const before = getChat(opts.db, opts.chatId);
  if (!before) throw chatNotFound(opts.chatId);
  const model = opts.modelOverride ?? (await readChatModel(opts.wikiPath, before));

  // Per-operation round budget from Settings → Models. A missing/unreadable
  // settings file falls back to the agent's own default. `-1` = unlimited.
  let maxSteps: number | undefined;
  try {
    maxSteps = (await loadWikiSettings(opts.wikiPath)).defaultModels.chat.maxRounds;
  } catch {
    // fallback to runChatAgent's default
  }

  // 1. Persist the user's turn first so a mid-call failure doesn't lose their
  // input. Skipped when the route already recorded it.
  const userAppend = opts.skipUserAppend
    ? null
    : await appendMessage(opts.wikiPath, opts.db, opts.chatId, "user", opts.userMessage);

  // 2. Build context. Re-read the chat to get the full message history.
  const chat = await readChat(opts.wikiPath, opts.chatId, opts.db);
  const [schema, index] = await Promise.all([
    readSchemaOrDefault(opts.wikiPath),
    readIndexOrDefault(opts.wikiPath),
  ]);
  const system = buildChatAgentSystemPrompt({ schema, index });

  // 3. Agent loop. The model decides which wiki/raw tools to call; the loop
  // executes them and sends results back until it produces a final answer.
  let result: Awaited<ReturnType<typeof runChatAgent>> | undefined;
  try {
    result = await runChatAgent({
      wikiPath: opts.wikiPath,
      db: opts.db,
      client: opts.client,
      model,
      system,
      messages: chat.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onEvent: (event) => {
        if (event.type === "content" && opts.onDelta) opts.onDelta(event.text);
        opts.onEvent?.(event);
      },
    });
  } catch (err) {
    // A stopped turn keeps whatever the model already produced, so the trace
    // and partial answer do not vanish from the thread when the user hits Stop.
    if (err instanceof ChatAgentAbortedError) {
      const partial = err.partialText.trim();
      const hasTrace = err.trace.thinking.trim().length > 0 || err.trace.tools.length > 0;
      if (partial.length > 0 || hasTrace) {
        await appendMessage(
          opts.wikiPath,
          opts.db,
          opts.chatId,
          "assistant",
          partial.length > 0 ? partial : "（已停止生成）",
          err.trace,
        );
      }
    }
    throw err;
  }
  if (!result) throw new Error("chat agent returned no result");

  insertUsage(opts.db, {
    operation: "chat",
    model: result.model,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    cost_cents: estimateCostCents(
      result.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
    ),
    created_at: new Date().toISOString(),
  });

  // 4. Persist assistant reply.
  const assistantAppend = await appendMessage(
    opts.wikiPath,
    opts.db,
    opts.chatId,
    "assistant",
    result.text,
    result.trace,
  );

  const userMessage = userAppend
    ? userAppend.message
    : (chat.messages.filter((m) => m.role === "user").at(-1) ?? {
        role: "user" as const,
        time: new Date().toISOString(),
        content: opts.userMessage,
      });

  return {
    row: assistantAppend.row,
    user: userMessage,
    assistant: assistantAppend.message,
    modelUsed: result.model,
  };
}

/**
 * Writes just the user half of a turn. The background-task route calls this
 * before enqueueing so the message appears in the thread instantly; the
 * executor later appends the reply with `skipUserAppend`.
 */
export async function appendUserTurn(
  wikiPath: string,
  db: Db,
  chatId: string,
  message: string,
): Promise<ChatMessage> {
  if (!getChat(db, chatId)) throw chatNotFound(chatId);
  const appended = await appendMessage(wikiPath, db, chatId, "user", message);
  return appended.message;
}

async function readChatModel(wikiPath: string, row: ChatRow): Promise<string> {
  // Per docs/07 the chat file frontmatter carries the model. Fall back to the
  // wiki's current query model — never a hardcoded slug, since providers
  // retire models and a stale literal here would silently break every chat.
  let settings;
  try {
    settings = await loadWikiSettings(wikiPath);
  } catch {
    // fallback
  }

  try {
    const raw = await readFile(chatPath(wikiPath, row.folder, row.filename), "utf8");
    const data = matter(raw).data as { model?: string };
    if (typeof data.model === "string" && data.model.length > 0) {
      const provider = settings?.defaultModels.chat.provider;
      const isOllama = provider === "ollama";
      const isORModel = data.model.includes("/");
      if (isOllama && isORModel) {
        // Skip OpenRouter model configuration from frontmatter when using Ollama
      } else if (provider === "openrouter" && !isORModel) {
        // Skip local Ollama model configuration from frontmatter when using OpenRouter
      } else {
        return data.model;
      }
    }
  } catch {
    // fall through
  }
  if (settings) {
    return settings.defaultModels.chat.model;
  }
  return DEFAULT_MODELS.chat;
}

async function readSchemaOrDefault(wikiPath: string): Promise<string> {
  try {
    return await readSchema(wikiPath);
  } catch {
    return "(no schema set yet)";
  }
}

async function readIndexOrDefault(wikiPath: string): Promise<string> {
  try {
    return await readIndex(wikiPath);
  } catch {
    return "(no index yet)";
  }
}

// ---- listing -------------------------------------------------------------

export function listChats(db: Db, folder?: string): ChatRow[] {
  return listChatRows(db, folder);
}

// ---- trash maintenance ---------------------------------------------------

const DEFAULT_TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Removes files in `.llm-wiki/trash/**` older than maxAgeMs. Scans every
 * subdirectory under `.llm-wiki/trash/` (chats, wiki, raw, anything future
 * deletes might add). Tolerant of missing trash directories (returns 0).
 * Returns the total number of files deleted across all subdirs.
 */
export async function purgeOldTrash(
  wikiPath: string,
  maxAgeMs: number = DEFAULT_TRASH_TTL_MS,
): Promise<number> {
  const rootTrash = join(wikiPath, WIKI_PATHS.tooling, "trash");
  const { readdir, stat: statFs, unlink } = await import("node:fs/promises");
  let subdirs: string[];
  try {
    const entries = await readdir(rootTrash, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const sub of subdirs) {
    const dir = join(rootTrash, sub);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      const p = join(dir, name);
      try {
        const s = await statFs(p);
        if (s.isFile() && s.mtimeMs < cutoff) {
          await unlink(p);
          removed++;
        }
      } catch {
        // entry vanished between readdir and stat; skip
      }
    }
  }
  return removed;
}

// ---- helpers -------------------------------------------------------------

class ChatNotFoundError extends Error {
  override readonly name = "ChatNotFoundError";
  readonly id: string;
  constructor(id: string) {
    super(`chat not found: ${id}`);
    this.id = id;
  }
}

function chatNotFound(id: string): ChatNotFoundError {
  return new ChatNotFoundError(id);
}

// re-export for callers
export { stat };
