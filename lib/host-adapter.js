// host-adapter.js —— host 行为依赖适配层（HOST_ADAPTER.md 迁移步骤 1）
// 本模块只承载「主会话定位」相关 host 依赖：五级降级链（resolveMainSessionPath）、
// 白名单校验（isAgentSessionPath）、public 路径集合（getPublicSessionPaths）、
// 路径规范化（normSessionPath）、文件直读定位（agentsRoot/findMainSessionFile/
// parseSessionJsonl）。业务逻辑一律不进本模块（控制粒度，防上帝模块）。
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
