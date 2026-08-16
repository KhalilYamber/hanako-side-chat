// lib/host-adapter-dsh.js —— host-adapter 第二后端（DeepSeek Harness web host）
// 试点代码：验证 host-adapter 抽象能否复用到第二宿主。未接入插件主流程。
// 与 lib/host-adapter.js（Hana 版）同接口签名风格；业务侧只需换后端即可复用。
//
// DSH 契约（0.1.0-rc.6，2026-08-16 实测）：
//   POST /api/<method>，body {type:'client-request', rpcId, method, payload}
//   响应 {rpcId, result:{ok, value|error}}；rpcId 回显校验
//   session.list   → {items:[{sessionId, updatedAt, running, blank, cwd, agentPreset,
//                             projections:{title, contextPressure, tokenUsage, ...}}]}
//   session.create → {sessionId, agentPreset}（payload: cwd/agentPreset/sessionId/workspaceId/title）
//   session.prompt → {accepted:true}（异步；payload: {sessionId, mode:'queue'|'steer',
//                             content:[{type:'text', text}]}）
//   session.history→ {events:[{event:{type,seq,time,data}}], hasMore, projections}（事件流，无 200 条上限）
//   session.cancel → 取消
// 无 ticket/认证概念（本地服务）；升级需回归。

let rpcSeq = 0;
function nextRpcId() {
  rpcSeq += 1;
  return `scdsh-${Date.now()}-${rpcSeq}`;
}

export function createClient(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('host-adapter-dsh: baseUrl 必填');

  async function call(method, payload = {}) {
    const rpcId = nextRpcId();
    let res;
    try {
      res = await fetch(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      });
    } catch (e) {
      throw new Error(`host-adapter-dsh: ${method} 网络错误 ${e.message}`);
    }
    if (!res.ok) throw new Error(`host-adapter-dsh: ${method} HTTP ${res.status}`);
    const full = await res.json();
    if (!full || full.rpcId !== rpcId) throw new Error(`host-adapter-dsh: ${method} rpcId 不匹配`);
    if (!full.result || !full.result.ok) {
      const e = full.result?.error || {};
      throw new Error(`host-adapter-dsh: ${method} 失败 ${e.code || 'unknown'} ${e.message || ''}`);
    }
    return full.result.value;
  }

  /** 健康检查：GET / 返回 200 即视为服务可用 */
  async function health() {
    const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`host-adapter-dsh: 健康检查 HTTP ${r.status}`);
    return true;
  }

  return {
    health,
    call,
    listSessions: (projections) => call('session.list', projections ? { projections } : {}),
    createSession: ({ cwd, agentPreset, sessionId, workspaceId, title } = {}) => {
      const payload = {};
      if (workspaceId) payload.workspaceId = workspaceId;
      if (cwd) payload.cwd = cwd;
      if (sessionId) payload.sessionId = sessionId;
      if (agentPreset) payload.agentPreset = agentPreset;
      if (title) payload.title = title;
      return call('session.create', payload);
    },
    sendMessage: (sessionId, text, { mode = 'queue' } = {}) =>
      call('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] }),
    readHistory: (sessionId, { limit } = {}) =>
      call('session.history', limit ? { sessionId, limit } : { sessionId }),
    cancelSession: (sessionId) => call('session.cancel', { sessionId }),
  };
}

/**
 * 主会话定位：DSH 无「当前打开会话」暴露，取最近活跃会话（updatedAt 最大，
 * 与 Hana 版 mtime 降级链同语义）；explicitSessionId 显式优先。
 * @returns {Promise<{path: string, method: 'explicit'|'recent'}>}
 */
export async function resolveMainSessionPath(client, { explicitSessionId } = {}) {
  if (explicitSessionId) return { path: explicitSessionId, method: 'explicit' };
  const { items = [] } = await client.listSessions(['id', 'updatedAt', 'title']);
  if (!items.length) throw new Error('host-adapter-dsh: 无任何会话可定位');
  const recent = items.reduce((a, b) => ((a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b));
  return { path: recent.sessionId, method: 'recent' };
}

/**
 * 会话历史 → 文本消息轮次（用于上下文收集）。
 * DSH history 是事件流，消息全文事件类型以实测为准；本辅助按
 * user 消息事件与 assistant 文本块拼装，未匹配到的类型忽略。
 */
export function toMessages(events, { limit = 50 } = {}) {
  const out = [];
  const textOf = (data) => {
    if (typeof data.text === 'string') return data.text;
    // 实测：user/assistant 消息的 content 是 [{type:'text',text}] 数组结构
    if (Array.isArray(data.content)) {
      return data.content
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .join('\n');
    }
    return JSON.stringify(data);
  };
  for (const item of events || []) {
    const ev = item?.event ?? item;
    const type = ev?.type || '';
    const data = ev?.data ?? {};
    if (type === 'user/message') {
      out.push({ role: 'user', content: textOf(data) });
    } else if (type === 'assistant/message') {
      out.push({ role: 'assistant', content: textOf(data) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ---- 与 Hana 版接口对齐的占位（DSH 无对应概念） ----
export const resolveToken = () => ''; // DSH 本地服务无 ticket 概念
export const injectAssetsToken = (html) => html; // DSH 无 assets 认证注入
export const sampleText = null; // DSH 无 model:sample-text（未适配，标注）
