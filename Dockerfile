# side-chat 插件开发容器（纯 Node，零依赖）
# 用途：语法校验（node --check）、脚本运行（check-host-patch.js 等）、未来测试/打包
# 用法：docker build -t side-chat-dev .
#       docker run --rm -v "<PROJECT_DIR>/side-chat:/app" -w /app side-chat-dev node --check routes/api.js
FROM node:24-alpine
WORKDIR /app
# 项目零 npm 依赖，无需 COPY 源码；源码经 -v 挂载保持热更新
CMD ["node", "--version"]
