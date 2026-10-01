// The two HTML pages this server ever renders: the approval page (where a
// human authorizes an MCP client) and a status page.
//
// Rendered by the MCP server itself rather than by the Next app because the
// browser is sent here by the *client*, at the MCP origin — a redirect to the
// app's own port would have to carry the OAuth request across origins and back
// again. Self-contained HTML with inline CSS keeps the server dependency-free
// and works with no build step; the palette mirrors the app's (warm cream /
// oxblood) so the detour does not look like a different product.

export type ApprovalRenderOptions = {
  /** `code` — ask for the approval code. `consent` — pick tools. */
  step: "code" | "consent";
  clientName: string;
  clientId: string;
  redirectUri: string;
  requestedScopes: string[];
  tools: Array<{ id: string; label: string; summary: string; checked: boolean }>;
  /** Continuation parameters, echoed back as hidden inputs. */
  params: Record<string, string>;
  error?: string;
  approvalCodeHint?: string;
};

const STYLE = `
:root {
  --background: #faf7f2;
  --card: #ffffff;
  --foreground: #1c1917;
  --muted: #78716c;
  --border: #e7e1d9;
  --primary: #991b1b;
  --primary-foreground: #fff7f7;
  --danger-bg: #fee2e2;
  --danger: #991b1b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #1c1917;
    --card: #262220;
    --foreground: #f5f5f4;
    --muted: #a8a29e;
    --border: #3a3431;
    --primary: #f87171;
    --primary-foreground: #1c1917;
    --danger-bg: #450a0a;
    --danger: #fca5a5;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem;
  background: var(--background); color: var(--foreground);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  display: flex; justify-content: center;
}
main { width: 100%; max-width: 34rem; }
h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
h2 { font-size: .95rem; margin: 1.75rem 0 .5rem; color: var(--muted); font-weight: 600;
     text-transform: uppercase; letter-spacing: .06em; }
p { margin: .35rem 0; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: .6rem; padding: 1.25rem 1.35rem; }
.hint { color: var(--muted); font-size: .85rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em;
       background: color-mix(in srgb, var(--border) 45%, transparent); padding: .1rem .3rem; border-radius: .25rem; }
.row { display: flex; gap: .6rem; align-items: flex-start; padding: .55rem 0; border-top: 1px solid var(--border); }
.row:first-of-type { border-top: 0; }
.row input { margin: .25rem 0 0; width: 1rem; height: 1rem; flex: none; }
.row strong { display: block; font-weight: 500; }
.row span { color: var(--muted); font-size: .82rem; }
label.field { display: block; margin-top: 1rem; font-size: .85rem; color: var(--muted); }
input[type=text] { width: 100%; margin-top: .3rem; padding: .55rem .65rem; font-size: 1rem;
  border: 1px solid var(--border); border-radius: .4rem; background: var(--background); color: var(--foreground);
  letter-spacing: .12em; font-family: ui-monospace, monospace; }
.actions { display: flex; gap: .6rem; margin-top: 1.5rem; align-items: center; }
button { font: inherit; padding: .5rem 1rem; border-radius: .4rem; cursor: pointer; border: 1px solid var(--border);
  background: var(--background); color: var(--foreground); }
button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
button.link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: .5rem 0; }
.error { background: var(--danger-bg); color: var(--danger); border-radius: .4rem; padding: .6rem .75rem; margin-top: 1rem; font-size: .9rem; }
dl { margin: .5rem 0 0; font-size: .85rem; }
dt { color: var(--muted); margin-top: .5rem; }
dd { margin: .1rem 0 0; word-break: break-all; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hiddenInputs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
}

export function renderApprovalPage(options: ApprovalRenderOptions): string {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : "";

  const body =
    options.step === "code"
      ? `
  <form method="POST" action="/oauth/approve">
    ${hiddenInputs(options.params)}
    <label class="field" for="approval_code">批准码</label>
    <input id="approval_code" name="approval_code" type="text" autocomplete="off" autofocus
           placeholder="xxxx-xxxx" value="">
    <p class="hint">批准码在 LLM Wiki 的「设置 → MCP」页面生成，30 分钟内有效。</p>
    ${error}
    <div class="actions">
      <button class="primary" type="submit">继续</button>
    </div>
  </form>`
      : `
  <form method="POST" action="/oauth/approve">
    ${hiddenInputs(options.params)}
    <h2>允许该客户端调用的工具</h2>
    ${options.tools
      .map(
        (tool) => `
    <label class="row">
      <input type="checkbox" name="tool" value="${escapeHtml(tool.id)}"${tool.checked ? " checked" : ""}>
      <span><strong>${escapeHtml(tool.id)}</strong><span>${escapeHtml(tool.summary)}</span></span>
    </label>`,
      )
      .join("\n")}
    ${error}
    <div class="actions">
      <button class="primary" type="submit" name="decision" value="approve">授权</button>
      <button type="submit" name="decision" value="deny">拒绝</button>
    </div>
  </form>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>授权 MCP 客户端 · LLM Wiki</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>授权 MCP 客户端</h1>
    <p class="hint">一个 MCP 客户端请求访问你的知识库。</p>
    <dl>
      <dt>客户端</dt><dd>${escapeHtml(options.clientName)}</dd>
      <dt>回调地址</dt><dd>${escapeHtml(options.redirectUri)}</dd>
      <dt>客户端 ID</dt><dd><code>${escapeHtml(options.clientId)}</code></dd>
      <dt>请求的权限</dt><dd>${escapeHtml(options.requestedScopes.join(", ") || "wiki:read")}</dd>
    </dl>
  </div>
  <div class="card" style="margin-top:1rem">
    ${body}
  </div>
</main>
</body>
</html>`;
}

export type StatusPageOptions = {
  endpointUrl: string;
  enabledTools: string[];
  authMode: string;
  running: boolean;
  message?: string;
};

/** Shown when a browser (not an MCP client) opens the MCP origin. */
export function renderStatusPage(options: StatusPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>LLM Wiki MCP 服务</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>LLM Wiki MCP 服务</h1>
    <p class="hint">${options.running ? "服务运行中。" : "服务未启动。"}</p>
    ${options.message ? `<p class="error">${escapeHtml(options.message)}</p>` : ""}
    <dl>
      <dt>MCP 地址</dt><dd><code>${escapeHtml(options.endpointUrl)}</code></dd>
      <dt>认证方式</dt><dd>${escapeHtml(options.authMode)}</dd>
      <dt>已启用工具</dt><dd>${escapeHtml(options.enabledTools.join(", ") || "（无）")}</dd>
    </dl>
    <p class="hint" style="margin-top:1rem">
      把上面的地址填入支持 MCP 的 LLM 客户端即可。工具开关与权限在 LLM Wiki 的「设置 → MCP」中调整。
    </p>
  </div>
</main>
</body>
</html>`;
}
