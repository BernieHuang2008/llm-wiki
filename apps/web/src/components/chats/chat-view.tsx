"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/wiki/markdown-view";
import { PromoteMessageDialog } from "@/components/chats/promote-message";
import {
  fetchTask,
  findActiveChatTask,
  isActive,
  watchTaskLive,
  type LiveTaskWatch,
} from "@/lib/task-client";
import { cn } from "@/lib/utils";

type ChatRow = {
  id: string;
  filename: string;
  folder: string;
  title: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  message_count: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  time: string;
  content: string;
};

type ChatPayload = { row: ChatRow; messages: ChatMessage[] };

type Props = {
  chatId: string;
  initialChat: ChatPayload;
  knownSlugs: ReadonlyArray<string>;
  folders: ReadonlyArray<string>;
};

export function ChatView({ chatId, initialChat, knownSlugs, folders }: Props) {
  const router = useRouter();
  const [chat, setChat] = useState<ChatPayload>(initialChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * The reply as it is being written. Null means "nothing streaming right now";
   * it is a preview only — the finished text always comes back from the chat
   * file via `refreshChat`, never from here.
   */
  const [streamText, setStreamText] = useState<string | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initialChat.row.title);
  const [moveOpen, setMoveOpen] = useState(false);
  const [promoteFor, setPromoteFor] = useState<ChatMessage | null>(null);

  // "Ingest whole chat as a source" — implements docs/06 §"Special case:
  // chats as sources". Runs the same ingest pipeline as a pasted text source
  // so a long, useful thread can be promoted into the wiki layer all at once
  // (vs. promoting one assistant message at a time).
  const [ingestingChat, setIngestingChat] = useState(false);
  const [ingestChatResult, setIngestChatResult] = useState<null | {
    newPages: Array<{ slug: string; title: string }>;
    updatedPages: Array<{ slug: string }>;
    pending: boolean;
  }>(null);
  const [ingestChatError, setIngestChatError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** Only auto-follow the answer while the user is already at the bottom. */
  const followRef = useRef(true);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages.length]);

  // Live output arrives one chunk at a time; repainting on every chunk means
  // re-parsing the whole markdown answer dozens of times a second. Buffering
  // for ~100ms keeps the typing effect while bounding the work.
  const pendingTextRef = useRef("");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      const chunk = pendingTextRef.current;
      if (chunk.length === 0) return;
      pendingTextRef.current = "";
      setStreamText((prev) => (prev ?? "") + chunk);
      if (followRef.current) messagesEndRef.current?.scrollIntoView({ block: "end" });
    }, 100);
    return () => clearInterval(timer);
  }, [busy]);

  // Stops watching when the user leaves; the server-side task continues.
  const aliveRef = useRef(true);
  const watcherRef = useRef<LiveTaskWatch | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      watcherRef.current?.close();
      watcherRef.current = null;
    };
  }, []);

  const folderChoices = useMemo(
    () => folders.filter((f) => f !== chat.row.folder),
    [folders, chat.row.folder],
  );

  async function refreshChat() {
    const res = await fetch(`/api/chats/${chatId}`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as ChatPayload;
      setChat(data);
    }
  }

  /**
   * Watches one chat task to completion, rendering its output as it arrives.
   *
   * Resolves when the task settles — or when the stream tells us the task was
   * requeued after a failed attempt, in which case we follow it into the retry
   * rather than reporting an error the executor is already handling.
   */
  async function watchChatTask(taskId: string): Promise<void> {
    const watch = watchTaskLive(taskId, {
      onSnapshot: (snapshot) => {
        // The snapshot is authoritative and already contains everything the
        // buffer holds, so anything still waiting to be flushed is redundant.
        pendingTextRef.current = "";
        setStreamText(snapshot.text.length > 0 ? snapshot.text : null);
        if (snapshot.progress) setProgress(snapshot.progress);
      },
      onReset: () => {
        pendingTextRef.current = "";
        setStreamText(null);
      },
      onDelta: (text) => {
        pendingTextRef.current += text;
      },
      onProgress: (next) => {
        if (next) setProgress(next);
      },
      onRetrying: (error) => {
        pendingTextRef.current = "";
        setStreamText(null);
        setProgress(error ? `上一次尝试失败，正在重试：${error}` : "上一次尝试失败，正在重试…");
      },
    });
    watcherRef.current = watch;
    try {
      const task = await watch.promise;
      if (!task) {
        // The watch gave up before the task settled (the server went away
        // mid-stream). One hard read decides — and it throws if the row is gone.
        const row = await fetchTask(taskId);
        if (row.status !== "succeeded") {
          throw new Error(row.error ?? "生成回复失败。");
        }
        return;
      }
      if (task.status !== "succeeded") {
        throw new Error(task.error ?? "生成回复失败。");
      }
    } finally {
      if (watcherRef.current === watch) watcherRef.current = null;
    }
  }

  /**
   * Re-attaches to a turn that is still running — a page reload or a return to
   * the chat while the executor is mid-answer. The reply was never tied to this
   * component, so the only thing to rebuild is the view of it.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = await findActiveChatTask(chatId).catch(() => null);
      if (cancelled || !active) return;
      setBusy(true);
      setProgress(active.progress ?? "已提交，等待执行…");
      followRef.current = true;
      try {
        await watchChatTask(active.id);
        if (cancelled) return;
        await refreshChat();
      } catch (err) {
        if (!cancelled) setSendError((err as Error).message);
      } finally {
        if (!cancelled) {
          setBusy(false);
          setProgress(null);
          setStreamText(null);
        }
      }
    })();
    return () => {
      cancelled = true;
      watcherRef.current?.close();
      watcherRef.current = null;
    };
    // Re-runs only when the chat changes; a send is handled by onSend itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  async function onSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    setSendError(null);
    setProgress("已提交，等待执行…");
    const optimisticUser: ChatMessage = {
      role: "user",
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      content: input,
    };
    setChat((prev) => ({ ...prev, messages: [...prev.messages, optimisticUser] }));
    const sent = input;
    setInput("");
    pendingTextRef.current = "";
    setStreamText(null);
    followRef.current = true;
    console.log(`%c[对话发送] 用户消息："${sent}"`, "color: #3b82f6; font-weight: bold;");
    // Distinguishes "we never reached the queue" (safe to undo the optimistic
    // turn) from "the turn is queued and something later failed" (the user's
    // message is already in the chat file — it must stay on screen).
    let queued = false;
    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: sent }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        task?: { id: string };
      };
      if (!res.ok || !json.ok || !json.task) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      queued = true;

      // The user turn is already saved server-side; watch the assistant half of
      // the turn stream in. Leaving the page does not cancel it.
      await watchChatTask(json.task.id);

      // Re-read the chat so we get the canonical message list with server-side
      // timestamps + row metadata.
      await refreshChat();
      router.refresh(); // bumps the sidebar
    } catch (err) {
      console.error(`[对话失败] 消息："${sent}" -> ${(err as Error).message}`);
      setSendError((err as Error).message);
      if (queued) {
        // The reply may still land (the task is the server's, not ours), so
        // re-read instead of rolling back.
        await refreshChat().catch(() => {});
      } else {
        // Roll back the optimistic user message so the user can retry.
        setChat((prev) => ({ ...prev, messages: prev.messages.slice(0, -1) }));
        setInput(sent);
      }
    } finally {
      pendingTextRef.current = "";
      setBusy(false);
      setProgress(null);
      setStreamText(null);
    }
  }

  async function onRenameSave() {
    const t = draftTitle.trim();
    if (!t || t === chat.row.title) {
      setEditingTitle(false);
      return;
    }
    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: t }),
    });
    if (res.ok) {
      setChat((prev) => ({ ...prev, row: { ...prev.row, title: t } }));
      router.refresh();
    }
    setEditingTitle(false);
  }

  async function onMove(folder: string) {
    setMoveOpen(false);
    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    if (res.ok) {
      setChat((prev) => ({ ...prev, row: { ...prev.row, folder } }));
      router.refresh();
    }
  }

  async function onTogglePin() {
    const next = !chat.row.pinned;
    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: next }),
    });
    if (res.ok) {
      setChat((prev) => ({ ...prev, row: { ...prev.row, pinned: next } }));
      router.refresh();
    }
  }

  async function onDelete() {
    if (!confirm(`Move "${chat.row.title}" to trash?`)) return;
    const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    if (res.ok) {
      router.refresh();
      router.push("/chats");
    }
  }

  async function onIngestChat() {
    if (chat.messages.length === 0) return;
    if (
      !confirm(
        "把这个对话作为 wiki SourceIngest？智能体会读完整段对话，并据此新建或更新 wiki 页面。任务会在后台执行，离开本页不会中断。",
      )
    )
      return;
    setIngestingChat(true);
    setIngestChatError(null);
    setIngestChatResult(null);
    try {
      // Stringify messages the same way the chat file is stored so the LLM
      // sees a natural conversation transcript, not a JSON blob.
      const body = chat.messages
        .map((m) => `## ${m.role} [${m.time}]\n${m.content}`)
        .join("\n\n");
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: body,
          title: `对话：${chat.row.title}`,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        task?: { id: string };
      };
      if (!res.ok || !json.ok || !json.task) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      // Poll the background ingest task instead of holding the request open.
      const taskId = json.task.id;
      for (;;) {
        const task = await fetchTask(taskId);
        if (!aliveRef.current) return;
        if (!isActive(task)) {
          if (task.status !== "succeeded") {
            throw new Error(task.error ?? "Ingest失败。");
          }
          const out = (task.output ?? {}) as {
            newPages?: Array<{ slug: string; title: string }>;
            pageUpdates?: Array<{ slug: string }>;
            kind?: "preview" | "applied";
          };
          setIngestChatResult({
            newPages: (out.newPages ?? []).map((p) => ({ slug: p.slug, title: p.title })),
            updatedPages: (out.pageUpdates ?? []).map((p) => ({ slug: p.slug })),
            pending: out.kind === "preview",
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (err) {
      setIngestChatError((err as Error).message);
    } finally {
      setIngestingChat(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0">
          {editingTitle ? (
            <Input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={onRenameSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onRenameSave();
                if (e.key === "Escape") {
                  setDraftTitle(chat.row.title);
                  setEditingTitle(false);
                }
              }}
              className="h-8 text-base"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftTitle(chat.row.title);
                setEditingTitle(true);
              }}
              className="block text-left text-lg font-medium tracking-tight hover:underline"
              title="点击重命名"
            >
              {chat.row.pinned ? "★ " : ""}
              {chat.row.title}
            </button>
          )}
          <p className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            {chat.row.folder} · {chat.messages.length} 条消息
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="relative">
            <Button variant="outline" size="sm" onClick={() => setMoveOpen((o) => !o)}>
              移动
            </Button>
            {moveOpen && folderChoices.length > 0 ? (
              <ul className="absolute right-0 z-10 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-md">
                {folderChoices.map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      onClick={() => onMove(f)}
                      className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    >
                      → {f}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <Button variant="outline" size="sm" onClick={onTogglePin}>
            {chat.row.pinned ? "取消置顶" : "置顶"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onIngestChat}
            disabled={ingestingChat || chat.messages.length === 0}
            title="把整段对话作为Source跑一遍Ingest流程"
          >
            {ingestingChat ? "提交中…" : "Ingest到 wiki"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            删除
          </Button>
        </div>
      </header>

      {ingestChatResult ? (
        <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-6 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          <p>
            <strong>{ingestChatResult.pending ? "提案已生成，等待确认。" : "已归档进 wiki。"}</strong>{" "}
            新建 {ingestChatResult.newPages.length} 个页面，更新{" "}
            {ingestChatResult.updatedPages.length} 个。
            {ingestChatResult.pending
              ? " 审批开关已开启，请在“Source”页确认后再写入。"
              : ""}
          </p>
          {ingestChatResult.newPages.length > 0 ? (
            <p className="mt-1 text-xs">
              新建：{" "}
              {ingestChatResult.newPages.map((p, i) => (
                <span key={p.slug}>
                  <a
                    href={`/wiki/${p.slug}`}
                    className="underline underline-offset-2"
                  >
                    {p.title}
                  </a>
                  {i < ingestChatResult.newPages.length - 1 ? "、" : ""}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
      {ingestChatError ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-sm text-destructive">
          对话Ingest失败：{ingestChatError}
        </div>
      ) : null}

      {/*
       * Asymmetric Claude-style layout:
       *  - User messages → bubble on the right, max-w-[80%], filled bg
       *  - Assistant messages → flow on the left, full-ish width, no
       *    bubble. Long cited answers, tables, and code blocks all need
       *    width to breathe, so we don't constrain them.
       * Position alone signals who said what — role badges dropped.
       */}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-6 py-6"
        onScroll={() => {
          const el = scrollerRef.current;
          if (!el) return;
          // Sticky-bottom: an answer that is still being written should follow
          // the text, but never yank the view away from something the user
          // scrolled up to read.
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {chat.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有消息。先向 wiki 提一个问题开始这段对话。
          </p>
        ) : (
          <ol className="space-y-5">
            {chat.messages.map((m, i) => (
              <li key={`${m.time}-${i}`}>
                {m.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-primary/10 px-4 py-3 text-sm text-foreground">
                      <MarkdownView content={m.content} knownSlugs={knownSlugs} />
                      <p className="mt-1 text-right text-[10px] text-muted-foreground/70">
                        {m.time}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="max-w-[92%]">
                    <article className="text-sm">
                      <MarkdownView content={m.content} knownSlugs={knownSlugs} />
                    </article>
                    <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/80">
                      <span>{m.time}</span>
                      <button
                        type="button"
                        onClick={() => setPromoteFor(m)}
                        className="hover:text-foreground"
                      >
                        保存为 wiki 页面 →
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {busy ? (
          <div className="mt-4 max-w-[92%]">
            {streamText ? (
              <article className="text-sm">
                <MarkdownView content={streamText} knownSlugs={knownSlugs} />
              </article>
            ) : null}
            <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden
                className="inline-block h-3.5 w-[2px] animate-pulse bg-muted-foreground/70"
              />
              <span>
                {progress ? progress : "正在生成回复…"}
                （后台执行，离开本页也不会中断）
              </span>
            </p>
          </div>
        ) : null}
        {sendError ? (
          <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {sendError}
          </p>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={onSend} className="border-t border-border bg-background p-4">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="问点什么…"
          rows={3}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSend();
            }
          }}
          className="text-base"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Cmd/Ctrl + Enter 发送</p>
          <Button type="submit" disabled={!input.trim() || busy}>
            {busy ? "生成中…" : "发送"}
          </Button>
        </div>
      </form>

      {promoteFor ? (
        <PromoteMessageDialog
          message={promoteFor}
          chatTitle={chat.row.title}
          onClose={() => setPromoteFor(null)}
        />
      ) : null}
    </div>
  );
}
