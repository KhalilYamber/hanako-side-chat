// host-adapter.js —— host 行为依赖适配层（HOST_ADAPTER.md 迁移步骤 1/2/3/5；步骤 4 为前端确认项）
// 本模块承载「主会话定位」相关 host 依赖（五级降级链 resolveMainSessionPath、
// 白名单校验 isAgentSessionPath、public 路径集合 getPublicSessionPaths、
// 路径规范化 normSessionPath、文件直读定位 agentsRoot/findMainSessionFile/
// parseSessionJsonl）、「host 官方 API 封装」（createSession/readHistory/
// sendMessage/sampleText，HOST_ADAPTER.md 3.1 的 host API 封装块）与
// 「凭证解析」（resolveToken/injectAssetsToken，自 routes/widget.js 迁入，步骤 3）。
// 步骤 4（前端）：app.js 的 SESSION_PATH 透传属补丁契约，adapter 后端接口不变，无动作。
// 业务逻辑一律不进本模块（控制粒度，防上帝模块）。
//
// 模块缓存坑：routes/lib 之间用带时间戳的动态 import（见 routes/api.js 的 loadAdapter），
// 本模块内部不静态 import 其它 lib 模块（node 内置模块无缓存问题）。
// 本文件为 ESM：默认导出不使用，调用方按命名导出动态引用。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 主会话定位（五级降级链） ----------

// 从 widget 请求里解析主会话身份（T3 修正版 + 2026-08-16 主会话绑定增强）
// host 打开 widget 的 iframe URL 会带 agentId query（X-Hana-Plugin-Surface-Session 头
// 在转发到插件路由前已被 server 剥离，不可用）。主会话解析优先级：
//   0. query 显式 sessionPath（host 补丁注入的「当前打开主对话」真实路径，白名单校验）
//   1. 前端透传的 mainPath（SSE 事件实时追踪的「最近活跃主会话」，白名单 + public 校验）
//   2. query 显式 sessionId/session（调试，走首行扫描兜底）
//   3. agentId → session:list 取最近修改的 public 会话
//   4. mtime 兜底（仅当官方通道不可用）
// skipMainPath=true（relocate 重定位）时跳过 1，直接走 2/3/4（mtime 系重新定位）。
export async function resolveMainSessionPath(pctx, c, skipMainPath = false) {
  const agentId = c.req.query('agentId') || '';
  const tryPath = (p) => (isAgentSessionPath(pctx, p, agentId) ? p : null);
  // 0. host 补丁注入的 sessionPath（iframe URL 携带的「当前打开主对话」真实路径），最优先
  const sp = c.req.query('sessionPath') || '';
  if (sp && sp.includes('.jsonl')) {
    const ok = tryPath(sp);
    if (ok) return ok;
    // 白名单不过：忽略，继续走后续兜底
  }
  // 1. 前端 SSE 追踪的最近活跃主会话（次精确）
  const mp = c.req.query('mainPath') || '';
  if (!skipMainPath && mp) {
    if (isAgentSessionPath(pctx, mp, agentId)) {
      // 追加 public 校验：辅助会话（plugin_private）路径同样能过白名单，必须排除，
      // 否则 SSE 污染会让主会话定位指向辅助会话自身（参考上下文自噬）
      const publics = await getPublicSessionPaths(pctx);
      if (publics.has(normSessionPath(mp))) return mp;
    }
    // 非法/非 public：忽略，继续走后续兜底
  }
  // 2. query 显式 sessionId/session（调试：非路径形式的会话 id，走首行扫描兜底）
  const q = c.req.query('sessionId') || c.req.query('session') || '';
  if (q) {
    try {
      const root = agentsRoot(pctx);
      if (fs.existsSync(root)) {
        for (const agentDir of fs.readdirSync(root)) {
          const sessDir = path.join(root, agentDir, 'sessions');
          if (!fs.existsSync(sessDir)) continue;
          for (const f of fs.readdirSync(sessDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const p = path.join(sessDir, f);
            try {
              const first = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0];
              if (first && first.includes(q)) return p;
            } catch {
              // 跳过
            }
          }
        }
      }
    } catch {
      // 忽略
    }
  }
  // 3. agentId → 官方 session:list，取最近修改的 public 会话（主对话）
  if (agentId) {
    try {
      const res = await pctx.bus.request('session:list', { agentId });
      const publics = (res?.sessions ?? []).filter(
        (s) => s && s.path && s.visibility === 'public'
      );
      if (publics.length) {
        publics.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
        return publics[0].path;
      }
    } catch {
      // 继续走文件兜底
    }
  }
  // 4. mtime 兜底（仅当官方通道不可用时，按当前 agent 过滤，REVIEW2 发现 13）
  return findMainSessionFile(pctx, null, agentId);
}

// ---------- 白名单 ----------

// 白名单：路径必须是 <HOME>/agents/<agentId>/sessions/*.jsonl 的绝对路径
// （防御 query 注入任意路径读取）
export function isAgentSessionPath(pctx, p, agentId) {
  try {
    if (typeof p !== 'string' || !p.includes('.jsonl')) return false;
    const home = path.dirname(path.dirname(pctx.pluginDir));
    const agentsDir = path.resolve(path.join(home, 'agents'));
    const rp = path.resolve(p);
    const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
    const ad = norm(agentsDir);
    const rr = norm(rp);
    if (!rr.startsWith(ad + '/')) return false;
    if (agentId) {
      const seg = rr.slice(ad.length + 1).split('/');
      if (seg[0] !== String(agentId).toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- public 会话路径集合 ----------

// public 主会话路径集合（规范化、去重）。带 60 秒全局缓存（SSE 过滤与 mainPath 校验共用）。
// 失败时返回旧缓存或空集合：SSE 不透传（保守，走 mtime 兜底），功能降级不崩溃。
export async function getPublicSessionPaths(pctx, force = false) {
  const g = globalThis.__sideChat;
  const now = Date.now();
  if (!force && g?.publicPathsCache && now - g.publicPathsCache.ts < 60000) {
    return g.publicPathsCache.paths;
  }
  const paths = new Set();
  try {
    const res = await pctx.bus.request('session:list', {});
    for (const s of res?.sessions ?? []) {
      if (s && s.path && s.visibility === 'public') paths.add(normSessionPath(s.path));
    }
  } catch {
    // 拉取失败：保持空集合（或旧缓存），下游降级
  }
  if (g) g.publicPathsCache = { ts: now, paths };
  return paths;
}

// ---------- 路径规范化 ----------

// 路径规范化：大小写与 \/ 分隔符统一（与 isAgentSessionPath 里的 norm 写法一致）
export function normSessionPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : '';
}

// ---------- 文件定位（兜底用） ----------

export function agentsRoot(ctx) {
  return path.join(path.dirname(path.dirname(ctx.pluginDir)), 'agents');
}

// 兜底：找最近修改的会话文件。agentId 存在时只扫该 agent 的 sessions 目录
// （REVIEW2 发现 13：原实现遍历所有 agent，官方通道失败时会跨 agent 取错主会话）。
export function findMainSessionFile(ctx, sessionPath, agentId) {
  if (sessionPath && typeof sessionPath === 'string' && fs.existsSync(sessionPath)) {
    return sessionPath;
  }
  const root = agentsRoot(ctx);
  if (!root || !fs.existsSync(root)) return null;
  let best = null;
  let bestMtime = 0;
  const scanDir = (dir) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > bestMtime) {
            best = p;
            bestMtime = st.mtimeMs;
          }
        } catch {
          // 跳过
        }
      }
    } catch {
      // 忽略
    }
  };
  try {
    if (agentId) {
      // 只扫指定 agent（宁缺毋滥：跨 agent 串上下文比找不到更糟）
      scanDir(path.join(root, String(agentId), 'sessions'));
    } else {
      for (const agentDir of fs.readdirSync(root)) {
        scanDir(path.join(root, agentDir, 'sessions'));
      }
    }
  } catch {
    // 忽略
  }
  return best;
}

// ---------- JSONL 兜底解析 ----------

// extractText 副本（与 lib/main-context.js 同名函数同实现）：原函数仍被
// main-context.js 的 roundsFromHistory 使用而保留原处，adapter 自备一份。
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export function parseSessionJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const rounds = [];
  let pending = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== 'message' || !rec.message) continue;
    const m = rec.message;
    if (m.role === 'user') {
      pending = {
        // content 兼容字符串与数组（多模态取 text 块）
        user: typeof m.content === 'string' ? m.content : extractText(m.content),
        thinking: '',
        assistant: '',
        userTs: rec.timestamp,
        userMsgId: rec.id,
      };
    } else if (m.role === 'assistant' && pending) {
      const content = Array.isArray(m.content) ? m.content : [];
      const thinking = content.find((c) => c && c.type === 'thinking' && typeof c.thinking === 'string')?.thinking ?? '';
      pending.thinking = thinking;
      // content 兼容字符串与数组（与 user 分支同口径，2026-08-16）
      pending.assistant = typeof m.content === 'string' ? m.content : extractText(content);
      pending.asstTs = rec.timestamp;
      // 空轮过滤：user 与 assistant 均为空不入列（与 roundsFromHistory 口径一致）
      if (pending.user.trim() || pending.assistant.trim()) rounds.push(pending);
      pending = null;
    }
  }
  // 未配对的最后一条 user 消息也保留（用户刚发、主对话还没回）；
  // REVIEW3 L1：空内容 pending 不入列（与 roundsFromHistory 口径一致，防流式中断产物空轮）
  if (pending && (pending.user.trim() || pending.assistant.trim())) rounds.push(pending);
  return rounds;
}

// ---------- host 官方 API 封装（HOST_ADAPTER.md 迁移步骤 2） ----------
// session:create / session:history / session:send 收拢于此：调用点、参数语义、
// 返回结构解析与错误路径与迁移前（routes/api.js 直连 bus.request 时代）完全一致。
// 只收拢调用，不改变 bus 调用方式（仍走 pctx.bus.request）。

// 创建辅助会话（session:create）。
// opts: { agentId, model?, cwd? }——cwd 缺省用 pctx.dataDir（迁移前固定值）。
// 注意：model 为非官方契约扩展字段（实测生效：会话 model_change 记录正确），
// host 升级需回归验证该字段仍被接受。
// 返回 { sessionId, sessionPath }：兼容三种字段形态（顶层/ session.* / sessionRef.*），
// 结构不完整时抛错（message 与迁移前一致）。
export async function createSession(pctx, opts) {
  const res = await pctx.bus.request('session:create', {
    visibility: 'plugin_private',
    ownerPluginId: pctx.pluginId,
    kind: 'sidechat',
    cwd: opts?.cwd ?? pctx.dataDir,
    agentId: opts?.agentId,
    ...(opts?.model ? { model: opts.model } : {}),
  });
  const sessionId = res?.sessionId ?? res?.session?.id ?? res?.sessionRef?.sessionId ?? null;
  const sessionPath = res?.sessionPath ?? res?.session?.sessionPath ?? res?.sessionRef?.sessionPath ?? null;
  if (!sessionId || !sessionPath) {
    throw new Error(`session:create 返回结构不完整：${JSON.stringify(res).slice(0, 300)}`);
  }
  return { sessionId, sessionPath };
}

// 读会话历史（session:history）。limit 透传（调用处 200/500 语义不变），
// 返回原始响应（res?.messages 由调用方按需解析）。
export async function readHistory(pctx, sessionPath, limit) {
  return pctx.bus.request('session:history', { sessionPath, limit });
}

// 发送消息（session:send）。payload 原样透传
// （含 sessionPath/text/context，context 为 system/beforeUser 两套上下文）。
export async function sendMessage(pctx, payload) {
  return pctx.bus.request('session:send', payload);
}

// 模型采样（model:sample-text）。payload 原样透传，返回原样。
// 保留 bus 缺失防御（迁移前 summarizeOld 的 typeof 检查）：bus 不可用时返回 undefined，
// 调用方按 res?.text 缺省路径降级（摘要失败返回 null），行为与迁移前一致。
export async function sampleText(pctx, payload) {
  if (typeof pctx.bus?.request !== 'function') return undefined;
  return pctx.bus.request('model:sample-text', payload);
}

// ---------- 凭证解析（HOST_ADAPTER.md 迁移步骤 3，自 routes/widget.js 迁入） ----------

// 解析 iframe URL 的 token query（host 走 cookie 会话时省略，返回 '' 缺省）。
// 接收 Hono request context（widget.js 的 c），内部经 c.req.query 取值，行为与迁移前一致。
export function resolveToken(c) {
  return c?.req?.query('token') || '';
}

// 把 token 注入 html 中 assets 引用 URL（无 ticket 的请求不会触发 server 下发 asset cookie，
// iframe 内引用 assets 会 403；带 token 追加到引用 URL 以通过认证）。
// 无 token 时原样返回 html；有 token 时对 /api/plugins/side-chat/assets/ 引用追加
// ?token= / &token=（encodeURIComponent 编码），与迁移前 routes/widget.js 逻辑逐字一致。
export function injectAssetsToken(html, token) {
  if (!token) return html;
  return html.replace(
    /(\/api\/plugins\/side-chat\/assets\/[^"'\s]+)/g,
    (m) => `${m}${m.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  );
}
