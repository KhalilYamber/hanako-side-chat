// profile-provider.js —— 人格读取适配层（ProfileProvider，新架构定稿第 6 项）
// 职责：读取主对话 agent 的完整人格文本（personality），供直连 API 时代替
// 官方管道的自动人格注入、组装 system 提示词。
// 数据源（按优先级）：
//   1. bus agent:profile → profile.identity（官方组装后的完整人格：
//      identity.md + yuan 模板 + ishiki.md，含 {{userName}} 等模板变量替换），
//      以及 name / yuan 元信息，一次调用拿全
//   2. 降级：文件直读 agents/<agentId>/identity.md 与 ishiki.md 拼接
//      （yuan 模板内容实测为空模板可忽略；yuan 字段在无 profile 时给空串）
// 原则：绝不 throw。任何一步失败都返回空字段结构
// （identity/ishiki/personality/name/yuan 全空串），由调用方决定降级策略。
//
// 模块缓存坑：与 lib 其它模块一致，本文件不静态 import 其它 lib 模块；
// 经 routes 带时间戳的动态 import 引用则无缓存问题（与 host-adapter 同）。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 内部工具 ----------

// 字符串化防御：非 string 一律空串（host 返回结构漂移时不出错）
function str(v) {
  return typeof v === 'string' ? v : '';
}

// agent 数据目录：<HOME>/agents/<agentId>/（与 lib/host-adapter.js 的 agentsRoot
// 同式推导；此处不 import host-adapter——两个 adapter 保持零耦合，推导仅一行）
function agentDir(pctx, agentId) {
  const home = path.dirname(path.dirname(pctx.pluginDir));
  return path.join(home, 'agents', String(agentId ?? ''));
}

function readFileIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ---------- 数据源 ----------

// bus agent:profile：返回 { id, name, yuan, identity, description, models, ... }，
// profile.identity 是完整组装后的人格（含 ishiki 与模板替换）。
// 兼容两种返回形态：{ profile: {...} } 或直接对象。
// 通道不可用或调用失败返回 null（调用方走文件降级），绝不抛出。
async function fetchBusProfile(pctx, agentId) {
  try {
    if (typeof pctx?.bus?.request !== 'function') return null;
    const res = await pctx.bus.request('agent:profile', { agentId });
    const profile = res?.profile ?? res ?? null;
    return profile && typeof profile === 'object' ? profile : null;
  } catch {
    return null;
  }
}

// 文件直读降级：agents/<agentId>/identity.md + ishiki.md 拼接为 personality。
// out 为已有部分结果的输出结构（profile 部分成功时保留已有字段，
// 如 profile 给了 name 但 identity 为空，只补文件人格部分）。
function fillFromFiles(pctx, agentId, out) {
  const dir = agentDir(pctx, agentId);
  const identity = out.identity || readFileIfExists(path.join(dir, 'identity.md'));
  const ishiki = out.ishiki || readFileIfExists(path.join(dir, 'ishiki.md'));
  return {
    ...out,
    identity,
    ishiki,
    personality: out.personality || [identity, ishiki].filter(Boolean).join('\n\n'),
  };
}

// ---------- 主入口 ----------

// 读取 agent 人格。返回 { identity, ishiki, personality, name, yuan }：
//   - personality：完整人格文本（系统提示词用）。优先 agent:profile 的
//     profile.identity（官方组装完整版）；失败或为空时降级为 identity+ishiki 拼接
//   - identity / ishiki：人格分块文本（profile 路径下取 profile 对应字段，
//     官方若不分块返回则为空串；文件路径下为 identity.md / ishiki.md 内容）
//   - name / yuan：agent 元信息（yuan 为模板名；仅 profile 通道提供）
// 字段缺失给空串，绝不 throw。
export async function getProfile(pctx, agentId) {
  const out = { identity: '', ishiki: '', personality: '', name: '', yuan: '' };
  if (!pctx || !agentId) return out;
  const profile = await fetchBusProfile(pctx, agentId);
  if (profile) {
    out.identity = str(profile.identity);
    out.ishiki = str(profile.ishiki);
    out.personality = str(profile.identity);
    out.name = str(profile.name);
    out.yuan = str(profile.yuan);
    // profile.identity 为空时仍走文件兜底（profile 存在但人格字段缺失的极端情况）
    if (!out.personality) return fillFromFiles(pctx, agentId, out);
    return out;
  }
  return fillFromFiles(pctx, agentId, out);
}
