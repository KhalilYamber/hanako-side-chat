// debug/session-history-test.mjs —— readSessionHistory 单测（里程碑 3 修复：文件直读历史）
// 用例：thinking 数组块提取 / 孤立 user 保留 / 空消息过滤 / limit 最近 N 条 /
//       文件不存在返回 [] / 非法行与异类记录跳过。
// 用法：node debug/session-history-test.mjs
// 说明：临时 JSONL 写在本项目 debug/.tmp 下（沙箱内可写），测完即删；不改源码、不连 host。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = await import(pathToFileURL(path.join(ROOT, 'lib', 'host-adapter.js')).href);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const TMP = path.join(ROOT, 'debug', '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const fp = (n) => path.join(TMP, n);

// JSONL 行构造辅助
const line = (role, content, extra = {}) =>
  JSON.stringify({ type: 'message', id: extra.id ?? `m-${Math.random().toString(36).slice(2)}`, timestamp: extra.ts ?? Date.now(), message: { role, content, ...extra.msg } });

function writeFile(name, lines) {
  const p = fp(name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

// ---------- 1. 基本顺序展开（字符串 content，user/assistant 独立消息） ----------
{
  const p = writeFile('basic.jsonl', [
    line('user', '你好'),
    line('assistant', '你好，我是辅助对话'),
    line('user', '再问一个'),
    line('assistant', '好的'),
  ]);
  const h = adapter.readSessionHistory(p);
  check('基础：四消息顺序展开', h.length === 4, `len=${h.length}`);
  check('基础：role/text 正确', h[0].role === 'user' && h[0].text === '你好' && h[3].role === 'assistant' && h[3].text === '好的', JSON.stringify(h));
  check('基础：无 thinking 时为空串', h.every((m) => m.thinking === ''), JSON.stringify(h));
}

// ---------- 2. thinking 数组块提取（直连写入格式 content 数组） ----------
{
  const p = writeFile('thinking.jsonl', [
    line('user', '1+1=?'),
    line('assistant', [
      { type: 'thinking', thinking: '用户问算术，直接回答即可。' },
      { type: 'text', text: '等于 2。' },
    ]),
  ]);
  const h = adapter.readSessionHistory(p);
  check('thinking：长度为 2', h.length === 2, `len=${h.length}`);
  const asst = h[1];
  check('thinking：text 提取 text 块', asst.text === '等于 2。', asst.text);
  check('thinking：thinking 提取 thinking 块', asst.thinking === '用户问算术，直接回答即可。', asst.thinking);
  // 多 text 块拼接（与 extractText 同口径）
  const p2 = writeFile('thinking-multi.jsonl', [
    line('user', 'x'),
    line('assistant', [
      { type: 'thinking', thinking: 't' },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
  ]);
  const h2 = adapter.readSessionHistory(p2);
  check('thinking：多 text 块换行拼接', h2[1].text === 'a\nb', JSON.stringify(h2[1].text));
  // 无 thinking 块的纯文本数组（如工具结果形态）
  const p3 = writeFile('thinking-none.jsonl', [
    line('user', 'x'),
    line('assistant', [{ type: 'text', text: 'plain' }]),
  ]);
  const h3 = adapter.readSessionHistory(p3);
  check('thinking：数组无 thinking 块时为空串', h3[1].thinking === '' && h3[1].text === 'plain', JSON.stringify(h3[1]));
}

// ---------- 3. 孤立 user 保留（直连刚发出、assistant 未落盘） ----------
{
  const p = writeFile('orphan.jsonl', [
    line('user', '第一条'),
    line('assistant', '回复一'),
    line('user', '刚发出还没回'),
  ]);
  const h = adapter.readSessionHistory(p);
  check('孤立 user：保留在末尾', h.length === 3 && h[2].role === 'user' && h[2].text === '刚发出还没回', JSON.stringify(h));
}

// ---------- 4. 空消息过滤（与 normalizeHistory 同口径） ----------
{
  const p = writeFile('empty.jsonl', [
    line('user', ''),
    line('assistant', ''),
    line('assistant', [{ type: 'thinking', thinking: '只有思考没有文本' }]),
    line('user', '正常消息'),
  ]);
  const h = adapter.readSessionHistory(p);
  check('空过滤：user 空文本剔除', h.length === 2 && h[0].role === 'assistant', `len=${h.length}`);
  check('空过滤：assistant 空文本且无思考剔除', !h.some((m) => m.text === '' && m.thinking === ''), JSON.stringify(h));
  check('空过滤：assistant 仅 thinking 保留', h[0].thinking === '只有思考没有文本' && h[0].text === '', JSON.stringify(h[0]));
  check('空过滤：正常消息保留', h[1].role === 'user' && h[1].text === '正常消息', JSON.stringify(h[1]));
}

// ---------- 5. limit 取最近 N 条 ----------
{
  const lines = [];
  for (let i = 1; i <= 10; i++) lines.push(line('user', `q${i}`), line('assistant', `a${i}`));
  const p = writeFile('limit.jsonl', lines);
  const h = adapter.readSessionHistory(p, 4);
  check('limit：只留最近 4 条', h.length === 4, `len=${h.length}`);
  check('limit：取的是尾部（q9,a9,q10,a10）', h[0].text === 'q9' && h[3].text === 'a10', JSON.stringify(h.map((m) => m.text)));
  const hAll = adapter.readSessionHistory(p, 0);
  check('limit：0 = 不截断', hAll.length === 20, `len=${hAll.length}`);
}

// ---------- 6. 文件不存在返回 [] ----------
{
  const h = adapter.readSessionHistory(fp('not-exist.jsonl'));
  check('文件不存在：返回空数组', Array.isArray(h) && h.length === 0, JSON.stringify(h));
}

// ---------- 7. 非法行与异类记录跳过 ----------
{
  const p = writeFile('junk.jsonl', [
    'this is not json',
    JSON.stringify({ type: 'other', payload: 1 }),
    JSON.stringify({ type: 'message', message: { role: 'system', content: '系统消息' } }),
    '',
    line('user', '有效'),
    line('assistant', '有效回复'),
  ]);
  const h = adapter.readSessionHistory(p);
  check('杂项：非法行/异类 type/系统 role 均跳过', h.length === 2 && h[0].text === '有效' && h[1].text === '有效回复', JSON.stringify(h));
}

// ---------- 8. 空文件返回 [] ----------
{
  const p = writeFile('empty-file.jsonl', []);
  const h = adapter.readSessionHistory(p);
  check('空文件：返回空数组', Array.isArray(h) && h.length === 0, JSON.stringify(h));
}

// ---------- 清理 ----------
fs.rmSync(TMP, { recursive: true, force: true });

const passed = results.filter((r) => r.ok).length;
console.log(`\n---- ${passed}/${results.length} PASS ----`);
process.exit(passed === results.length ? 0 : 1);
