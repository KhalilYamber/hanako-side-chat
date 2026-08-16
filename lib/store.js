// store.js —— 辅助对话会话清单管理
// 会话本体（历史、模型调用）走官方 session 能力（session:create / send / history，visibility=plugin_private）。
// 本模块只维护插件侧的轻量索引：sessionId、sessionPath、标题、绑定关系。
// 索引读-改-写通过模块级 promise 队列串行化（REVIEW2 发现 18：无锁时并发
// 惰性绑定/删除会互相覆盖，丢失更新）。

import fs from 'node:fs';
import path from 'node:path';

const INDEX_FILE = 'sidechat-index.json';

// 简单互斥：同一时刻只允许一个写操作（loadIndex→修改→saveIndex 原子化）
let writeChain = Promise.resolve();
function withIndexLock(fn) {
  const run = writeChain.then(fn, fn);
  // 无论成败都继续链（失败不阻塞后续写）
  writeChain = run.catch(() => {});
  return run;
}

export function indexPath(dataDir) {
  return path.join(dataDir, INDEX_FILE);
}

export function loadIndex(dataDir) {
  try {
    const raw = fs.readFileSync(indexPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.sessions)) return parsed;
  } catch {
    // 无索引或损坏：重建
  }
  return { sessions: [] };
}

export function saveIndex(dataDir, index) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(indexPath(dataDir), JSON.stringify(index, null, 2), 'utf8');
}

export function listSessions(dataDir, agentId) {
  const idx = loadIndex(dataDir);
  const all = idx.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  // agent 级归属：按创建时的主对话 agent 过滤（拿不到主会话 id，只能 agent 级隔离）。
  // 不传 agentId 时返回全部（兼容旧数据与内部迁移）。
  if (!agentId) return all;
  return all.filter((s) => !s.agentId || s.agentId === agentId);
}

export function getSession(dataDir, sessionId) {
  return loadIndex(dataDir).sessions.find((s) => s.id === sessionId) ?? null;
}

export function upsertSession(dataDir, entry) {
  return withIndexLock(() => {
    const idx = loadIndex(dataDir);
    const i = idx.sessions.findIndex((s) => s.id === entry.id);
    if (i >= 0) idx.sessions[i] = { ...idx.sessions[i], ...entry };
    else idx.sessions.push(entry);
    saveIndex(dataDir, idx);
    return { ...idx.sessions[i >= 0 ? i : idx.sessions.length - 1] };
  });
}

export function removeSession(dataDir, sessionId) {
  return withIndexLock(() => {
    const idx = loadIndex(dataDir);
    idx.sessions = idx.sessions.filter((s) => s.id !== sessionId);
    saveIndex(dataDir, idx);
  });
}

// 原子复合更新（REVIEW3 H3）：读-改-写在同一个索引锁内完成，
// 防两窗口同会话并发发消息时 mainCtx 增量互相覆盖（丢失轮次、计数回退）。
// fn(cur) 返回要写入的字段 patch（浅合并）或 null（不写）。
// 返回 { entry, changed }：entry 为锁内最新的完整条目副本。
export function updateSession(dataDir, sessionId, fn) {
  return withIndexLock(() => {
    const idx = loadIndex(dataDir);
    const i = idx.sessions.findIndex((s) => s.id === sessionId);
    if (i < 0) return { entry: null, changed: false };
    const cur = { ...idx.sessions[i] };
    const patch = typeof fn === 'function' ? fn(cur) : null;
    if (!patch || typeof patch !== 'object') return { entry: cur, changed: false };
    idx.sessions[i] = { ...cur, ...patch };
    saveIndex(dataDir, idx);
    return { entry: { ...idx.sessions[i] }, changed: true };
  });
}
