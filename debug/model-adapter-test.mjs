// model-adapter-test.mjs —— ModelAdapter（lib/model-adapter.js）最小验证
// 纯逻辑单测：mock fetch（可控 Response 形态），验证：
//   1. URL 规整（带/不带 /v1、尾部斜杠、完整端点、非法）
//   2. 请求体组装（stream 强制、params 透传、messages 规整）
//   3. 成功流：content + reasoning_content 拼接、[DONE] 结束、usage 提取
//   4. 错误结构化：HTTP 非 2xx / 网络 / 流中断 / reader 异常 / abort / 超时 / 参数错误
//   5. 请求头（有 key → Bearer；无 key → 不带）
//   6. 脏块容忍、API error 块
//   7. testConnection（成功 / 401 / 超时 / 非 JSON 响应）
// 用法：node debug/model-adapter-test.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ma = await import(`../lib/model-adapter.js?t=${Date.now()}`);

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

// ---------- mock 工具 ----------

// 把 SSE 行序列编码成流式 body（模拟网络分块，不依赖全局 ReadableStream）
function sseBody(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return {
    getReader() {
      return {
        async read() {
          if (pos >= bytes.length) return { done: true, value: undefined };
          const size = Math.min(13, bytes.length - pos); // 故意小块切分，测跨块行拼接
          const chunk = bytes.slice(pos, pos + size);
          pos += size;
          return { done: false, value: chunk };
        },
      };
    },
  };
}

function sseResponse(lines, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: sseBody(lines),
    async text() {
      return Array.isArray(lines) ? lines.join('\n') : String(lines);
    },
  };
}

// 记录调用并返回指定响应的 fetch mock
function mockFetch(response, onCall) {
  return async (url, opts) => {
    if (onCall) onCall(url, opts);
    return response;
  };
}

const BASE_OPTS = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
  timeoutMs: 30000,
};

// 常用 SSE 行
const d = (obj) => `data: ${JSON.stringify(obj)}`;
const CHUNK_1 = d({ choices: [{ delta: { reasoning_content: '思考一', content: '你好' } }] });
const CHUNK_2 = d({ choices: [{ delta: { reasoning_content: '思考二', content: '，世界' } }] });
const DONE = 'data: [DONE]';

// ---------- 用例 ----------

// 1. URL 规整
{
  check('1.1 无 /v1 → 补 /v1', ma.normalizeBaseUrl('https://api.deepseek.com') === 'https://api.deepseek.com/v1');
  check('1.2 已含 /v1 → 保持', ma.normalizeBaseUrl('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1');
  check('1.3 尾部斜杠 → 去除并补 /v1', ma.normalizeBaseUrl('https://api.deepseek.com/') === 'https://api.deepseek.com/v1');
  check('1.4 /v1 + 尾部斜杠 → 保持', ma.normalizeBaseUrl('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1');
  check('1.5 完整端点 → 保持', ma.normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1/chat/completions');
  check('1.6 openrouter /api/v1 → 保持', ma.normalizeBaseUrl('https://openrouter.ai/api/v1') === 'https://openrouter.ai/api/v1');
  check('1.7 空串 → 空', ma.normalizeBaseUrl('') === '');
  check('1.8 非 http(s) → 空', ma.normalizeBaseUrl('ftp://x.com') === '' && ma.normalizeBaseUrl('javascript:alert(1)') === '');
  check('1.9 空白 → 空', ma.normalizeBaseUrl('   ') === '');
  check('1.10 chatCompletionsUrl 拼接', ma.chatCompletionsUrl('https://api.deepseek.com') === 'https://api.deepseek.com/v1/chat/completions');
  check('1.11 chatCompletionsUrl 已含端点不重复', ma.chatCompletionsUrl('https://x.com/v1/chat/completions') === 'https://x.com/v1/chat/completions');
  check('1.12 chatCompletionsUrl 非法 → 空', ma.chatCompletionsUrl('') === '');
  check('1.13 modelsUrl', ma.modelsUrl('https://api.deepseek.com') === 'https://api.deepseek.com/v1/models');
}

// 2. 请求体组装
{
  const b = ma.buildRequestBody({
    model: 'm1',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 't' }, // 非法 role 丢弃
      { role: 'user', content: 123 }, // 非字符串丢弃
      { role: 'user', content: [{ type: 'text', text: '多模态' }] }, // 数组形态透传
      null,
    ],
    params: { temperature: 0.7, max_tokens: 100, stream: false, top_p: undefined, seed: null },
  });
  check('2.1 stream 强制 true', b.stream === true);
  check('2.2 合法 role 保留', b.messages.length === 4, JSON.stringify(b.messages));
  check('2.3 params 透传 temperature/max_tokens', b.temperature === 0.7 && b.max_tokens === 100);
  check('2.4 params 过滤 stream/undefined/null', b.stream === true && !('top_p' in b) && !('seed' in b));
  check('2.5 content 数组形态透传', Array.isArray(b.messages[3].content));
  const empty = ma.buildRequestBody({ model: 'm', messages: 'junk', params: 'junk' });
  check('2.6 非数组 messages → 空数组不崩', Array.isArray(empty.messages) && empty.messages.length === 0);
}

// 3. 成功流（content + reasoning 拼接、[DONE] 结束）
{
  const calls = [];
  const fetchImpl = mockFetch(sseResponse([CHUNK_1, '', CHUNK_2, '', DONE, '']), (url, opts) => calls.push({ url, opts }));
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('3.1 成功：ok:true', r.ok === true);
  check('3.2 成功：content 拼接', r.content === '你好，世界', JSON.stringify(r.content));
  check('3.3 成功：reasoning 拼接（DeepSeek thinking）', r.reasoning === '思考一思考二');
  check('3.4 成功：truncated 无', r.truncated === undefined);
  check('3.5 请求 URL 正确', calls.length === 1 && calls[0].url === 'https://api.deepseek.com/v1/chat/completions', calls[0]?.url);
  check('3.6 请求 method POST + Authorization Bearer', calls[0].opts.method === 'POST' && calls[0].opts.headers.Authorization === 'Bearer sk-test');
  const body = JSON.parse(calls[0].opts.body);
  check('3.7 请求体 model/messages/stream', body.model === 'deepseek-chat' && body.messages.length === 1 && body.stream === true);
}

// 4. 无 key → 不带 Authorization
{
  const calls = [];
  const fetchImpl = mockFetch(sseResponse([DONE, '']), (url, opts) => calls.push(opts));
  await ma.streamChat({ ...BASE_OPTS, apiKey: '', fetchImpl });
  check('4.1 无 key 不带 Authorization', !('Authorization' in calls[0].headers), JSON.stringify(calls[0].headers));
}

// 5. 无 thinking 流
{
  const fetchImpl = mockFetch(sseResponse([d({ choices: [{ delta: { content: '只有正文' } }] }), '', DONE, '']));
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('5.1 无 thinking：reasoning 空串', r.ok === true && r.reasoning === '' && r.content === '只有正文');
}

// 6. usage 提取（流式最后一块）
{
  const fetchImpl = mockFetch(sseResponse([
    d({ choices: [{ delta: { content: 'a' } }] }),
    d({ choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    DONE, '',
  ]));
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('6.1 usage 提取', r.ok === true && r.usage?.total_tokens === 15, JSON.stringify(r.usage));
}

// 7. HTTP 非 2xx → kind http
{
  const fetchImpl = mockFetch({ ok: false, status: 401, body: null, async text() { return '{"error":{"message":"Invalid API key"}}'; } });
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('7.1 HTTP 401：ok:false', r.ok === false);
  check('7.2 HTTP 401：kind http + status', r.error.kind === 'http' && r.error.status === 401, JSON.stringify(r.error));
  check('7.3 HTTP 401：message 含响应体摘要', (r.error.message ?? '').includes('Invalid API key'), r.error.message);
}

// 8. 网络错误 → kind network
{
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('8.1 fetch 抛错：kind network', r.ok === false && r.error.kind === 'network');
  check('8.2 fetch 抛错：message 透传', (r.error.message ?? '').includes('ECONNREFUSED'));
}

// 9. 流中断（无 [DONE]）
{
  const fetchImpl = mockFetch(sseResponse([CHUNK_1, '']));
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('9.1 有内容无 [DONE]：ok:true + truncated:true', r.ok === true && r.truncated === true, JSON.stringify(r));
  const fetchImpl2 = mockFetch(sseResponse(['', '']));
  const r2 = await ma.streamChat({ ...BASE_OPTS, fetchImpl: fetchImpl2 });
  check('9.2 无内容无 [DONE]：kind stream', r2.ok === false && r2.error.kind === 'stream', JSON.stringify(r2.error));
}

// 10. reader 抛错 → kind stream
{
  const fetchImpl = mockFetch({ ok: true, status: 200, body: { getReader() { return { async read() { throw new Error('pipe broken'); } }; } } });
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('10.1 reader 异常：kind stream', r.ok === false && r.error.kind === 'stream', JSON.stringify(r.error));
}

// 11. 外部 Abort → kind abort
{
  const ctrl = new AbortController();
  ctrl.abort();
  // mock fetch 响应 signal（真实 fetch 对已 abort 的 signal 立即 reject）
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    if (opts.signal.aborted) { reject(new Error('AbortError')); return; }
    opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
    resolve(sseResponse([DONE, '']));
  });
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl, signal: ctrl.signal });
  check('11.1 已 abort：kind abort', r.ok === false && r.error.kind === 'abort', JSON.stringify(r.error));
}

// 12. 超时 → kind network + 超时文案
{
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
  });
  const t0 = Date.now();
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl, timeoutMs: 60 });
  check('12.1 超时：kind network', r.ok === false && r.error.kind === 'network');
  check('12.2 超时：message 含超时', (r.error.message ?? '').includes('超时'), r.error.message);
  check('12.3 超时后迅速返回', Date.now() - t0 < 2000);
}

// 13. 参数错误 → kind usage
{
  const r1 = await ma.streamChat({ ...BASE_OPTS, baseUrl: '' });
  check('13.1 baseUrl 空：kind usage', r1.ok === false && r1.error.kind === 'usage');
  const r2 = await ma.streamChat({ ...BASE_OPTS, model: '' });
  check('13.2 model 空：kind usage', r2.ok === false && r2.error.kind === 'usage');
  const r3 = await ma.streamChat({ ...BASE_OPTS, messages: [] });
  check('13.3 messages 空：kind usage', r3.ok === false && r3.error.kind === 'usage');
}

// 14. 脏块容忍（非 JSON data 跳过，后续正常块继续）
{
  const fetchImpl = mockFetch(sseResponse([
    'data: {broken json',
    'event: ping',
    ': comment',
    'random line',
    d({ choices: [{ delta: { content: 'ok' } }] }),
    DONE, '',
  ]));
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('14.1 脏块跳过：content 正常', r.ok === true && r.content === 'ok', JSON.stringify(r));
}

// 15. API error 块 → kind http
{
  const fetchImpl = mockFetch(sseResponse([
    d({ error: { message: 'Rate limit exceeded' } }),
    DONE, '',
  ]));
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('15.1 error 块：ok:false', r.ok === false);
  check('15.2 error 块：kind http + message', r.error.kind === 'http' && (r.error.message ?? '').includes('Rate limit'), JSON.stringify(r.error));
}

// 16. parseSseLine / extractDelta 直接单测
{
  check('16.1 parseSseLine data', JSON.stringify(ma.parseSseLine('data: {"a":1}')) === JSON.stringify({ type: 'data', data: '{"a":1}' }));
  check('16.2 parseSseLine DONE', ma.parseSseLine('data: [DONE]').type === 'done');
  check('16.3 parseSseLine 带 \\r', ma.parseSseLine('data: x\r').type === 'data');
  check('16.4 parseSseLine 注释', ma.parseSseLine(': keepalive').type === 'comment');
  check('16.5 parseSseLine event 行', ma.parseSseLine('event: foo').type === 'event');
  check('16.6 parseSseLine 空行', ma.parseSseLine('') === null && ma.parseSseLine('  ') === null);
  const ex = ma.extractDelta('{"choices":[{"delta":{"reasoning_content":"想","content":"说"}}]}');
  check('16.7 extractDelta content/reasoning', ex.content === '说' && ex.reasoning === '想');
  const ex2 = ma.extractDelta('{"choices":[{"delta":{"reasoning":"别名"}}]}');
  check('16.8 extractDelta reasoning 别名兼容', ex2.reasoning === '别名');
  check('16.9 extractDelta 非法 JSON → null', ma.extractDelta('{nope') === null);
  check('16.10 extractDelta error 块', ma.extractDelta('{"error":{"message":"x"}}').error?.message === 'x');
}

// 17. testConnection
{
  // 17.1 成功（data 数组模型列表）
  const calls = [];
  const fetchImpl = mockFetch({ ok: true, status: 200, body: null, async json() { return { data: [{ id: 'm1' }, { id: 'm2' }, 'm3', {}] }; } }, (url, opts) => calls.push({ url, opts }));
  const r = await ma.testConnection({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', fetchImpl });
  check('17.1 test 成功：ok:true', r.ok === true);
  check('17.2 test 成功：models 提取（id 数组）', JSON.stringify(r.models) === JSON.stringify(['m1', 'm2', 'm3']), JSON.stringify(r.models));
  check('17.3 test URL 为 /v1/models', calls[0].url === 'https://api.deepseek.com/v1/models');
  check('17.4 test 带 Authorization', calls[0].opts.headers.Authorization === 'Bearer sk-x');
  // 17.2 HTTP 401
  const r2 = await ma.testConnection({ baseUrl: 'https://x.com', apiKey: 'bad', fetchImpl: mockFetch({ ok: false, status: 401, body: null, async text() { return 'Unauthorized'; } }) });
  check('17.5 test 401：kind http + status', r2.ok === false && r2.error.kind === 'http' && r2.error.status === 401);
  // 17.3 超时
  const r3 = await ma.testConnection({ baseUrl: 'https://x.com', fetchImpl: (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('abort')))), timeoutMs: 50 });
  check('17.6 test 超时：kind network + 超时文案', r3.ok === false && r3.error.kind === 'network' && (r3.error.message ?? '').includes('超时'), JSON.stringify(r3.error));
  // 17.4 非 JSON 响应仍视为连通
  const r4 = await ma.testConnection({ baseUrl: 'https://x.com', fetchImpl: mockFetch({ ok: true, status: 200, body: null, async json() { throw new Error('not json'); } }) });
  check('17.7 test 非 JSON 响应：ok:true + models 空', r4.ok === true && Array.isArray(r4.models) && r4.models.length === 0);
  // 17.5 非法 baseUrl
  const r5 = await ma.testConnection({ baseUrl: '', fetchImpl: mockFetch({}) });
  check('17.8 test 非法 baseUrl：kind usage', r5.ok === false && r5.error.kind === 'usage');
}

// 18. 非流响应兜底（body 无 getReader 时读 text）
{
  const fetchImpl = mockFetch({ ok: true, status: 200, body: null, async text() { return '{"choices":[{"delta":{"content":"非流内容"}}]}'; } });
  const r = await ma.streamChat({ ...BASE_OPTS, fetchImpl });
  check('18.1 非流响应：content 提取', r.ok === true && r.content === '非流内容', JSON.stringify(r));
}

// ---------- 汇总 ----------

console.log(`\n---- ${passed}/${passed + failed} PASS ----`);
process.exit(failed ? 1 : 0);
