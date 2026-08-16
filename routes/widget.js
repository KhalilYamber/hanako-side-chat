// routes/widget.js —— widget 页面路由
// host 以 iframe 打开 /api/plugins/side-chat/widget?pluginIframeTicket=…&pluginSurfaceSession=…&agentId=…&hana-theme=…&hana-css=…
// hana-css 是 host 提供的主题样式表 URL（含认证 query），需注入 <head>。
// hana-theme 是主题名，挂到 <html data-theme> 上。

import fs from 'node:fs';
import path from 'node:path';

// 只允许同源的 theme.css URL，避免把任意外部地址注入页面。
// 用 URL 解析做同源校验：外部绝对/协议相对 URL 解析出的 host 与请求 host 不一致即拒绝
// （旧实现是子串匹配，https://evil.com/api/plugins/theme.css 可绕过，REVIEW1 发现 9 残余）。
function isSafeThemeCss(css, baseUrl) {
  if (!css || typeof css !== 'string' || css.length > 2000) return false;
  try {
    const u = new URL(css, baseUrl);
    if (u.host !== new URL(baseUrl).host) return false;
    if (u.pathname !== '/api/plugins/theme.css') return false;
    return true;
  } catch {
    return false;
  }
}

export default function registerWidgetRoutes(app, ctx) {
  const render = (c) => {
    const css = c.req.query('hana-css') || '';
    const theme = c.req.query('hana-theme') || '';
    const token = c.req.query('token') || '';
    const htmlPath = path.join(ctx.pluginDir, 'assets', 'widget.html');
    let html;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      return c.html('<h1>side-chat：widget 模板缺失</h1>', 500);
    }
    if (isSafeThemeCss(css, c.req.url)) {
      // REVIEW3 M6：注入必须用 URL 解析后的序列化结果（已 percent-encode），
      // 不能用原始 query 值——原始值可含 `"<>` 闭合 href 属性造成反射型 XSS（已实证）
      const safeHref = new URL(css, c.req.url).href;
      html = html.replace('</head>', `  <link rel="stylesheet" href="${safeHref}">\n</head>`);
    }
    if (theme && /^[a-zA-Z0-9_-]{1,64}$/.test(theme)) {
      html = html.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-theme="${theme}">`);
    }
    // 无 ticket 的请求（host 走 cookie 会话时会省略 ticket）不会触发 server 下发 asset cookie，
    // 导致 iframe 内引用 assets 时 403。这里把 token 注入 assets 引用 URL 以通过认证。
    if (token) {
      html = html.replace(
        /(\/api\/plugins\/side-chat\/assets\/[^"'\s]+)/g,
        (m) => `${m}${m.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      );
    }
    const res = c.html(html);
    // 防缓存加固：HTML 绝不允许被 webview/service worker 缓存（含 ticket 的 URL 不能复用旧响应）
    res.headers.set('Cache-Control', 'no-store');
    return res;
  };

  // 侧边栏 widget 面板
  app.get('/widget', (c) => render(c));
  // page 逃生入口：widget 面板若被 host 状态机误判，可用 page 方式打开同一界面
  app.get('/page', (c) => render(c));
}
