# 发布 SOP（人 + Agent 共同遵守）

> 流水线文件：`.github/workflows/release.yml`。本地只做检查与推 tag；打包、校验、回归、发布全部由 GitHub Actions 完成。
> 一句话流程：**版本三处同步 → 本地回归 → `git tag vX.Y.Z` → `git push origin vX.Y.Z` → 云端接管。**

## 流水线做什么（推 tag 后自动）

| 步骤 | 内容 | 失败即止 |
| --- | --- | :---: |
| checkout | `fetch-depth: 0` 取 tag 与完整历史（默认 depth 1 不带 tag，发布会失败） | ✅ |
| 版本门禁 | tag（去 `v` 前缀）必须等于 `manifest.json` 的 `version`（版本唯一事实源） | ✅ |
| 打包 | `node scripts/pack-zip.mjs` → `dist/side-chat-<版本>.zip` + `.sha256` | ✅ |
| 校验 | `node scripts/verify-zip.mjs`（魔数 / EOCD / 条目数 / CRC 逐条 / sha256） | ✅ |
| 回归 | `node debug/smoke-test.cjs --json`（语法与补丁自测必过；索引 / Docker 项 CI 上自动跳过，属正常） | ✅ |
| 发布 | `gh release create`：附件 zip + sha256，notes 取 `CHANGELOG.md` 当前版本段落，标题 `Side Chat v<版本>` | — |

说明：

- Release author 显示 `github-actions[bot]`，属正常。
- notes 提取规则：从 `## [<版本>]` 行到下一个 `## [` 段落或一级标题为止（最新段落位于 CHANGELOG 顶部、`# Changelog` 总标题之前）；段落缺失则拒绝发布。
- `workflow_dispatch` 手动触发 = 干跑（打包 / 校验 / 回归，跳过发布步、不做 tag 比对），用于流水线改动后的无副作用验证。

## 发布前检查清单

1. **隐私扫描**：仓库内（含 git 历史与工作区）不得出现本机用户名、绝对路径、内部协作代号：

   ```bash
   # 工作区（已跟踪文件）；USERNAME 为环境变量，命令本身可安全写入文档/CI
   git grep -nI -e "$USERNAME" -e 'C:/Users' -e 'C:\Users' -e 'D:/' -e 'D:\' -- . || echo "工作区干净"
   # git 历史（有无泄漏过的痕迹）
   git log --all --oneline -S"$USERNAME" || echo "历史干净"
   ```

2. **版本号三处同步**（manifest 是唯一事实源）：
   - `manifest.json` 的 `version`；
   - `CHANGELOG.md` 新段落 `## [X.Y.Z] - 日期`（置于文件顶部）；
   - `README.md` 版本徽章。
3. **本地回归**：`node debug/smoke-test.cjs` 全绿。
4. **本地打包 + 校验一次**：`node scripts/pack-zip.mjs && node scripts/verify-zip.mjs`（产出 `dist/side-chat-<版本>.zip`，校验全过）。

## 发布动作

```bash
git tag vX.Y.Z
git push origin vX.Y.Z   # 推 tag 即触发流水线；代码提交（master）本身不触发
```

之后打开 Actions 页盯流水线，全绿即发布完成（本地若遇 schannel 报错：`git -c http.sslBackend=openssl push`，命令级参数，勿写全局配置）。

## 发布后验证

- Release 页面出现 `side-chat-X.Y.Z.zip` 与 `side-chat-X.Y.Z.zip.sha256` 两个附件，notes 为 CHANGELOG 当前版本段落；
- 下载 zip 解压抽查：顶层直接是 `assets/`、`lib/` 等（无外层目录），文件数与结构同上一版一致；
- （可选）本地对下载件复跑 `node scripts/verify-zip.mjs <下载的zip>` 交叉验证。

## 失败处理

1. Actions 红 → 打开失败 run，按步骤名定位环节（门禁 / 打包 / 校验 / 回归 / 发布），日志有具体原因；
2. 修复并提交到 master；
3. 删掉旧 tag 重打（tag 指向的提交不可变，修复必须落到新 tag）：

   ```bash
   git tag -d vX.Y.Z
   git push origin :refs/tags/vX.Y.Z
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

## 回滚

发布的版本本身有缺陷时：删 Release + 删 tag，必要时以旧版本号重走流程。

```bash
gh release delete vX.Y.Z --yes
git push origin :refs/tags/vX.Y.Z
```

## 协作约定（重要）

**发布是对外动作（改变他人可见状态）**：

- push tag 之前必须经用户确认；
- Agent 可自动准备一切（版本 bump / 打包 / 校验 / notes 生成 / 清单核对），确认之后才推 tag；
- 未经确认，Agent 不主动推任何 tag、不创建任何 Release、不删除既有 Release。

## 附：附件命名速查

| 产物 | 名称 |
| --- | --- |
| 插件包 | `side-chat-<版本>.zip` |
| 校验文件 | `side-chat-<版本>.zip.sha256`（sha256sum 格式：`<hash>  <文件名>`） |
