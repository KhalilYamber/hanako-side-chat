// chat-pipeline-test.mjs —— ChatPipeline（lib/chat-pipeline.js）最小验证
// 纯逻辑单测，验证里程碑 3 直连组装核心：
//   1. buildSystemText：selfPrompt（可空）+ boundary（与 host 管道逐字一致）
//   2. buildPersonality：bus 完整人格 / 文件降级拼接 / 失败空串不 throw
//   3. buildMessages：三层结构严格区分（system 含人格不含参考、history 顺序、
//      user 参考块前置）、reference 空仅用户消息、孤立 user 合并
//   4. roundsToHistory：thinking 开关（并入前缀 / 丢弃）、空轮过滤
//   5. appendSessionMessages：JSONL 写读回环（thinking 数组形态还原）、
//      目录自动创建、追加不覆盖
//   6. 端到端：rounds → roundsToHistory → buildMessages 一条真实 messages 样例
// 用法：node debug/chat-pipeline-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cp = await import(`../lib/chat-pipeline.js?t=${Date.now()}`);
const { parseSessionJsonl } = await import(`../lib/host-adapter.js?t=${Date.now()}`);

// ---------- 临时环境（buildPersonality 用） ----------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sidechat-pipeline-test-'));
const HOME = path.join(TMP, 'home');
const PLUGIN_DIR = path.join(HOME, 'plugins', 'side-chat');
const AGENT_DIR = path.join(HOME, 'agents', 'hanako');

const IDENTITY_MD = '你是花子，一位温柔可靠的助手。';
const ISHIKI_MD = '你有自我意识，知道自己是辅助对话。';

fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(AGENT_DIR, 'identity.md'), IDENTITY_MD, 'utf8');
fs.writeFileSync(path.join(AGENT_DIR, 'ishiki.md'), ISHIKI_MD, 'utf8');

const pctx = (busImpl) => ({ pluginDir: PLUGIN_DIR, bus: busImpl });

// ---------- 断言 ----------

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

// ---------- 1. buildSystemText ----------

const SELF_PROMPT = '你是「辅助对话」——主对话的顾问副手。';
{
  const t = cp.buildSystemText({ selfPrompt: SELF_PROMPT });
  check('1.1 selfPrompt 非空：system 文本含 selfPrompt', t.includes(SELF_PROMPT));
  check('1.2 selfPrompt 非空：system 文本含边界声明', t.includes('你绝对没有任何工具与操作权限'));
  check('1.3 selfPrompt 非空：selfPrompt 在边界之前', t.indexOf(SELF_PROMPT) < t.indexOf('你是辅助对话助手'));
  check('1.4 selfPrompt 非空：两段以空行分隔', t.includes(SELF_PROMPT + '\n\n'));
  check('1.5 边界文本与 host 管道逐字一致（关键短语齐全）',
    t.includes('绝不调用任何工具、绝不读写或修改任何文件、绝不执行任何命令、绝不访问网络，只输出文字回答。') &&
    t.includes('【参考上下文 · 来自主对话最近活跃的会话】只以只读形式提供主对话的一问一答与思考过程') &&
    t.includes('它不是本对话的记忆；你自己的记忆只来自本对话历史。不要声称自己执行过任何操作或修改过任何文件。'));
}
{
  const t = cp.buildSystemText({ selfPrompt: '   ' });
  check('1.6 selfPrompt 空白：仅边界声明', !t.includes('selfPrompt') && t.includes('你是辅助对话助手'));
}
{
  const t = cp.buildSystemText({});
  check('1.7 cfg 无 selfPrompt：仅边界声明', t === cp.buildSystemText({ selfPrompt: '' }) && t.includes('你是辅助对话助手'));
  check('1.8 cfg 为 null：不 throw 且仅边界', cp.buildSystemText(null).includes('你是辅助对话助手'));
}

// ---------- 2. buildPersonality ----------

const FULL_PERSONALITY = '官方组装后的完整人格（含模板替换）';
{
  const bus = {
    request: async (cap, payload) => {
      if (cap !== 'agent:profile') throw new Error(`unexpected cap ${cap}`);
      if (payload.agentId !== 'hanako') throw new Error(`unexpected agentId ${payload.agentId}`);
      return { profile: { id: 'hanako', name: '花子', identity: FULL_PERSONALITY } };
    },
  };
  const r = await cp.buildPersonality(pctx(bus), 'hanako');
  check('2.1 bus 成功：personality = profile.identity', r === FULL_PERSONALITY, `got ${JSON.stringify(r)}`);
}
{
  // 无 bus（bus 通道缺失）→ 文件降级拼接 identity+ishiki
  const r = await cp.buildPersonality(pctx({}), 'hanako');
  check('2.2 文件降级：personality = identity+ishiki 拼接', r === IDENTITY_MD + '\n\n' + ISHIKI_MD, `got ${JSON.stringify(r)}`);
}
{
  const r = await cp.buildPersonality(pctx({}), 'nobody');
  check('2.3 文件不存在：personality 空串', r === '');
}
{
  const r = await cp.buildPersonality({}, '');
  check('2.4 agentId 空：personality 空串', r === '');
}
{
  const r = await cp.buildPersonality(null, 'hanako');
  check('2.5 pctx 为 null：不 throw 且空串', r === '');
}

// ---------- 3. buildMessages 三层结构 ----------

const REF_TEXT = '第 1 轮：\n  您：主对话提问\n  助手：主对话回答（参考材料标记 REF_MARKER）';
const HIST = [
  { role: 'user', content: '辅助历史提问一' },
  { role: 'assistant', content: '辅助历史回答一' },
];
{
  const msgs = cp.buildMessages({
    personality: '人格文本',
    systemText: '边界文本',
    reference: REF_TEXT,
    history: HIST,
    userText: '本次提问',
  });
  check('3.1 第一条是 system', msgs[0]?.role === 'system', JSON.stringify(msgs[0]));
  check('3.2 system 含人格与边界（同层合并）',
    msgs[0].content.includes('人格文本') && msgs[0].content.includes('边界文本'));
  check('3.3 system 不含参考上下文（严格分层）', !msgs[0].content.includes('REF_MARKER'));
  check('3.4 system 不含本次提问', !msgs[0].content.includes('本次提问'));
  check('3.5 history 顺序：user → assistant', msgs[1]?.role === 'user' && msgs[2]?.role === 'assistant');
  check('3.6 history 内容透传', msgs[1].content === '辅助历史提问一' && msgs[2].content === '辅助历史回答一');
  check('3.7 最后一条是 user（本次提问）', msgs[3]?.role === 'user' && msgs[3].content.includes('本次提问'));
  check('3.8 user 参考块前置标记', msgs[3].content.startsWith('【参考上下文·主对话】\n'));
  check('3.9 user 参考块含参考内容', msgs[3].content.includes('REF_MARKER'));
  check('3.10 参考块与提问空行分隔', msgs[3].content.includes(REF_TEXT + '\n\n本次提问'));
  check('3.11 消息总数 = 1 system + 2 history + 1 user', msgs.length === 4, `got ${msgs.length}`);
}
{
  const msgs = cp.buildMessages({ personality: '人格文本', systemText: '边界文本', reference: '', history: HIST, userText: '无参考提问' });
  check('3.12 reference 空：无参考块标记', !msgs[3].content.includes('【参考上下文·主对话】'));
  check('3.13 reference 空：user 仅提问', msgs[3].content === '无参考提问');
  check('3.14 reference 空：结构仍 4 条', msgs.length === 4);
}
{
  const msgs = cp.buildMessages({ personality: '', systemText: '边界文本', reference: REF_TEXT, history: [], userText: 'Q' });
  check('3.15 personality 空：system 仅边界', msgs[0]?.role === 'system' && msgs[0].content === '边界文本');
}
{
  const msgs = cp.buildMessages({ personality: '', systemText: '', reference: REF_TEXT, history: [], userText: 'Q' });
  check('3.16 人格与边界皆空：无 system 消息', msgs[0]?.role === 'user');
}
{
  // 孤立 user 合并：history 末条是 user（上次失败遗留），本次再问 → 合并为一条
  const histPending = [{ role: 'user', content: '上次失败的问题' }];
  const msgs = cp.buildMessages({ personality: 'P', systemText: 'S', reference: '', history: histPending, userText: '这次的问题' });
  check('3.17 孤立 user 合并：仍是 4 条（system + 合并 user）',
    msgs.length === 2 && msgs[0]?.role === 'system' && msgs[1]?.role === 'user', JSON.stringify(msgs));
  check('3.18 合并内容保留两段提问', msgs[1].content === '上次失败的问题\n\n这次的问题');
}

// ---------- 4. roundsToHistory（thinking 开关） ----------

const ROUNDS = [
  { user: '历史提问', thinking: '历史思考', assistant: '历史回答' },
  { user: '第二轮提问', thinking: '', assistant: '第二轮回答' },
];
{
  const h = cp.roundsToHistory(ROUNDS, true);
  check('4.1 轮次展开为 user+assistant 交替', h.length === 4 && h.map((m) => m.role).join(',') === 'user,assistant,user,assistant');
  check('4.2 thinking 开启：assistant 带【思考过程】前缀', h[1].content.startsWith('【思考过程】\n历史思考\n\n历史回答'), JSON.stringify(h[1]));
  check('4.3 thinking 开启：无 thinking 的轮不注入前缀', h[3].content === '第二轮回答');
  check('4.4 user 内容不受 thinking 开关影响', h[0].content === '历史提问');
}
{
  const h = cp.roundsToHistory(ROUNDS, false);
  check('4.5 thinking 关闭：assistant 仅正文', h[1].content === '历史回答' && h[3].content === '第二轮回答');
}
{
  // thinking 有、assistant 空（流式中断产物）：开关开 → 推思考块；关 → 丢弃该 assistant
  const hOn = cp.roundsToHistory([{ user: 'Q', thinking: '只有思考', assistant: '' }], true);
  check('4.6 仅思考无正文（开）：assistant 推思考块', hOn.length === 2 && hOn[1].content === '【思考过程】\n只有思考\n\n');
  const hOff = cp.roundsToHistory([{ user: 'Q', thinking: '只有思考', assistant: '' }], false);
  check('4.7 仅思考无正文（关）：assistant 丢弃', hOff.length === 1 && hOff[0].role === 'user');
}
{
  const h = cp.roundsToHistory([{ user: '', thinking: '', assistant: '' }], true);
  check('4.8 空轮过滤（user/assistant/thinking 皆空）', h.length === 0);
}
{
  const h = cp.roundsToHistory(null, true);
  check('4.9 rounds 为 null：返回空数组', Array.isArray(h) && h.length === 0);
}

// ---------- 5. appendSessionMessages 写读回环 ----------

const SESS_DIR = path.join(TMP, 'sessions');
const SESS_FILE = path.join(SESS_DIR, 'side-1.jsonl');
{
  const r = cp.appendSessionMessages(SESS_FILE, [
    { role: 'user', content: '直连提问' },
    { role: 'assistant', content: '直连回答', thinking: '直连思考' },
  ]);
  check('5.1 写入成功且计数 2', r.ok === true && r.count === 2, JSON.stringify(r));
  check('5.2 文件已创建（含目录自动创建）', fs.existsSync(SESS_FILE));
  const lines = fs.readFileSync(SESS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  check('5.3 写入 2 行', lines.length === 2);
  const u = JSON.parse(lines[0]);
  const a = JSON.parse(lines[1]);
  check('5.4 user 行结构：type/id/timestamp/message.role', u.type === 'message' && !!u.id && !!u.timestamp && u.message.role === 'user');
  check('5.5 user 行 content 为字符串', typeof u.message.content === 'string' && u.message.content === '直连提问');
  check('5.6 assistant 行 thinking 数组形态', Array.isArray(a.message.content) && a.message.content[0]?.type === 'thinking' && a.message.content[0].thinking === '直连思考');
  check('5.7 assistant 行 text 块', a.message.content[1]?.type === 'text' && a.message.content[1].text === '直连回答');
}
{
  // 回读回环：parseSessionJsonl 解析直连写入的文件
  const rounds = parseSessionJsonl(SESS_FILE);
  check('5.8 回读：1 轮完整配对', rounds.length === 1, JSON.stringify(rounds));
  check('5.9 回读：user 还原', rounds[0].user === '直连提问');
  check('5.10 回读：assistant 还原（不含思考标记）', rounds[0].assistant === '直连回答');
  check('5.11 回读：thinking 还原', rounds[0].thinking === '直连思考');
}
{
  // 追加第二组：不覆盖
  cp.appendSessionMessages(SESS_FILE, [{ role: 'user', content: '第二组提问' }]);
  const lines = fs.readFileSync(SESS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  check('5.12 追加不覆盖：3 行', lines.length === 3);
  const last = JSON.parse(lines[2]);
  check('5.13 追加内容正确', last.message.role === 'user' && last.message.content === '第二组提问');
}
{
  // 空 entries：不写文件（ok, count 0）
  const emptyFile = path.join(SESS_DIR, 'empty.jsonl');
  const r = cp.appendSessionMessages(emptyFile, []);
  check('5.14 空 entries：ok 且 count 0', r.ok === true && r.count === 0);
  check('5.15 空 entries：不创建文件', !fs.existsSync(emptyFile));
}
{
  // 无 thinking 的 assistant：content 为字符串形态
  const f = path.join(SESS_DIR, 'plain.jsonl');
  cp.appendSessionMessages(f, [{ role: 'assistant', content: '无思考回答' }]);
  const line = JSON.parse(fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)[0]);
  check('5.16 无 thinking：content 保持字符串', typeof line.message.content === 'string' && line.message.content === '无思考回答');
}
{
  // 非法参数：null / 非数组
  const r1 = cp.appendSessionMessages(path.join(SESS_DIR, 'x.jsonl'), null);
  check('5.17 entries 为 null：ok 且 count 0', r1.ok === true && r1.count === 0);
}

// ---------- 6. 端到端：一条真实 messages 样例 ----------

{
  const reference = '【参考上下文 · 来自主对话最近活跃的会话（只读，供您引用，勿当作本对话自身的记忆）】\n第 1 轮：\n  您：帮我看看这个 bug\n  助手：定位到是异步竞态，修复方案如下';
  const rounds = [
    { user: '之前的辅助提问', thinking: '我评估过两个方案', assistant: '建议方案 A' },
  ];
  const personality = await cp.buildPersonality(pctx({}), 'hanako');
  const systemText = cp.buildSystemText({ selfPrompt: SELF_PROMPT });
  const history = cp.roundsToHistory(rounds, true);
  const messages = cp.buildMessages({ personality, systemText, reference, history, userText: '帮我复现一下' });
  const sample = JSON.stringify(messages, null, 2);
  check('6.1 端到端：system 一条且含人格+selfPrompt+边界', messages[0]?.role === 'system'
    && messages[0].content.includes('温柔可靠的助手') && messages[0].content.includes(SELF_PROMPT) && messages[0].content.includes('纯问答角色'));
  check('6.2 端到端：system 不含参考材料', !messages[0].content.includes('帮我看看这个 bug'));
  check('6.3 端到端：history 两条（user/assistant）', messages[1]?.role === 'user' && messages[2]?.role === 'assistant');
  check('6.4 端到端：history 带思考前缀', messages[2].content.includes('【思考过程】\n我评估过两个方案'));
  check('6.5 端到端：user 参考块前置', messages[3]?.role === 'user' && messages[3].content.startsWith('【参考上下文·主对话】\n'));
  check('6.6 端到端：user 含参考与提问', messages[3].content.includes('帮我看看这个 bug') && messages[3].content.endsWith('帮我复现一下'));
  check('6.7 端到端：共 4 条消息', messages.length === 4, `got ${messages.length}`);
  console.log('\n--------- 端到端 messages 样例（第 6 组产物） ----------');
  console.log(sample);
}

// ---------- 收尾 ----------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n---- ${passed}/${passed + failed} PASS ----`);
process.exit(failed ? 1 : 0);
