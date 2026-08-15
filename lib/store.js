// store.js —— 辅助对话会话清单管理
// 会话本体（历史、模型调用）走官方 session 能力（session:create / send / history，visibility=plugin_private）。
// 本模块只维护插件侧的轻量索引：sessionId、sessionPath、标题、绑定关系。

import fs from 'node:fs';
import path from 'node:path';

const INDEX_FILE = 'sidechat-index.json';

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
  const idx = loadIndex(dataDir);
  const i = idx.sessions.findIndex((s) => s.id === entry.id);
  if (i >= 0) idx.sessions[i] = { ...idx.sessions[i], ...entry };
  else idx.sessions.push(entry);
  saveIndex(dataDir, idx);
  return entry;
}

export function removeSession(dataDir, sessionId) {
  const idx = loadIndex(dataDir);
  idx.sessions = idx.sessions.filter((s) => s.id !== sessionId);
  saveIndex(dataDir, idx);
}
