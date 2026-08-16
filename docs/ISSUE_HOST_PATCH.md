# Host 补丁契约缺口 issue 草稿 —— 上报 OpenHanako 仓库用

> 用途：提交到 https://github.com/liliMozi/openhanako 的 issue。提交前由作者审阅确认。
> 标题、正文、标签建议均已写好；正文为英文（开源仓库通用语言）。

---

## Title

Plugin iframe URL query whitelist (`jot`) is missing `token` and `sessionPath` — widget ticket validation breaks / no main-session context for plugins

## Body

**Environment**: HanaAgent 0.446.6 (Windows), plugin SDK surface (widget iframe).

**Summary**: The server-side `pluginIframeTicket` validation signs/verifies the plugin surface path including all query parameters **except** a hardcoded whitelist (`jot` set). Two real-world query params break or limit plugins:

1. **`token` (breaks the widget entirely)** — The renderer always appends `token=<session token>` when opening a plugin iframe. `token` is not in the whitelist, so it becomes part of the signed `surfacePath`. The ticket was minted with one surfacePath, but any follow-up request (or any variance in token) produces a different signature → ticket mismatch → `plugin_iframe_ticket_route_mismatch` → 403 → the plugin surface shows "加载失败 / load failed".

   Reproduction: open any plugin widget that relies on cookie-less fallback auth (`token` in URL). Symptom is deterministic in 0.446.6.

   Workaround applied locally: patch the bundle's `jot` set to include `"token"` (see below). This patch is lost on every Hana upgrade.

2. **`sessionPath` (limits context-aware plugins)** — Sidebar widgets (companion rail) have access to the currently open main session path in the renderer store, but there is no official way to pass it into the plugin iframe. Plugins that need "which main conversation is open right now" must guess (e.g. most-recently-modified session), which is wrong when the user switches conversations. We patched the renderer to inject `sessionPath` as a whitelisted query param; an official mechanism (query param, ticket field, or request header that is not stripped before forwarding) would let plugins bind reliably.

**Suggested fix**:

- Add `"token"` to the `jot` whitelist (one-line, low risk) — it is already effectively public in the URL.
- Consider a documented, official way to pass the current main session path to plugin surfaces (e.g. extend the whitelist + renderer, or include it in the ticket payload). Plugins could then drop local patches.

**Current local patch** (for reference / reproduction):

```
new Set(["pluginIframeTicket", "pluginSurfaceSession", "agentId", "hana-theme", "hana-css", "token", "sessionPath"])
```

**Impact**: every plugin that uses URL token fallback auth breaks after Hana upgrade until the patch is re-applied; context-aware sidebar plugins degrade to heuristic main-session detection.

---

## 中文摘要（附在正文后供审阅）

- 问题 1（严重）：renderer 打开插件 iframe 必带 `token` 参数，但 server 的 ticket 签名白名单（jot 集合）不含 `token`，导致 ticket 路由校验失败 → 403 → 插件面板「加载失败」。升级 Hana 后必然复发。
- 问题 2（功能缺口）：侧边栏 widget 拿不到「当前打开的主会话路径」，依赖主会话上下文的插件只能猜（最近修改兜底），切主对话必串。需要官方透传机制。
- 建议：jot 加 `"token"`（一行修复）；主会话路径官方化（白名单扩展或进 ticket payload）。
