// main-context.js —— 主对话参考上下文采集器
// 主源文件直读（parseSessionJsonl）已迁入 lib/host-adapter.js（HOST_ADAPTER.md 迁移步骤 1），
// 由 routes/api.js 经 loadAdapter() 动态引用；本文件保留官方历史 → 轮次（roundsFromHistory）
// 与参考上下文组装/增量缓存/摘要等纯业务逻辑。
// agent:profile（人格全文）+ agent:config（模型）仍走官方通道；session:history 仅作兜底。

import fs from 'node:fs';
import path from 'node:path';

const CACHE_FILE = 'main-context-cache.json';

// ---------- 官方历史 → 轮次 ----------

function extractContent(m) {
  // 兼容三种形态：字符串 / 数组（多模态，取 text 块） / text 字段
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return extractText(m.content);
  if (typeof m.text === 'string') return m.text;
  return '';
}

// session:history 返回 { messages: [{role, content, thinking?}], sessionId, sessionRef }
export function roundsFromHistory(messages) {
  const rounds = [];
  let pending = null;
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role ?? m.message?.role ?? null;
    const content = extractContent(m);
    const thinking = typeof m.thinking === 'string' ? m.thinking : '';
    if (role === 'user') {
      pending = { user: content, thinking: '', assistant: '' };
    } else if (role === 'assistant') {
      if (pending) {
        pending.thinking = thinking;
        pending.assistant = content;
        // 空回复轮不入列：assistant 为空串会让 pending 判定恒真（REVIEW2 发现 15），
        // 且参考上下文里空回复无意义
        if (pending.user.trim() || pending.assistant.trim()) rounds.push(pending);
        pending = null;
      }
    }
  }
  // 未配对的最后一条 user 消息也保留（用户刚发、主对话还没回）
  if (pending && pending.user.trim()) rounds.push({ ...pending, assistant: '', thinking: '' });
  return rounds;
}

// ---------- 多模态 content 文本抽取 ----------

// extractText 仍被 extractContent（roundsFromHistory 用）使用，保留原处；
// parseSessionJsonl 已迁入 lib/host-adapter.js（其内部有同实现副本，迁移步骤 1）。

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// ---------- 组装参考上下文 ----------

function clamp(s, max = 4000) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n…（已截断）' : s;
}

// 单轮 → 文本（快照/增量/预览共用，保证格式一致）
// 增量轮次序号从 startIndex+1 起算（快照后新增轮继续编号，避免序号错位）
export function formatRound(r, opts = {}, startIndex = 0) {
  const { includeThinking = true, perRoundMax } = opts;
  const n = startIndex + 1;
  const lines = [`第 ${n} 轮：`];
  if (r?.user) lines.push(`  您：${clamp(r.user)}`);
  if (includeThinking && r?.thinking) {
    // 自适应压缩时思考上限随每轮预算走（默认 2000 不变）
    const thinkMax = perRoundMax ? Math.min(2000, perRoundMax) : 2000;
    lines.push(`  助手思考：${clamp(r.thinking, thinkMax)}`);
  }
  if (r?.assistant) lines.push(`  助手：${clamp(r.assistant)}`);
  return lines.join('\n');
}

// 批量轮 → 文本（增量追加用：轮间空行分隔，不带参考上下文 header）
export function formatRounds(rounds, opts = {}, startIndex = 0) {
  if (!rounds?.length) return '';
  return rounds.map((r, i) => formatRound(r, opts, startIndex + i)).join('\n\n');
}

export function buildReferenceContext(rounds, opts = {}) {
  const { windowSize = 30, includeThinking = true, maxTotalChars, baseIndex = 0 } = opts;
  if (!rounds.length) return '';
  const header = '【参考上下文 · 来自主对话最近活跃的会话（只读，供您引用，勿当作本对话自身的记忆）】';
  const lines = [header];
  const recent = rounds.slice(-windowSize);
  // 总量自适应压缩（2026-08-16）：全量模式下主对话几百轮时每轮 4000 字会爆炸
  // （模型上下文被截断，用户看到「还是不全」）。maxTotalChars 存在时按轮数均摊
  // 每轮上限（REVIEW3 M4：预算除以 3，把 thinking 也计入——每轮最多 user+assistant+thinking 三份），
  // 保证总注入量可控；不传则保持原每轮 4000 上限。
  const perRoundMax = maxTotalChars
    ? Math.max(500, Math.floor(maxTotalChars / Math.max(1, recent.length) / 3))
    : 4000;
  recent.forEach((r, idx) => {
    const round = { ...r };
    if (round.user && round.user.length > perRoundMax) round.user = round.user.slice(0, perRoundMax) + '\n…（已截断）';
    if (round.assistant && round.assistant.length > perRoundMax) round.assistant = round.assistant.slice(0, perRoundMax) + '\n…（已截断）';
    // baseIndex：窗口/切片渲染时的全局起始序号（REVIEW3 M2/M3，保证窗口内序号与增量续号一致）
    lines.push(formatRound(round, { includeThinking, perRoundMax }, baseIndex + idx));
  });
  return lines.join('\n');
}

// 已配对完成的轮数（最后一条 user 未配 assistant 的 pending 轮不计入）
// 快照/增量同步统一用它计数：pending 轮等配对完成后再进增量（2026-08-16 快照机制）
export function completedRounds(rounds) {
  const last = rounds?.[rounds.length - 1];
  if (!last) return 0;
  return rounds.length - (last.user && !last.assistant ? 1 : 0);
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
