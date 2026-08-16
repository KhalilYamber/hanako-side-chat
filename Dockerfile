# side-chat 插件开发容器（纯 Node，零依赖）
# 覆盖「开发 / 测试 / 打包」三件事；插件运行仍在宿主 Hana 中，不容器化。
# 不 COPY 源码：源码经卷挂载（-v .:/app）保持热更新，镜像只承载 Node + git + bash 运行时。
#
# 用法（旧用法保持兼容）：
#   docker build -t side-chat-dev .
#   docker run --rm -v "${PWD}:/app" -w /app side-chat-dev node --check routes/api.js
# 或经 compose（推荐）：
#   docker compose run --rm dev | test | pack
FROM node:24-alpine

# git：pack-zip 打包清单（git ls-files）与未来 CI 需要；bash：交互调试便利
RUN apk add --no-cache git bash

WORKDIR /app

# 非 root 用户（安全基线）：sidechat
RUN addgroup -S sidechat && adduser -S sidechat -G sidechat
USER sidechat

CMD ["node", "--version"]
