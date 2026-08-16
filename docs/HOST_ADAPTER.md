# Host-Adapter 降耦设计（草案 v0.1）

> 状态：设计草案，未实现。目标版本：0.4.0（或随发布节奏）。
> 维护：维护者 · 2026-08-16

## 1. 背景

side-chat 大量依赖 Hana host 的**未公开行为**：补丁后的 query 参数（`sessionPath`）、官方 API 的非契约字段（`model`）、请求头剥离行为、`session:history` 的 200 条上限、`jot` 白名单机制等。这些依赖目前散落在 `lib/main-context.js`、`routes/api.js`、`routes/widget.js` 和前端 `assets/app.js` 里。

每次 Hana 升级，这些行为都可能变。当前应对方式是「升级后跑检查脚本 + 重打补丁」，属于事后补救。

目标：把「host 行为依赖」收拢到**一个模块**（`lib/host-adapter.js`），让业务代码只面对一个稳定接口。host 行为变化时只改 adapter，业务代码不动。

## 2. surfaceSession 调查结论（2026-08-16，源码实锤）

对 server bundle（0.446.6）源码的取证结论，决定适配层的边界：

| 凭证/机制 | 语义 | 含主会话信息？ |
|---|---|---|
| `pss_*`（pluginSurfaceSession） | payload = `{sessionId: pss_随机UUID, pluginId, action, principalId, 有效期}`，纯认证凭证，scopes 为空 | ❌ 无 |
| `pit_*`（pluginIframeTicket） | payload = `{ticketId: pit_随机UUID, pluginId, surfacePath, action, principalId, 有效期}`，surfacePath = 路径 + **jot 白名单外参数全部算进签名** | ❌ 无（只绑定插件页面路径） |
| `X-Hana-Plugin-Surface-Session` 头 | 转发到插件前被显式删除（`Lot()` 里 `l.delete(Use), l.delete("X-Hana-Agent-Id")`） | ❌ 无 |
| `X-Hana-Agent-Id` 头 | 同上，被剥离 | ❌ 无 |
| iframe URL query | `agentId`（官方白名单）、`sessionPath`（补丁注入）、`token`（补丁放行） | ✅ 仅补丁提供 |

**结论**：
1. surfaceSession 是纯认证机制，**不可能**从中拿到主会话 id，`pss_`/`pit_` 无 session 语义。之前「依赖 host 支持」的 session 级隔离只能等官方新机制（见  issue 建议：官方把主会话路径纳入 ticket payload 或透传参数）。
2. `sessionPath` 补丁在官方支持前**无法退役**——它是当前唯一的主会话信息来源。
3. 适配层的核心职责 = 把「主会话定位五级降级链」和「补丁状态/契约版本探测」封装成稳定接口。

## 3. 适配层设计

### 3.1 模块职责

```
lib/host-adapter.js（新）
├── 版本与契约探测
│   ├── detectHostInfo(ctx)      → { version, patchState: {token, sessionPath}, artifacts }
│   └── 复用 lib/patch-check.mjs 的扫描逻辑（读 bundle 文件）
├── 主会话定位（五级降级链，现状逻辑从 main-context.js 迁入）
│   ├── resolveMainSessionPath(input, store, ctx) → { path, method: 'sessionPath'|'boundMain'|'sessionId'|'sessionList'|'mtime' }
│   ├── findMainSessionFile(...)                  → JSONL 直读定位（含 agentId 过滤）
│   └── sessionListParser / mtimeFallback
├── host API 封装（官方接口 + 扩展字段，收敛语义）
│   ├── createSession(ctx, {agentId, model})      → 包装 session:create + model 扩展字段
│   ├── readHistory / readJsonl                   → 主源 JSONL 直读 + history 降级
│   ├── sendMessage(ctx, {path, text, context})   → 包装 session:send + 两套上下文
│   ├── getAgentProfile / getAgentModel           → agent:profile / agent:config（只取 models.chat）
│   └── listSessions(ctx, agentId)                → session:list + path/visibility/modified 解析
└── 凭证与请求上下文
    ├── getSurfaceAuth(ctx)   → query/cookie/token 兜底解析（从 routes/widget.js 迁入）
    └── isPatchRequired()     → 面板诊断用（host 补丁状态）
```

### 3.2 对外接口（业务代码视角）

```js
// lib/host-adapter.js default export
{
  info(ctx),                        // { version, patches: {token: bool, sessionPath: bool} }
  locateMainSession(ctx, store, {sessionPath, boundMain, sessionId}),  // 五级降级，返回 {path, method, source}
  mainSource(path),                 // JSONL 直读 or history 降级的统一入口
  api: { create, send, history, profile, model, listSessions },  // 全部走官方管道
  auth: { resolveToken(ctx) },
}
```

### 3.3 迁移步骤（渐进式，不搞大爆炸）

1. 新建 `lib/host-adapter.js`，从 `lib/main-context.js` **迁移**（不是复制）：`resolveMainSessionPath`、`findMainSessionFile`、`parseSessionJsonl`、`roundsFromHistory` 的 host 相关部分。
2. `routes/api.js` 改为调用 adapter；删除本地重复实现。
3. `routes/widget.js` 的 token 解析迁入 `auth.resolveToken`。
4. 前端不动（`SESSION_PATH` 透传逻辑在 app.js，属于补丁契约，adapter 后端接口不变）。
5. `lib/main-context.js` 瘦身为纯业务逻辑（组装 context、摘要、预算），不再直接碰 host API。
6. 回归：smoke-test 全绿 + 真机面板功能抽查。

### 3.4 验收标准

- 业务代码中 grep 不到 `bus.` / `session:create` 等 host 调用字面量（全部经 adapter）。
- `resolveMainSessionPath` 的降级链行为与现状完全一致（对照现有单测/冒烟断言）。
- host 补丁丢失时 `info(ctx).patches` 正确反映，面板诊断直接读 adapter（替换现在散落的检测调用）。

## 4. 收益与风险

**收益**：
- host 行为变化只改一处； 官方支持后（假设官方透传主会话 id），只需改 `locateMainSession` 的优先级，加一个 `method: 'official'`。
- `lib/main-context.js` 可单测（注入 mock adapter），当前它直连 host 导致难以测试。
- 发布到 GitHub 后，第三方用户升级 Hana 的故障面缩小到 adapter 一处。

**风险**：
- 迁移过程可能引入行为差异（尤其降级链的顺序和边界条件）→ 靠 smoke-test + 真机复验兜底。
- adapter 膨胀成「上帝模块」→ 控制粒度：只收 host 依赖，业务逻辑一律不进。

## 5. 与  的关系

（官方 issue）落地前，适配层把补丁机制当「契约 v1」封装；落地后 adapter 升「契约 v2」，补丁代码路径可整体删除（`apply-*.cjs` 保留为历史工具）。这是降耦的长期价值点：**将来删补丁不需要碰业务代码**。
