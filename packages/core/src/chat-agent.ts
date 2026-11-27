// The built-in chat agent loop.
//
// One user turn is no longer one model call. The model can ask for one or more
// wiki/raw tools, we execute them locally, feed the results back, and repeat
// until it produces a final answer. Every reasoning token and tool call is
// surfaced through `onEvent` so the chat UI can render the process live.

import {
  chatAgentStep,
  type AgentMessage,
  type LlmClient,
  type LlmToolDefinition,
  type LlmUsage,
} from "@llm-wiki/llm";

import {
  AGENT_TOOLS,
  describeAgentWriteTool,
  executeAgentTool,
  isAgentWriteTool,
  type AgentToolContext,
  type AgentToolResult,
} from "./agent-tools";
import type { Db } from "./db";

export type ChatAgentToolTrace = {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
  status: "running" | "ok" | "error";
  summary: string;
  durationMs: number | null;
};

export type ChatAgentTrace = {
  thinking: string;
  tools: ChatAgentToolTrace[];
  /** Most recent agent round reached (1-based). Absent on old persisted traces. */
  round?: number;
};

/** A write tool waiting for the user's explicit permission for this turn. */
export type ChatWriteApprovalRequest = {
  id: string;
  toolName: string;
  /** Human-facing one-liner, e.g. "更新 wiki 页面 [[foo]]". */
  summary: string;
  /** Raw JSON arguments, shown for inspection in the approval prompt. */
  arguments: string;
};

export type ChatAgentEvent =
  | { type: "round"; round: number }
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_call"; tool: ChatAgentToolTrace }
  | { type: "tool_result"; tool: ChatAgentToolTrace }
  | { type: "approval_request"; request: ChatWriteApprovalRequest }
  | { type: "approval_resolved"; id: string; approved: boolean };

export type ChatAgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type RunChatAgentOptions = {
  wikiPath: string;
  db: Db;
  client: LlmClient;
  model: string;
  system: string;
  messages: ChatAgentMessage[];
  signal?: AbortSignal;
  /**
   * Safety valve against a model that keeps calling tools forever. A negative
   * value (conventionally `-1`) means no limit: loop until the model answers or
   * the caller aborts. Omitted falls back to `DEFAULT_MAX_STEPS`.
   */
  maxSteps?: number;
  tools?: readonly LlmToolDefinition[];
  /**
   * Called before the first write tool in a turn. Resolving `true` grants write
   * access for the rest of this turn; `false` denies every later write too.
   * Without a callback, writes are denied rather than silently applied.
   */
  requestWriteApproval?: (request: ChatWriteApprovalRequest) => Promise<boolean>;
  onEvent?: (event: ChatAgentEvent) => void;
};

export type RunChatAgentResult = {
  text: string;
  model: string;
  usage: LlmUsage;
  trace: ChatAgentTrace;
};

const DEFAULT_MAX_STEPS = 8;

/** Thrown when the user's Stop button aborts the turn. Carries the partial run. */
export class ChatAgentAbortedError extends Error {
  override readonly name = "ChatAgentAbortedError";
  override readonly cause?: unknown;
  readonly trace: ChatAgentTrace;
  readonly partialText: string;

  constructor(trace: ChatAgentTrace, partialText: string, cause?: unknown) {
    super("已停止生成");
    this.trace = trace;
    this.partialText = partialText;
    if (cause !== undefined) this.cause = cause;
  }
}

export async function runChatAgent(opts: RunChatAgentOptions): Promise<RunChatAgentResult> {
  const tools = opts.tools ?? AGENT_TOOLS;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const unlimited = maxSteps < 0;
  const toolContext: AgentToolContext = { wikiPath: opts.wikiPath, db: opts.db };
  const trace: ChatAgentTrace = { thinking: "", tools: [] };
  const messages: AgentMessage[] = [
    { role: "system", content: opts.system },
    ...opts.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  let totalUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let lastModel = opts.model;
  let partialText = "";
  // Permission is per turn: the first write in this run asks once, then the
  // rest of the turn inherits the answer. A denial also lasts for the turn.
  let writeDecision: "pending" | "granted" | "denied" = "pending";

  try {
    for (let step = 1; unlimited || step <= maxSteps; step++) {
      opts.signal?.throwIfAborted();
      // Only the current step's content can be a partial final answer.
      partialText = "";
      trace.round = step;
      opts.onEvent?.({ type: "round", round: step });

      const result = await chatAgentStep({
        client: opts.client,
        model: opts.model,
        messages,
        tools: [...tools],
        ...(opts.signal ? { signal: opts.signal } : {}),
        onReasoningDelta: (delta) => {
          trace.thinking += delta;
          opts.onEvent?.({ type: "thinking", text: delta });
        },
        onContentDelta: (delta) => {
          partialText += delta;
        },
      });

      lastModel = result.model;
      totalUsage = {
        inputTokens: totalUsage.inputTokens + result.usage.inputTokens,
        outputTokens: totalUsage.outputTokens + result.usage.outputTokens,
      };

      if (result.toolCalls.length === 0) {
        // Final answer. Content emitted by a tool-calling turn is narration, so
        // only the no-tools turn reaches the answer channel.
        opts.onEvent?.({ type: "content", text: result.text });
        return { text: result.text, model: lastModel, usage: totalUsage, trace };
      }

      if (result.text.trim().length > 0) {
        const narration = result.text.trim();
        const separator = trace.thinking.length > 0 ? "\n\n" : "";
        trace.thinking += `${separator}${narration}`;
        opts.onEvent?.({ type: "thinking", text: `${separator}${narration}` });
      }

      messages.push({
        role: "assistant",
        content: result.text.length > 0 ? result.text : null,
        tool_calls: result.toolCalls,
      });
      // Narration belongs to the trace, not to the answer that a later Stop
      // would persist.
      partialText = "";

      for (const call of result.toolCalls) {
        opts.signal?.throwIfAborted();

        const running: ChatAgentToolTrace = {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          status: "running",
          summary: "执行中…",
          durationMs: null,
        };
        trace.tools.push(running);
        opts.onEvent?.({ type: "tool_call", tool: running });

        const startedAt = Date.now();
        const toolResult = isAgentWriteTool(call.function.name)
          ? await runWriteToolWithApproval({
              name: call.function.name,
              arguments: call.function.arguments,
              callId: call.id,
              decision: writeDecision,
              setDecision: (next) => {
                writeDecision = next;
              },
              ...(opts.requestWriteApproval
                ? { requestWriteApproval: opts.requestWriteApproval }
                : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              onEvent: opts.onEvent,
              context: toolContext,
            })
          : await executeAgentTool(call.function.name, call.function.arguments, toolContext);
        const finished: ChatAgentToolTrace = {
          ...running,
          status: toolResult.ok ? "ok" : "error",
          summary: toolResult.summary,
          durationMs: Date.now() - startedAt,
        };
        trace.tools[trace.tools.length - 1] = finished;
        opts.onEvent?.({ type: "tool_result", tool: finished });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: toolResult.content,
        });
      }
    }
  } catch (err) {
    if (isAbortError(err, opts.signal)) {
      throw new ChatAgentAbortedError(trace, partialText, err);
    }
    throw err;
  }

  throw new Error(
    `工具调用达到 ${maxSteps} 轮仍未给出最终回答。请缩小问题范围或换用支持工具调用的模型。`,
  );
}

type WriteDecision = "pending" | "granted" | "denied";

type RunWriteToolArgs = {
  name: string;
  arguments: string;
  callId: string;
  decision: WriteDecision;
  setDecision: (next: WriteDecision) => void;
  requestWriteApproval?: (request: ChatWriteApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  onEvent?: (event: ChatAgentEvent) => void;
  context: AgentToolContext;
};

/**
 * Enforces the per-turn write gate. The first write asks; later writes reuse
 * the answer. A denial is sticky so a model that keeps retrying cannot turn a
 * "no" into repeated prompts.
 */
async function runWriteToolWithApproval(args: RunWriteToolArgs): Promise<AgentToolResult> {
  if (args.decision === "denied") return writeDeniedResult(args.name);
  if (args.decision === "granted") {
    return executeAgentTool(args.name, args.arguments, args.context);
  }

  if (!args.requestWriteApproval) {
    args.setDecision("denied");
    return writeDeniedResult(args.name, "当前会话未接入写入批准流程");
  }

  const request: ChatWriteApprovalRequest = {
    id: args.callId,
    toolName: args.name,
    summary: describeAgentWriteTool(args.name, args.arguments),
    arguments: args.arguments,
  };
  args.onEvent?.({ type: "approval_request", request });
  args.signal?.throwIfAborted();
  const approved = await args.requestWriteApproval(request);
  args.signal?.throwIfAborted();
  args.setDecision(approved ? "granted" : "denied");
  args.onEvent?.({ type: "approval_resolved", id: request.id, approved });

  return approved
    ? executeAgentTool(args.name, args.arguments, args.context)
    : writeDeniedResult(args.name);
}

function writeDeniedResult(name: string, reason?: string): AgentToolResult {
  const detail = reason ? `（${reason}）` : "";
  return {
    ok: false,
    summary: "用户拒绝了写入",
    content: JSON.stringify({
      error: `用户拒绝了写入 wiki 的请求${detail}。本次提问内不会执行任何写入；不要再尝试写入，直接把建议内容回复给用户。`,
      tool: name,
    }),
  };
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (err as { name?: string } | null)?.name === "AbortError";
}
