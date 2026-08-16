# PAGE_ARCHITECTURE —— /page 页面入口架构分层

## 现状（历史）

- `/widget` 与 `/page` 两个路由共用同一 `render`（routes/widget.js），渲染同一份 assets/widget.html。
- 前端 app.js 没有「widget/page 表面」概念，页面是侧栏的 1:1 复制品。
- `/page` 的历史用途：逃生入口，widget 面板被 host 状态机误判时，以页面方式打开同一界面。

## 本次分层（UI 零变化）

1. **data-surface 机制**
   - routes/widget.js：`render(c, mode)`，`/widget` → `'widget'`、`/page` → `'page'`。
   - 渲染时在 `<html>` 标签注入 `data-surface`：模板默认 `data-surface="widget"`（assets/widget.html），page 模式替换为 `page`；theme 注入与 data-surface 合并为一次替换。
   - assets/app.js：启动早期读取 `document.documentElement.dataset.surface || 'widget'` 存为常量 `SURFACE`。
2. **page-ext 扩展区**
   - assets/widget.html：body 末尾新增 `<div id="page-ext" class="hidden" data-page-ext>` 隐藏挂载点。
   - widget 模式与当前 page 模式均不显示，仅预留挂载位置。
3. **接口位（注释预留，未实现）**
   - app.js 初始化处 `[page-ext]` 扩展入口注释：`SURFACE === 'page'` 时未来在此挂载大界面功能。
   - 主会话定位代码附近 `[page-ext]` 接口注释：页面模式未来需获取当前主会话（sessionPath 注入或等价机制）。

## 未来方向

- **大界面功能挂载**：信息整理、写作分析等，`SURFACE === 'page'` 时挂入 `#page-ext`。
- **主会话传递修复**：`/page` 打开时正确获取当前主会话（sessionPath 注入或等价机制），当前只留接口位。
- **页面布局差异化**：基于 `data-surface` 的样式/布局选择器，让页面形态与侧栏分离。

## 维护注意

- routes/widget.js 的 `<html>` 替换目标串必须与 assets/widget.html 的 `<html lang="zh-CN" data-surface="widget">` 保持同步。
- `<body data-surface="widget">` 为历史遗留属性，本次分层机制以 `<html>` 标签的 data-surface 为准。
