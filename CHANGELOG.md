# Changelog

本插件版本沿用的语义化版本。每个版本记录对用户可见的变化与内部重要修复。

## [0.3.0] - 2026-08-16

### 新增
- **树枝-树叶隔离**：辅助会话归属于创建它的主对话（boundMain），会话列表按主对话严格隔离，参考上下文跟随归属主对话；旧数据自动惰性归位，未绑定会话单独分组显示。
- **主会话绑定**：创建会话即记录归属主对话；SSE 追踪当前活跃主会话，绑定≠当前时显示提示条一键切换。
- **快照+增量上下文机制**：创建会话时对主对话打快照（full=全量 / windowed=最近 N 轮+旧轮摘要），之后发消息只增量追加新轮，不再每次全量重读；mainCtx 持久化到索引，来源/轮数/模式变化自动重建。
- **自我意识提示词**：设置面板可编辑，定义辅助对话身份与行为准则；附加 system 块注入，不替换原有上下文机制。
- **主会话读取主源切换为文件直读**：host `session:history` 有 200 条上限且取最早消息（源码实锤），改为直接解析主会话 JSONL（支持 thinking），history 降级兜底。
- **思考内容可见**：块级流式渲染，💭 思考块默认折叠可展开，思考中显示占位动画。
- **会话管理交互**：会话重命名（编辑条）、顶栏按钮组、右键菜单、自定义会话列表浮层、菜单内两态删除。
- **感知主对话切换**：20 秒周期 + 焦点/可见性触发重新定位主会话（relocate 机制）。
- **健康自检**：`/api/diagnostics` 端点 + 面板内诊断清单（agentId/主会话定位/host 补丁/renderer 补丁/缓存/配置）。
- **删除键修复**：window.confirm 在 iframe 被静默禁用，改两态内联确认 + 专用 DELETE 端点。
- **Docker 开发容器**：node:24-alpine 基础镜像，冒烟测试支持容器内运行（SIDECHAT_HOME 环境变量）。

### host 补丁（升级后需重新检查）
- **sessionPath 注入补丁**：renderer 在 widget iframe URL 注入当前主会话路径（`SendButton-*.js` / `WorkspaceCompanionRail-*.js`），server `jot` 集合放行 `sessionPath` 参数；修复辅助会话串主对话的问题。
- **token 放行补丁**（0.1.0 已有）：server `jot` 集合放行 `token` 参数，修复 widget「加载失败」。
- 补丁检查/重打脚本：`debug/check-host-patch.js`、`debug/check-renderer-patch.js`、`debug/apply-sessionpath-patch.cjs`（幂等，自动备份）。

### 修复
- **安全与健壮性修复轮**（第三方代码审查 22 条，修复 13 项）：manifest 声明 selfPrompt（设置保存曾可能整体失败）；快照只渲染配对轮（pending 轮不重复注入）；store 原子复合更新（并发不丢轮）；轮数回退重建；全局轮次序号；预算计入 thinking；主题 CSS 反射型 XSS（实证）；主输入框 IME 误发送保护；设置保存失败提示；删除武装重置；创建超时放宽 90 秒；pending 空轮过滤。
- **审视修复轮**：SSE 自清理兜底（10 分钟超时，防泄漏）；缓存键含 sessionPath（修切主对话滞后）；normalizeHistory 过滤空 user 消息；mtime 兜底按 agent 过滤；full 模式总量自适应压缩（8 万字符预算）。
- 模块缓存坑处理（reload 后静态 import 不失效 → 动态 import 带时间戳）。

### 内部
- 回归三件套：`smoke-test.cjs`（语法/补丁/索引/Docker 联动）、`check-host-patch.js`、`check-renderer-patch.js`。
- `lib/patch-check.mjs` 抽离补丁检测共享逻辑。
- 版本 0.2.0 → 0.3.0，widget 版本号 v11 → v25（防 host 缓存旧资产）。

## [0.2.0] - 2026-08-16

### 新增
- **新建会话逻辑变更**：当前会话为空时禁止新建（按钮置灰+提示），聊过才能新建；删除后自动切换会话；无会话时可创建第一个；前端防连点锁。
- **增量摘要 + 状态接口轻量化**：`/api/state` 支持 `skipSummary`（零 LLM 调用）；摘要缓存复用判定（同会话/轮数不回退/一致才复用），修复每 5 秒轮询触发 LLM 采样导致成本失控的问题。
- **pollReply 修复**：不再重复渲染旧 assistant 消息；失败空轮询不再锁死输入框（超时退出）。

### 修复
- POST /messages 缓存写入与 collectMainContext 冲突隐患（摘要失败留下错配 lastRoundCount 导致误复用旧摘要，已删该段缓存写入，统一由 collectMainContext 维护）。
- 第三方代码审查 16 条发现：归属校验补全、会话识别标注、空消息过滤、session_busy 提示、缓存隔离、能力清理等。

### 清理
- 4 个测试会话文件 + 旧缓存移入回收目录（可恢复）；索引 16 → 12。
- 纠正 `agents\sidechat` 目录为活跃 agent 的误判（保留）。

### 内部
- 版本 0.1.0 → 0.2.0（manifest）；git 基线。

## [0.1.0] - 2026-08-15

### 新增（初始版本）
- **侧边栏纯 LLM 问答面板**：只聊天、不碰电脑（工具约束由提示词 boundary 压制，无能力级禁用）。
- **上下文三件套**：人格（跟随主对话 agent，官方管道自动注入）+ 主对话参考上下文（一问一答与思考，只读，自动同步）+ 自身对话历史。两套上下文严格分离（`context.system` = 边界声明、`context.beforeUser` = 参考材料）。
- **多会话**：可新建多个辅助会话，独立持久化（JSONL）；主对话切换不影响已有会话。
- **供应商一键导入**：从主设置读取供应商元数据（baseUrl/协议/模型列表，不含密钥），模型调用走 Hana 官方管道。
- **模型切换**：`session:create` 传扩展 `model: {id, provider}`（非官方契约，升级需回归）。
- **转送选择器**：查看主对话最近轮次，点「引入」把某一轮贴进输入框（带引用标记）。
- **上下文策略**：windowed（最近 N 轮+旧轮摘要）或 full（全量）；思考过程开关；N 可调。
- **agent 级归属隔离**：索引按 agentId 过滤；GET/POST/DELETE 三端点归属校验。
- **ready 握手**：修复 widget「加载失败」（app.js 首行 postMessage ready，renderer 状态机依赖）。
- **token 认证兜底**：无 cookie 时从页面 URL 提取 token 参数拼进 fetch；host server `jot` 集合放行 `token`（**host 补丁**，升级会覆盖需重打）。
- **模块缓存规避**：reload 后静态 import 缓存不失效 → 动态 import 带时间戳。

### 已知限制（初始版本即记录）
- 参考上下文 = 该 agent 最近修改的 public 会话（同 agent 多会话切换可能串内容，host 不提供主会话 id）。
- 附件仅文本引用（图片像素不可见，`session:send` 无多模态）。
- 「不动电脑」靠提示词约束（非能力禁用，概率性服从）。
- `model` 参数为非公开扩展字段。
