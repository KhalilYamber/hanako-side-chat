// main-context.js —— 主对话参考上下文采集器
// 官方通道为主：session:history（含 thinking）+ agent:profile（人格全文）+ agent:config（模型）。
// JSONL 文件解析仅作兜底（history API 不可用时）。

import fs from 'node:fs';
import path from 'node:path';

const CACHE_FILE = 'main-context-cache.json';

// ---------- 文件定位（兜底用） ----------

export function agentsRoot(ctx) {
  return path.join(path.dirname(path.dirname(ctx.pluginDir)), 'agents');
}

export function findMainSessionFile(ctx, sessionPath) {
  if (sessionPath && typeof sessionPath === 'string' && fs.existsSync(sessionPath)) {
    return sessionPath;
  }
  const root = agentsRoot(ctx);
  if (!root || !fs.existsSync(root)) return null;
  let best = null;
  let bestMtime = 0;
  try {
    for (const agentDir of fs.readdirSync(root)) {
      const sessDir = path.join(root, agentDir, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(sessDir, f);
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
    }
  } catch {
    // 忽略
  }
  return best;
}

// ---------- 官方历史 → 轮次 ----------

// session:history 返回 { messages: [{role, content, thinking?}], sessionId, sessionRef }
export function roundsFromHistory(messages) {
  const rounds = [];
  let pending = null;
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role ?? m.message?.role ?? null;
    const content = typeof m.content === 'string' ? m.content : (typeof m.text === 'string' ? m.text : '');
    const thinking = typeof m.thinking === 'string' ? m.thinking : '';
    if (role === 'user') {
      pending = { user: content, thinking: '', assistant: '' };
    } else if (role === 'assistant') {
      if (pending) {
        pending.thinking = thinking;
        pending.assistant = content;
        rounds.push(pending);
        pending = null;
      }
    }
  }
  // 未配对的最后一条 user 消息也保留（用户刚发、主对话还没回）
  if (pending) rounds.push({ ...pending, assistant: '', thinking: '' });
  return rounds;
}

// ---------- JSONL 兜底解析 ----------

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
        user: extractText(m.content),
        thinking: '',
        assistant: '',
        userTs: rec.timestamp,
        userMsgId: rec.id,
      };
    } else if (m.role === 'assistant' && pending) {
      const content = Array.isArray(m.content) ? m.content : [];
      const thinking = content.find((c) => c && c.type === 'thinking' && typeof c.thinking === 'string')?.thinking ?? '';
      pending.thinking = thinking;
      pending.assistant = extractText(content);
      pending.asstTs = rec.timestamp;
      rounds.push(pending);
      pending = null;
    }
  }
  if (pending) rounds.push(pending);
  return rounds;
}

// ---------- 组装参考上下文 ----------

function clamp(s, max = 4000) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n…（已截断）' : s;
}

export function buildReferenceContext(rounds, opts = {}) {
  const { windowSize = 30, includeThinking = true } = opts;
  if (!rounds.length) return '';
  const header = '【参考上下文 · 来自主对话最近活跃的会话（只读，供您引用，勿当作本对话自身的记忆）】';
  const lines = [header];
  const recent = rounds.slice(-windowSize);
  recent.forEach((r, idx) => {
    const n = rounds.length - recent.length + idx + 1;
    lines.push(`第 ${n} 轮：`);
    if (r.user) lines.push(`  您：${clamp(r.user)}`);
    if (includeThinking && r.thinking) lines.push(`  助手思考：${clamp(r.thinking, 2000)}`);
    if (r.assistant) lines.push(`  助手：${clamp(r.assistant)}`);
  });
  return lines.join('\n');
}

// ---------- 增量缓存 ----------

function cachePath(dataDir, agentId) {
  // 按 agent 分文件，避免跨主对话 agent 的缓存污染
  const name = agentId ? `main-context-cache-${String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json` : CACHE_FILE;
  return path.join(dataDir, name);
}

export function loadCache(dataDir, agentId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(dataDir, agentId), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 无缓存
  }
  return { lastRoundCount: 0, summaryText: '' };
}

export function saveCache(dataDir, state, agentId) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath(dataDir, agentId), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // 写缓存失败不致命
  }
}

// 摘要旧轮次（windowed 模式用）。失败返回 null，调用方降级。
export async function summarizeOld(ctx, oldRounds) {
  if (!oldRounds.length) return '';
  try {
    // 不编绝对轮次序号：摘要会被缓存复用，旧序号在复用后会漂移
    const text = oldRounds
      .map((r) => `您：${r.user?.slice(0, 800) ?? ''}\n   助手：${r.assistant?.slice(0, 800) ?? ''}`)
      .join('\n');
    const payload = {
      operation: 'sidechat-main-summary',
      messages: [
        {
          role: 'system',
          content:
            '你是摘要助手。把用户提供的主对话早期问答压缩成一份简洁的中文摘要（保留关键决策、结论、约定、文件与主题），200~400 字。不要使用"第 N 轮"这类绝对序号。',
        },
        { role: 'user', content: text },
      ],
      maxTokens: 600,
    };
    let res;
    if (typeof ctx.bus?.request === 'function') {
      res = await ctx.bus.request('model:sample-text', payload);
    }
    const out = res?.text ?? res?.result?.text ?? res?.content ?? '';
    if (typeof out === 'string' && out.trim()) return out.trim();
  } catch (e) {
    ctx.log?.warn?.('[side-chat] summarize failed', String(e?.message ?? e));
  }
  return null;
}
