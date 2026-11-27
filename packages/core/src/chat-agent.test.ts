import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "@llm-wiki/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChatAgentAbortedError,
  runChatAgent,
  type ChatAgentEvent,
  type ChatWriteApprovalRequest,
} from "./chat-agent";
import { openInMemoryDb, type Db } from "./db";
import { initWikiFolder, readPage, WIKI_PATHS } from "./wiki";

let wikiPath: string;
let db: Db;

beforeEach(async () => {
  wikiPath = await mkdtemp(join(tmpdir(), "llm-wiki-chat-agent-test-"));
  await initWikiFolder(wikiPath);
  await writeFile(
    join(wikiPath, WIKI_PATHS.raw, "note.md"),
    "The magic word is ORANGE-42.\n",
    "utf8",
  );
  db = { prepare: () => ({ all: () => [] }) } as unknown as Db;
});

afterEach(async () => {
  await rm(wikiPath, { recursive: true, force: true });
});

function chunk(value: unknown) {
  return { model: "stub", choices: [{ delta: value }] };
}

function agentClient(steps: Array<AsyncGenerator<unknown>>): LlmClient {
  let index = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const next = steps[index++];
          if (!next) throw new Error("stub client: no step left");
          return next;
        },
      },
    },
  } as unknown as LlmClient;
}

describe("runChatAgent", () => {
  it("executes a tool call and feeds the result into the next model step", async () => {
    const client = agentClient([
      (async function* () {
        yield chunk({ reasoning_content: "I should read the raw note. " });
        yield chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "raw_read", arguments: '{"source":"note.md"}' },
            },
          ],
        });
        yield {
          model: "stub",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      })(),
      (async function* () {
        yield chunk({ content: "The word is ORANGE-42 [raw:note.md]." });
        yield {
          model: "stub",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        };
      })(),
    ]);

    const events: ChatAgentEvent[] = [];
    const result = await runChatAgent({
      wikiPath,
      db,
      client,
      model: "stub",
      system: "test",
      messages: [{ role: "user", content: "what is the magic word?" }],
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toContain("ORANGE-42");
    expect(result.trace.thinking).toContain("read the raw note");
    expect(result.trace.tools).toHaveLength(1);
    expect(result.trace.tools[0]).toMatchObject({ name: "raw_read", status: "ok" });
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 13 });
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("captures reasoning, tool trace and partial text when aborted", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const client = agentClient([
      (async function* () {
        yield chunk({ reasoning_content: "thinking..." });
        yield chunk({ content: "partial answer" });
        throw abortError;
      })(),
    ]);

    let caught: unknown;
    try {
      await runChatAgent({
        wikiPath,
        db,
        client,
        model: "stub",
        system: "test",
        messages: [{ role: "user", content: "q" }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChatAgentAbortedError);
    const aborted = caught as ChatAgentAbortedError;
    expect(aborted.trace.thinking).toContain("thinking");
    expect(aborted.partialText).toBe("partial answer");
  });

  it("asks approval once for the first write and then writes freely within the turn", async () => {
    const localDb = openInMemoryDb();
    try {
      const client = agentClient([
        toolCallStep(
          "wiki_create_page",
          {
            slug: "first-page",
            title: "First",
            type: "concept",
            content: "First body.\n",
          },
          "call_1",
        ),
        toolCallStep(
          "wiki_create_page",
          {
            slug: "second-page",
            title: "Second",
            type: "concept",
            content: "Second body.\n",
          },
          "call_2",
        ),
        answerStep("Created both pages."),
      ]);
      const approvals: ChatWriteApprovalRequest[] = [];

      const result = await runChatAgent({
        wikiPath,
        db: localDb,
        client,
        model: "stub",
        system: "test",
        messages: [{ role: "user", content: "add two pages" }],
        requestWriteApproval: async (request) => {
          approvals.push(request);
          return true;
        },
      });

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ toolName: "wiki_create_page" });
      expect((await readPage(wikiPath, "first-page")).content).toContain("First body.");
      expect((await readPage(wikiPath, "second-page")).content).toContain("Second body.");
      expect(result.trace.tools.filter((tool) => tool.status === "ok")).toHaveLength(2);
    } finally {
      localDb.close();
    }
  });

  it("denies every write in the turn after the first request is declined", async () => {
    const localDb = openInMemoryDb();
    try {
      const client = agentClient([
        toolCallStep(
          "wiki_create_page",
          {
            slug: "denied-page",
            title: "Denied",
            type: "concept",
            content: "Nope.\n",
          },
          "call_1",
        ),
        toolCallStep(
          "wiki_create_page",
          {
            slug: "also-denied",
            title: "Also denied",
            type: "concept",
            content: "Nope.\n",
          },
          "call_2",
        ),
        answerStep("Here is the proposed page instead."),
      ]);
      const approvals: ChatWriteApprovalRequest[] = [];

      const result = await runChatAgent({
        wikiPath,
        db: localDb,
        client,
        model: "stub",
        system: "test",
        messages: [{ role: "user", content: "add a page" }],
        requestWriteApproval: async (request) => {
          approvals.push(request);
          return false;
        },
      });

      expect(approvals).toHaveLength(1);
      await expect(access(join(wikiPath, WIKI_PATHS.wiki, "denied-page.md"))).rejects.toThrow();
      await expect(access(join(wikiPath, WIKI_PATHS.wiki, "also-denied.md"))).rejects.toThrow();
      expect(result.text).toContain("proposed page");
      expect(result.trace.tools.every((tool) => tool.status === "error")).toBe(true);
    } finally {
      localDb.close();
    }
  });
});

function toolCallStep(
  name: string,
  args: Record<string, unknown>,
  id: string,
): AsyncGenerator<unknown> {
  return (async function* () {
    yield chunk({
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    yield {
      model: "stub",
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  })();
}

function answerStep(text: string): AsyncGenerator<unknown> {
  return (async function* () {
    yield chunk({ content: text });
    yield {
      model: "stub",
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  })();
}
