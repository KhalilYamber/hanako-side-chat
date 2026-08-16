# DSH 适配试点（host-adapter 第二宿主验证）

> 状态：试点完成（2026-08-16）。目标版本：无（试点性质，未接入插件主流程）。

## 1. 试点目标

验证 host-adapter 抽象能否复用到第二宿主：**业务零改动，只换 adapter 后端，数据流即通**。

- side-chat 的 host 依赖已全部收拢在 `lib/host-adapter.js`（Hana 版，13 导出）
- 本试点新增 `lib/host-adapter-dsh.js`（DSH 版）：同一接口签名风格，后端指向 DeepSeek Harness web host（本机 `127.0.0.1:3080`，由 dsh-bridge 插件拉起）
- `debug/dsh-adapter-demo.mjs`：真实数据流验证脚本

## 2. DSH 契约实测（0.1.0-rc.6，2026-08-16 实测）

信封协议：`POST /api/<method>`，body `{type:'client-request', rpcId, method, payload}`，响应 `{rpcId, result:{ok, value|error}}`（rpcId 回显校验）。无 ticket/认证概念（本地服务）。

| RPC | payload | 返回 value | 备注 |
|---|---|---|---|
| `session.list` | `{projections?:[...]}` | `{items:[{sessionId, updatedAt, running, blank, cwd, agentPreset, projections:{title, contextPressure, tokenUsage, ...}}]}` | 元数据丰富（title/上下文压力/token 用量） |
| `session.create` | `{cwd?, agentPreset?, sessionId?, workspaceId?, title?}` | `{sessionId, agentPreset}` | 传 sessionId 即 resume |
| `session.prompt` | `{sessionId, mode:'queue'\|'steer', content:[{type:'text', text}]}` | `{accepted:true}` | 异步队列 |
| `session.history` | `{sessionId, limit?}` | `{events:[{event:{type,seq,time,data}}], hasMore, projections}` | 事件流形态，**无 200 条上限** |
| `session.cancel` | `{sessionId}` | 取消结果 | |
| `session.search` | `{query}` | `{items:[{sessionId, snippet}], hasMore}` | 跨会话搜索（≤240 字符 snippet，20 条） |

## 3. 接口映射表

| host-adapter 接口 | Hana 实现 | DSH 实现（host-adapter-dsh.js） |
|---|---|---|
| `resolveMainSessionPath` | 补丁 sessionPath 五级降级链（精确） | `session.list` 取最近活跃（updatedAt 最大，`method:'recent'`）+ `explicitSessionId` 显式优先（`method:'explicit'`） |
| `createSession` | `session:create`（+ model 扩展字段） | `session.create`（cwd/agentPreset/title） |
| `readHistory` | `session:history`（200 条上限）+ 文件直读绕限 | `session.history`（事件流，官方无上限；`toMessages()` 提取文本轮次） |
| `sendMessage` | `session:send`（两套上下文） | `session.prompt`（mode queue/steer） |
| `sampleText` | `model:sample-text` | ❌ 未适配（DSH 无对应 RPC，标记 null） |
| `resolveToken` / `injectAssetsToken` | ticket/cookie + assets URL 注入 | 恒空/原样（本地服务无此概念） |

## 4. 验证结果（实测，2026-08-16）

`node debug/dsh-adapter-demo.mjs` 连 127.0.0.1:3080，两轮全绿：

```
PASS  健康检查 GET /
PASS  主会话定位（recent）
PASS  读主会话历史（1533 事件 / 211 事件）
PASS  建辅助会话
PASS  发消息（session.prompt → accepted）
PASS  轮询读回回复（agent 回复含预期文本）
---- 6/6 PASS ----
```

数据流完整跑通：定位主会话 → 读上下文 → 建辅助会话 → 发消息 → 轮询读回。

## 5. 结论

- **host-adapter 抽象成立**：DSH 后端约 150 行（不含 demo/文档），接口签名与 Hana 版对齐，业务侧零改动即可对接
- DSH 契约比 Hana 干净：官方 `session.history` 无 200 条上限、无过滤、无 ticket；`session.list` 带 title/contextPressure/tokenUsage 元数据
- 差异点集中在「主会话定位」：DSH 无「当前打开会话」暴露，需 `recent`（最近活跃）或显式指定——语义与 Hana 的 mtime 降级链一致

## 6. 后续路线（占位思考）

1. **原生 Cordis 插件**：以 DSH 插件形态进入生态（`dsh-plugin` topic），用 `ctx.sessions` 读会话——这是「进 DSH 生态」的正路，web host RPC 是外部适配视角
2. **UI 形态**：DSH Web UI 的侧栏/面板扩展，或独立页面
3. 元数据利用：`contextPressure`/`tokenUsage` 可用于上下文健康度提示（Hana 版做不到的能力）
4. 生态卡位：700+ 插件抢滩期，「知识伴侣」形态尚无占位者（2026-08-16 调研）

## 7. 已知边界

- `toMessages` 的事件类型映射基于实测样本（user/message、assistant/message），其他事件类型（chunk/tool-call 等）未提取
- `sampleText` 未适配（DSH 无 model:sample-text；若有等价 RPC 需补）
- 试点代码未接入 side-chat 主流程（manifest/routes 未动）
