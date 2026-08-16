# side-chat 开发 / 测试 / 打包容器化

side-chat 是纯 JS、零 npm 依赖的 Hana 插件。容器只覆盖**开发 / 测试 / 打包**三件事，**不容器化运行环境**（插件跑在宿主 Hana 里）。镜像只承载 Node 24 + git + bash，源码经卷挂载（`.:/app`）热更新，不 COPY 进镜像。

## 1. 前置：安装 Docker Desktop（Windows）

1. 到 <https://www.docker.com/products/docker-desktop/> 下载 Docker Desktop for Windows，按向导安装。
2. 安装后启动 Docker Desktop，等右下角鲸鱼图标变绿（引擎就绪）。
3. 打开 PowerShell，确认版本：

   ```powershell
   docker --version
   docker compose version
   ```

> 若之前装过，务必保证 **WSL 2 后端**已启用（Docker Desktop → Settings → General → Use the WSL 2 based engine），卷挂载与 `host.docker.internal` 才最稳。

## 2. 构建镜像

在仓库根目录执行一次：

```powershell
docker compose build
```

产出本地镜像 `side-chat-dev`。之后源码改动无需重新构建（卷挂载热更新），只有改 Dockerfile 才需要重建。

## 3. 三个入口

| 场景 | 命令 | 说明 |
|---|---|---|
| 开发（旧用法兼容） | `docker compose run --rm dev` | 等价 `node --version` |
| 语法全检 | `docker compose run --rm dev node scripts/check-all.mjs` | 遍历仓库全部 .js/.mjs/.cjs 逐个 `node --check` |
| 跑测试（4 项必跑） | `docker compose run --rm test` | md-render-test / smoke-test / check-host-patch / check-renderer-patch |
| 跑单项测试 | `docker compose run --rm dev node scripts/run-tests.mjs --only <name>` | name 见 `--help`，含可选 `dsh-adapter-demo` |
| 打包 | `docker compose run --rm pack` | 产物 `dist/side-chat-<version>.zip` + `.sha256` |
| 交互式 | `docker compose run --rm dev sh` | 进容器调试 |

旧的手动用法依旧可用（Dockerfile 保持 `WORKDIR /app` + `CMD ["node","--version"]`）：

```powershell
docker run --rm -v "${PWD}:/app" -w /app side-chat-dev node --check routes/api.js
```

### 单项 / 筛选

```powershell
# 只跑 markdown 单测
docker compose run --rm dev node scripts/run-tests.mjs --only md-render-test

# 只跑 DSH 数据流验证（需宿主 DSH 服务已监听 3080）
docker compose run --rm dev node scripts/run-tests.mjs --only dsh-adapter-demo
```

## 4. 可选：挂载宿主 .hanako

`smoke-test` 的索引完整性检查、补丁检测脚本会读宿主 `.hanako` 目录。默认**不挂载**（相关检查优雅跳过，不计失败）。要启用：

1. 编辑 `docker-compose.yml` 的 `test` 服务，取消这两行注释，并把路径改成你的真实路径：

   ```yaml
   volumes:
     - .:/app
     - C:/Users/你的用户名/.hanako:/hana:ro   # 取消注释
   environment:
     - SIDECHAT_HOME=/hana                     # 取消注释
   ```

2. 重新跑：`docker compose run --rm test`。

## 5. 常见问题

**卷挂载看不到改动 / 很慢？**
源码经 `.:/app` 挂载，改动即时可见。side-chat 无 node_modules，性能无影响。若 Windows 上改动不生效，重启 Docker Desktop 后再试。

**`host.docker.internal` 连不上宿主服务？**
`docker-compose.yml` 已统一加 `extra_hosts: "host.docker.internal:host-gateway"`（Docker Desktop 与 Linux 均兼容）。DSH 数据流验证默认连 `http://host.docker.internal:3080`，用 `DSH_BASE_URL` 环境变量可覆盖。宿主 DSH 服务需监听 0.0.0.0 或至少对容器网段可达。

**打包产物写不进 `dist/`（Linux 原生 Docker）？**
容器以非 root 用户 `sidechat` 运行。Windows/macOS Docker Desktop 卷挂载权限宽松，无此问题；Linux 下若 `pack` 报权限错误，先 `mkdir -p dist && chmod 777 dist`，或改用与宿主同 UID 运行（Dockerfile 的 `USER` 行上方加 `--build-arg` 映射，非默认行为）。

**行尾符（LF / CRLF）？**
`pack-zip.mjs` 用 `git ls-files` 原样打包，zip 内文本行尾与宿主工作区一致。跨平台要统一 LF 时，加 `.gitattributes`（`* text=auto eol=lf`）再 `git add --renormalize .`，此处不强制。

**`git ls-files` 报错？**
打包需在 git 仓库内、且 `git` 可执行（镜像已 `apk add git`）。宿主直跑时确保系统已装 git 并 `git init`/clone 过。
