"use client";

// Settings → MCP.
//
// Client-safe on purpose: the `@llm-wiki/mcp` barrel reaches the MCP SDK and
// keytar, so every type this tab needs is mirrored here. Keep in sync with
// packages/mcp/src/types.ts.

import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsRow } from "@/components/settings/info-hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type McpToolId =
  | "wiki_search"
  | "wiki_read_page"
  | "wiki_list_pages"
  | "wiki_get_toc"
  | "wiki_get_section"
  | "wiki_backlinks"
  | "wiki_get_graph";

type McpAuthMode = "none" | "bearer" | "oauth";

type McpConfig = {
  version: 1;
  enabled: boolean;
  exposedWikis: string[];
  authMode: McpAuthMode;
  allowRemote: boolean;
  tokenTtlDays: number;
  tools: Record<McpToolId, boolean>;
};

type TokenSummary = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

type OAuthClientSummary = {
  clientId: string;
  clientName: string;
  registeredAt: string;
  lastAuthorizedAt: string | null;
  tools: McpToolId[];
};

type SessionSummary = { clientId: string; clientName: string; createdAt: string };

type ConfigResponse = {
  config: McpConfig;
  /** Fixed port the server binds; the domain half comes from the browser. */
  port: number;
  toolIds: McpToolId[];
  scopes: string[];
  allScope: string;
  tokens: TokenSummary[];
  oauthClients: OAuthClientSummary[];
  sessions: SessionSummary[];
  running: boolean;
  pid: number | null;
  owned: boolean;
  configPath: string;
  wikiPath: string;
  defaultTools: McpToolId[];
};

type WikiOption = { path: string; topic: string | null; exists: boolean };

/** Placeholder for the domain: it is read from the browser after mount. */
const PORT_PLACEHOLDER = "<域名>";

const TOOL_LABELS: Record<McpToolId, string> = {
  wiki_search: "搜索",
  wiki_read_page: "读取页面",
  wiki_list_pages: "列出页面",
  wiki_get_toc: "读取目录",
  wiki_get_section: "读取章节",
  wiki_backlinks: "反向链接",
  wiki_get_graph: "知识图谱",
};

const TOOL_SUMMARIES: Record<McpToolId, string> = {
  wiki_search: "全文检索，返回路径、标题、摘要与相关性得分。",
  wiki_read_page: "按路径读取整页：正文、frontmatter、出站与入站链接。",
  wiki_list_pages: "浏览全部页面，可按类型、标签过滤。",
  wiki_get_toc: "提取标题层级、锚点、行号范围与内容预览。",
  wiki_get_section: "按标题路径读取单个章节，降低 token 消耗。",
  wiki_backlinks: "查找所有指向指定页面的入站链接。",
  wiki_get_graph: "返回知识图谱的节点与边，或按条件返回子图。",
};

const AUTH_MODES: Array<{ id: McpAuthMode; label: string; hint: string }> = [
  {
    id: "none",
    label: "无认证",
    hint: "只接受本机（127.0.0.1）连接，无需任何凭据。适合纯本地使用。",
  },
  {
    id: "bearer",
    label: "令牌",
    hint: "客户端在 Authorization 头里带上静态令牌。兼容不支持 OAuth 的客户端。",
  },
  {
    id: "oauth",
    label: "OAuth 2.1",
    hint: "授权码 + PKCE，含动态客户端注册与撤销端点。静态令牌在此模式下仍然有效。",
  },
];

function endpointPath(wikiPath: string): string {
  const segments = wikiPath.split(/[\\/]+/).filter(Boolean);
  const name = segments[segments.length - 1];
  return name ? `/${name}/mcp` : "/mcp";
}

export function McpTab() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [wikis, setWikis] = useState<WikiOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);

  const [tokenLabel, setTokenLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [approvalCode, setApprovalCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [configRes, wikisRes] = await Promise.all([
        fetch("/api/mcp/config", { cache: "no-store" }),
        fetch("/api/wikis", { cache: "no-store" }),
      ]);
      if (!configRes.ok) throw new Error(`HTTP ${configRes.status}`);
      setData((await configRes.json()) as ConfigResponse);
      if (wikisRes.ok) {
        const body = (await wikisRes.json()) as {
          active?: WikiOption;
          recents?: WikiOption[];
        };
        const all = [body.active, ...(body.recents ?? [])].filter(
          (w): w is WikiOption => w !== undefined && w !== null,
        );
        const seen = new Set<string>();
        setWikis(all.filter((w) => (seen.has(w.path) ? false : (seen.add(w.path), true))));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The domain comes from the browser, the port is fixed in the server code.
  // Read after mount: the server render has no `location`.
  useEffect(() => {
    setOrigin(window.location.hostname);
  }, []);

  const address = useMemo(() => {
    if (!data) return null;
    const host = origin ?? PORT_PLACEHOLDER;
    return `http://${host}:${data.port}${endpointPath(data.wikiPath)}`;
  }, [data, origin]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/mcp/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const parsed = (await res.json()) as { error?: string; config?: McpConfig };
        if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
        await load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  async function createToken() {
    setBusy(true);
    setError(null);
    setNewToken(null);
    try {
      const res = await fetch("/api/mcp/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: tokenLabel || "MCP 客户端" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created = (await res.json()) as TokenSummary & { token: string };
      setNewToken(created.token);
      setTokenLabel("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(id: string, label: string) {
    if (!confirm(`撤销令牌「${label}」？使用它的客户端会立即失效。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/mcp/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeClient(clientId: string, name: string) {
    if (!confirm(`移除客户端「${name}」？它已获得的访问权会被一并撤销。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/mcp/tokens?client=${encodeURIComponent(clientId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function requestApprovalCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/config", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { approvalCode: string };
      setApprovalCode(body.approvalCode);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }

  const config = data.config;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <code className="rounded-md border border-border/70 bg-muted/40 px-2 py-1 font-mono text-sm">
            {address}
          </code>
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground"
            onClick={() => {
              if (address) void navigator.clipboard.writeText(address);
            }}
          >
            复制
          </button>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
              data.running
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
            )}
          >
            {data.running ? "运行中" : "未运行"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          端口固定为 {data.port}，域名取自浏览器地址栏；把它填进支持 MCP 的客户端即可。
        </p>
      </section>

      <div className="divide-y divide-border/70 border-t border-border/70 pt-1">
        <SettingsRow
          title="启用 MCP 服务"
          hint={<p>关闭时服务进程不会启动，已配置的客户端会连接失败。</p>}
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={busy}
              onChange={(e) => void patch({ enabled: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm">{config.enabled ? "已开启" : "已关闭"}</span>
          </label>
        </SettingsRow>

        <SettingsRow
          title="允许远程访问"
          hint={
            <p>
              开启后服务绑定 <code>0.0.0.0</code>，容器端口映射或反向代理必须开启它。关闭时只接受
              127.0.0.1 的连接。
            </p>
          }
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.allowRemote}
              disabled={busy || !config.enabled}
              onChange={(e) => void patch({ allowRemote: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm">{config.allowRemote ? "允许" : "仅本机"}</span>
          </label>
        </SettingsRow>

        <SettingsRow
          title="工具"
          hint={
            <p>
              取消勾选的工具不会出现在 <code>tools/list</code> 中，客户端完全看不到它。
            </p>
          }
        >
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {data.toolIds.map((id) => (
              <label key={id} className="flex items-center gap-2" title={TOOL_SUMMARIES[id]}>
                <input
                  type="checkbox"
                  checked={config.tools[id]}
                  disabled={busy}
                  onChange={(e) => void patch({ tools: { [id]: e.target.checked } })}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="font-mono text-xs text-muted-foreground">{id}</span>
                <span className="text-xs">{TOOL_LABELS[id]}</span>
              </label>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          title="开放的知识库"
          hint={<p>只有勾选的文件夹会被打开；其余路径即使被请求也会被拒绝。</p>}
        >
          {wikis.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有可用的知识库。</p>
          ) : (
            <div className="space-y-1.5">
              {wikis.map((wiki) => {
                const checked = config.exposedWikis.includes(wiki.path);
                return (
                  <label key={wiki.path} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || !wiki.exists}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...config.exposedWikis, wiki.path]
                          : config.exposedWikis.filter((p) => p !== wiki.path);
                        void patch({ exposedWikis: next });
                      }}
                      className="mt-0.5 h-4 w-4 rounded border-border"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">
                        {wiki.topic ?? wiki.path.split(/[\\/]/).pop()}
                      </span>
                      <span className="block break-all font-mono text-[11px] text-muted-foreground">
                        {wiki.path}
                        {wiki.exists ? "" : "（不存在）"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </SettingsRow>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">权限</h2>

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-md border border-border bg-secondary/40 p-1">
            {AUTH_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={busy || !config.enabled}
                onClick={() => void patch({ authMode: mode.id })}
                className={cn(
                  "rounded px-3 py-1 text-xs",
                  config.authMode === mode.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            令牌有效期
            <select
              aria-label="令牌有效期"
              value={config.tokenTtlDays}
              disabled={busy || !config.enabled}
              onChange={(e) => void patch({ tokenTtlDays: Number(e.target.value) })}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value={0}>永不过期</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
              <option value={365}>1 年</option>
            </select>
          </label>
        </div>

        <p className="text-xs text-muted-foreground">
          {AUTH_MODES.find((m) => m.id === config.authMode)?.hint}
        </p>

        <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={tokenLabel}
              onChange={(e) => setTokenLabel(e.target.value)}
              placeholder="令牌名称（如 Claude Desktop）"
              className="h-8 max-w-[16rem] text-sm"
            />
            <Button size="sm" disabled={busy} onClick={() => void createToken()}>
              新建令牌
            </Button>
          </div>

          {newToken ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
              <p className="text-xs text-emerald-800 dark:text-emerald-200">
                令牌只显示这一次，请立即复制：
              </p>
              <code className="mt-1 block break-all font-mono text-[11px]">{newToken}</code>
            </div>
          ) : null}

          {data.tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有令牌。</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {data.tokens.map((token) => (
                <li key={token.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0">
                    <span className="block text-sm">{token.label}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {token.lastUsedAt
                        ? `最近使用 ${token.lastUsedAt.slice(0, 16).replace("T", " ")}`
                        : "尚未使用"}
                      {token.expiresAt ? ` · 到期 ${token.expiresAt.slice(0, 10)}` : " · 永不过期"}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeToken(token.id, token.label)}
                    className="shrink-0 text-xs text-muted-foreground underline hover:text-destructive"
                  >
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {config.authMode === "oauth" ? (
          <div className="space-y-3 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void requestApprovalCode()}
              >
                生成批准码
              </Button>
              {approvalCode ? (
                <code className="rounded bg-background px-2 py-1 font-mono text-sm tracking-wider">
                  {approvalCode}
                </code>
              ) : (
                <span className="text-xs text-muted-foreground">
                  在客户端跳转出的授权页面里输入，30 分钟内有效
                </span>
              )}
            </div>

            {data.oauthClients.length > 0 ? (
              <ul className="divide-y divide-border/60">
                {data.oauthClients.map((client) => (
                  <li
                    key={client.clientId}
                    className="flex items-center justify-between gap-3 py-1.5"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm">{client.clientName}</span>
                      <span className="block break-all font-mono text-[11px] text-muted-foreground">
                        {client.clientId} · {client.tools.length} 个工具
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void revokeClient(client.clientId, client.clientName)}
                      className="shrink-0 text-xs text-muted-foreground underline hover:text-destructive"
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">还没有已授权的客户端。</p>
            )}

            {data.sessions.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                本浏览器已批准 {data.sessions.length} 个客户端，再次授权时无需输入批准码。
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      <p className="border-t border-border/70 pt-3 text-xs text-muted-foreground">
        配置文件：<code className="font-mono">{data.configPath}</code>
        {data.pid ? ` · 进程 ${data.pid}` : ""}
      </p>
    </div>
  );
}
