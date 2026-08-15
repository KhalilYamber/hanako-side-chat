# SideChat 辅助对话

HanaAgent（OpenHanako）侧边栏小对话插件：一个**纯 LLM 问答**面板，模仿 AI 客户端 的辅助对话体验。

它只会聊天，没有任何操作能力：不能调工具、不能改文件、不能跑命令。动手的事只归主对话。

## 功能

- **上下文三件套**：人格（跟随主对话当前 agent）+ 主对话参考上下文（一问一答与思考过程，只读）+ 自身对话历史。两套上下文严格分离，模型分得清「主对话给的参考材料」和「自己的记忆」。
- **多会话**：可新建多个辅助会话，独立持久；主对话怎么变都不影响已有会话。
- **自动同步**：发消息时增量采集主对话内容，UI 定时刷新状态。
- **供应商一键导入**：从主设置读取供应商元数据（baseUrl、协议、模型列表，不含任何密钥），模型调用走 Hana 官方管道。
- **模型切换**：设置里选择供应商/模型，新建的会话使用新模型；旧会话保持创建时的模型。
- **转送交互**：点击面板顶部「主对话」指示条，可查看主对话最近轮次，点「引入」把某一轮贴进输入框（带引用标记）。
- **上下文策略**：windowed（最近 N 轮 + 旧轮摘要，默认）或 full（全量）；可关思考过程、调轮数 N。

## 安装

### 开发安装（推荐调试用）

```powershell
# 通过插件开发通道安装（需要 allowFullAccess）
# plugin_dev_install sourcePath=<PROJECT_DIR>/side-chat allowFullAccess=true
```

修改代码后 `plugin_dev_reload`（每次 reload 会返回新的 devRunId）。

### 正式安装

1. 将本目录复制到 `<HANA_HOME>\plugins\side-chat`（HANA_HOME 默认为 `C:\Users\<用户>\.hanako`）。
2. 确认 Hana 设置里的「允许 full-access 插件」开关已打开。
3. 重启或等待 Hana 扫描插件目录。

注意：正式安装后，dev 版（plugins-dev）会被正式版 shadow，可在插件设置里卸载 dev 槽位。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| 参考上下文策略 | windowed | windowed=最近 N 轮+旧轮摘要；full=全量 |
| 最近轮数 N | 30 | windowed 模式下保留的最近轮数 |
| 包含主对话思考过程 | 开 | 把主对话 thinking 一并注入参考上下文 |
| 辅助对话模型 | 空（自动选第一个） | 形如 `供应商/模型id`，在设置面板里点选即可 |

## 使用

1. 在 Hana 侧边栏打开「辅助对话」面板。
2. 点「＋」新建会话，直接提问。发送时自动带上主对话参考上下文。
3. 点顶部「主对话：N 轮」指示条，选择某轮「引入」输入框再发送。
4. 点「⚙」打开设置：切换上下文策略、供应商导入、模型选择。

## 目录结构

```
side-chat/
├── manifest.json       # full-access，widget 声明，configuration schema
├── index.js            # 生命周期入口
├── lib/
│   ├── store.js        # 辅助会话索引（JSON 落 dataDir）
│   └── main-context.js # 主对话上下文采集与组装
├── routes/
│   ├── api.js          # 会话 CRUD、发消息、设置、供应商、主对话预览/轮次
│   └── widget.js       # /widget 页面路由（注入 host 主题）
├── assets/
│   ├── widget.html     # widget 页面结构
│   ├── widget.css      # 样式（跟随 Hana CSS 变量）
│   └── app.js          # 前端逻辑（fetch + token 兜底认证）
└── debug/              # 开发调试工具（probe/test-bus/verify，正式版不注册）
```

## 技术要点（接手者须知）

- **插件 API 路由**挂载于 `/api/plugins/side-chat/`；`routes/*.js` 的 default export 会被 `(honoApp, ctx)` 调用。
- **主会话定位**：host 打开 widget 时在 iframe URL 传 `agentId` query；后端用官方 `session:list` 取该 agent 最近修改的 public 会话。`X-Hana-Plugin-Surface-Session` 头在转发到插件前会被 server 剥离，不可用。
- **context 注入**：`session:send` 的 `context.system`（追加到 system 消息）、`context.beforeUser`（前置到用户消息）由 server 官方支持，不持久化为用户消息。
- **人格跟随**：会话创建时绑定主对话 agent（`session:create` 的 `agentId`），官方管道自动注入该 agent 完整人格，无需手动注入。
- **模型绑定**：`session:create` 传 `model: { id, provider }`。PLUGIN_SDK.md 能力表未列此参数，但 server 实测支持（会话 jsonl 出现对应 model_change 记录）。
- **模块缓存坑**：插件 reload 时 Node 对静态 import 的子模块缓存不失效，`lib/*.js` 必须用带时间戳的动态 import 加载。
- **前端认证兜底**：真实环境走 hana_session cookie；无 cookie 时从页面 URL 提取 `token` 参数拼进 fetch。
- **插件配置**：`ctx.config.get()` 读全部、`ctx.config.setMany(obj)` 批量写（受 manifest schema 校验）、`ctx.config.set(key, value)` 单键写。供应商快照存于 manifest 声明的 `providerImportJson` 字段。

## 已知限制

- **附件像素级理解未实现**：用户发过的图片目前以文本引用（`[SessionFile]` + `[attached_image: 路径]`）进入参考上下文，辅助对话看不到图的像素内容。`session:send` 不支持多模态图片注入，此需求仅满足文本层，像素级为后续项。
- **「不动电脑」靠提示词约束**：会话绑定主对话 agent 会继承其工具集；Hana 无「完全禁用工具」机制（核心工具不可禁用、`session:create` 无工具控制字段）。当前靠 boundary 强约束（「绝不调用任何工具」）压制，实测诱导测试通过，但属概率性服从，非硬隔离。
- **主会话 = 最近活跃会话**：拿不到「当前打开」的主会话 id，参考上下文定位为该 agent 最近修改的 public 会话，非严格实时当前会话。
- **agent 级归属**：辅助会话按主对话 agent 隔离（维护者域/空老师域各自独立）。session 级（同一 agent 下多个主会话之间）隔离依赖 host 提供主会话 id，暂未实现。

## host 补丁升级检查（重要）

本插件真机可用依赖一处 Hana server 侧补丁：`artifacts\server\0.446.6-win32-x64\bundle\index.js` 的 `jot` 集合加入 `"token"`，修复 widget iframe 的 ticket 校验。**Hana 升级会覆盖 artifacts 目录，导致补丁丢失、widget 复现「加载失败」**。

升级后检查：

1. 升级 Hana 后打开侧边栏「辅助对话」，若显示「加载失败」；
2. 检查 `bundle\index.js` 中 `jot` 集合（`new Set([...])`）是否含 `"token"`（原版备份在 `bundle\index.js.bak-20260815`）；
3. 若不含，重新加入 `"token"` 并重启 Hana；
4. 建议向 OpenHanako 仓库（liliMozi/openhanako）上报该契约 bug，争取官方修复。
