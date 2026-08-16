# SideChat 辅助对话

HanaAgent（OpenHanako）的侧边栏小对话插件：一个**纯 LLM 问答**面板，模仿 AI 客户端 的辅助对话体验。

它只会聊天，没有操作能力：不能调工具、不能改文件、不能跑命令。动手的事只归主对话。

## 功能特性

- **上下文三件套**：人格（跟随主对话当前 agent，官方管道注入）+ 主对话参考上下文（一问一答与思考过程，只读，自动同步）+ 自身对话历史。两套上下文严格分离，模型分得清「参考材料」和「自己的记忆」。
- **多会话**：可新建多个辅助会话，独立持久化；主对话怎么变都不影响已有会话。
- **树枝-树叶隔离**：辅助会话归属于创建它的主对话（boundMain），列表按主对话隔离显示，参考上下文跟随归属主对话；旧数据自动惰性归位。
- **快照+增量同步**：创建会话时对主对话打快照，之后发消息只增量追加新轮，不每次全量重读，省 token 省延迟。
- **思考内容可见**：辅助对话回复时先显示「思考中」，思考块（💭 默认折叠、点击展开）与正文分开展示（块级流式）。
- **供应商一键导入**：从主设置读取供应商元数据（baseUrl、协议、模型列表，不含任何密钥），模型调用走 Hana 官方管道。
- **模型切换**：设置里选供应商/模型，新建会话用新模型；旧会话保持创建时的模型。
- **上下文策略**：windowed（最近 N 轮 + 旧轮摘要，默认）或 full（全量）；可关思考过程、调轮数 N。
- **转送交互**：点面板顶部「主对话」指示条查看主对话最近轮次，点「引入」把某一轮贴进输入框（带引用标记）。
- **健康自检**：面板加载失败或设置里可运行诊断（agentId/主会话定位/host 补丁/renderer 补丁/缓存/配置一键体检）。
- **自我意识提示词**：设置面板可编辑，定义辅助对话身份与行为准则（默认值已内置）。

## 安装

1. 把本目录（或 release 包）复制到 `<HANA_HOME>\plugins\side-chat`。`HANA_HOME` 默认是 `C:\Users\<你的用户名>\.hanako`。
2. 打开 Hana 设置，确认「允许 full-access 插件」开关已开启（本插件需要 full-access 才能使用 session/agent API）。
3. 重启 Hana，或等待插件目录扫描。侧边栏出现「辅助对话」入口即安装成功。

升级版本时直接覆盖插件目录即可，插件数据（会话索引/配置/缓存）存在 `plugin-data\side-chat\`，不受影响。

## 使用

1. 在 Hana 侧边栏打开「辅助对话」面板。
2. 点「＋」新建会话（当前会话为空时按钮置灰，聊过才能新建），直接提问。发送时自动带上主对话参考上下文。
3. 点顶部「主对话：N 轮」指示条，可查看/引入主对话最近轮次。
4. 点「⚙」打开设置：切换上下文策略、供应商导入、模型选择、编辑自我意识提示词。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| 参考上下文策略 | windowed | windowed=最近 N 轮+旧轮摘要；full=全量 |
| 最近轮数 N | 30 | windowed 模式下保留的最近轮数 |
| 包含主对话思考过程 | 开 | 把主对话 thinking 一并注入参考上下文 |
| 辅助对话模型 | 空（自动选第一个） | 形如 `供应商/模型id`，在设置面板点选 |
| 自我意识提示词 | 内置默认 | 留空时使用插件内置默认值 |

## host 补丁说明（升级 Hana 后必读）

本插件真机可用依赖**两套 host 补丁**。Hana 升级会整体覆盖 artifacts 目录，补丁会全部丢失，需要重打：

| 补丁 | 位置 | 作用 | 丢失症状 |
|---|---|---|---|
| token 放行 | server `bundle/index.js` 的 `jot` 集合加 `"token"` | widget iframe ticket 校验放行 token | 面板「加载失败」 |
| sessionPath 注入 | renderer `SendButton-*.js` / `WorkspaceCompanionRail-*.js` + server `jot` 加 `"sessionPath"` | iframe URL 携带当前主会话真实路径 | 辅助会话串主对话（退化为猜测） |

检查与重打（升级后一键处理）：

```powershell
# 1. 检查（PASS/FAIL 逐项；默认探测本机 .hanako，可加 --home 或 $env:HANA_HOME 覆盖）
node debug\check-host-patch.js
node debug\check-renderer-patch.js
# 2. 重打（幂等，自动备份 .bak-<日期>）
node debug\apply-sessionpath-patch.cjs
# 3. 冒烟回归
node debug\smoke-test.cjs
```

补丁状态也可在面板「设置 → 运行诊断」里查看。这两处契约缺口已计划向 OpenHanako 仓库（liliMozi/openhanako）上报（见 ROADMAP ），官方支持后会移除补丁依赖。

## 工作原理（简述）

- 插件 API 路由挂载于 `/api/plugins/side-chat/`；widget 由 host 以 iframe 打开，URL 携带 `agentId`（host 原生）与 `sessionPath`（补丁注入，代表当前打开的主对话）。
- 主会话定位降级链：`sessionPath`（补丁）→ 绑定主会话 → 会话列表 → 最近修改（mtime 兜底）。
- 主对话内容主源为 JSONL 文件直读（host `session:history` 有 200 条上限且取最早消息），失败时降级 history API。
- 两套上下文分离：`context.system` 追加边界声明与自我意识提示词，`context.beforeUser` 前置参考材料（只读标签），均由 host 官方支持，不持久化为用户消息。
- 模型调用走 Hana 官方管道：`session:create` 传 `model: {id, provider}`（非公开契约的扩展字段，升级需回归验证）。

## 已知限制

- **附件像素级理解未实现**：图片以文本引用（`[SessionFile]` + 路径）进入参考上下文，看不到像素内容。`session:send` 无多模态注入。
- **「不动电脑」靠提示词约束**：会话绑定主对话 agent 会继承其工具集；Hana 无「完全禁用工具」机制。当前靠 boundary 强约束压制，实测诱导测试通过，但属概率性服从，非硬隔离。
- **补丁缺失时主会话定位退化**：无 `sessionPath` 时按「最近活跃会话」猜测，可能短暂串主对话。
- **模型参数为扩展字段**：`model` 参数非官方契约，Hana 升级后需回归验证模型切换。

## 开发与回归

```powershell
# 语法/补丁/索引/Docker 联动全量冒烟（可在 Docker 容器内跑：docker run -v "<HANA_HOME>:/hana:ro" -e SIDECHAT_HOME=/hana node:24-alpine node debug/smoke-test.cjs）
node debug\smoke-test.cjs
```

开发容器：`Dockerfile`（node:24-alpine）。内部交接文档见 `DEVELOPMENT_HANDOFF.md` 与各 `FIX_*.md`（含完整决策史与 API 契约实测记录）。

## License

MIT（见 [LICENSE](LICENSE)）。
