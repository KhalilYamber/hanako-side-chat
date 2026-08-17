// chat-pipeline.js —— 直连组装核心（里程碑 3：system 组装接线）
// 职责：直连 OpenAI 兼容 API 前的三层消息组装与辅助会话历史/落盘处理。
//   三层消息结构（用户明确要求，严格区分）：
//     ① system：主对话人格（ProfileProvider）+ 自我意识提示词（selfPrompt）+ 边界声明
//     ② history：辅助会话自身历史（user/assistant 交替，thinking 按开关并入）
//     ③ user：参考上下文块（主对话材料 = 参考资料）前置 + 本次用户消息
//   双上下文语义在组装里显式体现：主对话材料是「参考资料」，辅助历史才是「记忆」，
//   前者放 user 层（参考块），后者放 history 层（消息轮次），绝不混层。
//
// 与 lib 其它模块一致的约定：ESM 命名导出、不静态 import 其它 lib 模块
// （buildPersonality 内部用带时间戳的动态 import 引用 profile-provider，规避模块缓存坑，
//  与 main-context.js 动态 import host-adapter.js 同一模式）、绝不裸 throw
// （buildPersonality / appendSessionMessages 失败返回空值或 { ok:false, error }）。
//
// 模块缓存坑：本文件经 routes/api.js 带时间戳的动态 import 引用（见 loadPipeline），
// 内部不静态 import 其它 lib（node 内置模块无缓存问题）。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 边界声明（与 routes/api.js host 管道的 boundary 块逐字一致，原样搬） ----------
// host 管道把边界声明作为 system 块之一注入；直连模式由本模块在 system 层显式注入，
// 保证两种模式下的边界语义完全一致（辅助对话是纯问答角色，无任何工具权限）。
const BOUNDARY_TEXT =
  '你是辅助对话助手，一个纯问答角色。你绝对没有任何工具与操作权限：' +
  '绝不调用任何工具、绝不读写或修改任何文件、绝不执行任何命令、绝不访问网络，只输出文字回答。' +
  '【参考上下文 · 来自主对话最近活跃的会话】只以只读形式提供主对话的一问一答与思考过程，供你引用线索，' +
  '它不是本对话的记忆；你自己的记忆只来自本对话历史。不要声称自己执行过任何操作或修改过任何文件。';

// ---------- ① system 层 ----------

// 组装 system 文本：selfPrompt（用户可编辑，可空）+ 边界声明（恒在）。
// cfg.selfPrompt 空串/未配置 → 只注入边界（与 host 管道的「可空则不注入」口径一致，
// 但 readConfig 已把空串回退内置默认文案，实际运行时几乎恒有内容）。
export function buildSystemText(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}; // 防御：null/非对象不崩（绝不裸 throw）
  const parts = [];
  const selfPrompt = typeof c.selfPrompt === 'string' && c.selfPrompt.trim() ? c.selfPrompt.trim() : '';
  if (selfPrompt) parts.push(selfPrompt);
  parts.push(BOUNDARY_TEXT);
  return parts.join('\n\n');
}

// 读取主对话人格（直连时人格必须显式注入，host 管道时代由官方自动注入）。
// 内部经带时间戳的动态 import 引用 profile-provider（规避模块缓存坑），
// 模块级缓存首次解析结果（与 routes loadProfile / main-context loadAdapter 同一模式）；
// 插件 reload 后本模块被 routes 重新加载（新实例、新时间戳），链路整体刷新。
// 任何失败返回空串（绝不 throw），由调用方决定降级（system 层只剩 selfPrompt+边界）。
let _profileLib = null;
function loadProfileLib() {
  return _profileLib ??= import(`./profile-provider.js?t=${Date.now()}`);
}
export async function buildPersonality(pctx, agentId) {
  try {
    const lib = await loadProfileLib();
    const profile = await lib.getProfile(pctx, agentId);
    return typeof profile?.personality === 'string' ? profile.personality : '';
  } catch {
    return '';
  }
}

// ---------- ② history 层 ----------

// parseSessionJsonl 产物（rounds: { user, thinking, assistant }）→ OpenAI messages。
// includeThinking=true：thinking 以「【思考过程】」前缀并入 assistant 内容（模型能看到
// 自己过去的思考，与参考上下文的 includeThinking 开关语义一致）；
// false：thinking 丢弃（只保留正文）。
// 空轮过滤与 parseSessionJsonl 口径一致（user 与 assistant 均空不入列）。
export function roundsToHistory(rounds, includeThinking = true) {
  const messages = [];
  for (const r of rounds ?? []) {
    if (!r || typeof r !== 'object') continue;
    const user = typeof r.user === 'string' ? r.user : '';
    const assistant = typeof r.assistant === 'string' ? r.assistant : '';
    const thinking = typeof r.thinking === 'string' ? r.thinking : '';
    if (!user.trim() && !assistant.trim() && !(includeThinking && thinking.trim())) continue;
    if (user.trim()) messages.push({ role: 'user', content: user });
    if (assistant.trim() || (includeThinking && thinking.trim())) {
      let content = assistant;
      if (includeThinking && thinking.trim()) {
        content = `【思考过程】\n${thinking}\n\n${assistant}`;
      }
      if (content.trim()) messages.push({ role: 'assistant', content });
    }
  }
  return messages;
}

// ---------- ③ user 层（参考上下文块前置） ----------

// 三层组装（纯函数）：
//   system：personality + systemText 合并为一条 system 消息（人格与边界同层，
//           参考上下文绝不混入；两者皆空则无 system 消息）
//   history：辅助会话历史轮次（roundsToHistory 产物，原样透传）
//   user：reference 非空时前置「【参考上下文·主对话】\n<reference>\n\n」+ 用户消息；
//         空时仅用户消息。
// 防御：history 末条与本次 user 同角色（上次直连失败遗留的孤立 user 行，无配对回复）
// 时合并，避免连续两条 user 消息（部分 OpenAI 兼容服务端对非交替角色敏感）。
export function buildMessages({ personality = '', systemText = '', reference = '', history = [], userText = '' } = {}) {
  const messages = [];
  const systemParts = [personality, systemText].filter((s) => typeof s === 'string' && s.trim());
  if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') });
  for (const h of history ?? []) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim()) {
      messages.push({ role: h.role, content: h.content });
    }
  }
  const user = typeof userText === 'string' ? userText : '';
  const ref = typeof reference === 'string' ? reference : '';
  const last = messages[messages.length - 1];
  if (ref.trim()) {
    const block = `【参考上下文·主对话】\n${ref}\n\n${user}`;
    if (last && last.role === 'user') last.content = `${last.content}\n\n${block}`;
    else messages.push({ role: 'user', content: block });
  } else {
    if (last && last.role === 'user') last.content = `${last.content}\n\n${user}`;
    else messages.push({ role: 'user', content: user });
  }
  return messages;
}

// ---------- 落盘（辅助会话 JSONL） ----------

// 把回复追加写回辅助会话 JSONL（格式对齐 parseSessionJsonl 反推的官方会话格式）：
//   每行 { type:'message', id, timestamp, message:{ role, content } }；
//   content 字符串形态用于 user 行；assistant 行带 thinking 时用数组形态
//   [{ type:'thinking', thinking }, { type:'text', text }]（官方会话的 thinking 表示，
//   parseSessionJsonl 读回时 thinking 完整还原、正文取 text 块）。
// 文件不存在则创建（含父目录）；幂等防并发追加用 appendFileSync（Node 单线程同步写，
// 同一进程内不会交错行）。失败返回 { ok:false, error }，绝不 throw。
// 返回 { ok:true, count }。
export function appendSessionMessages(filePath, entries) {
  try {
    if (!Array.isArray(entries) || !entries.length) return { ok: true, count: 0 };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const now = Date.now();
    const lines = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e !== 'object') continue;
      const role = e.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof e.content === 'string' ? e.content : '';
      const rec = {
        type: 'message',
        // id 仅作记录定位（parseSessionJsonl 不校验格式），时间戳+序号保证同批唯一
        id: `msg_${now}_${i}`,
        timestamp: new Date(now + i).toISOString(),
        message: { role, content },
      };
      if (role === 'assistant' && typeof e.thinking === 'string' && e.thinking.trim()) {
        rec.message.content = [
          { type: 'thinking', thinking: e.thinking },
          { type: 'text', text: content },
        ];
      }
      lines.push(JSON.stringify(rec));
    }
    fs.appendFileSync(filePath, lines.map((l) => `${l}\n`).join(''), 'utf8');
    return { ok: true, count: lines.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
