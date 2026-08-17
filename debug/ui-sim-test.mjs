// debug/ui-sim-test.mjs —— side-chat 前端 UI 模拟回归测试（零依赖）
// 用 node 内置 vm 加载 assets/app.js，手写浏览器 DOM/API stub，模拟「新建/切换会话」等
// 交互，观察 session-trigger-label 文本、messages 内联 HTML、btn-new 状态等 DOM stub 变化。
// 用途：复现并回归「新建第一个辅助会话后 UI 不进入」bug（以及新建/切换的非回归场景）。
// 用法：node debug/ui-sim-test.mjs
// 说明：只读加载 app.js，不改动源码；不连真实 host，不提交 git。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const flush = () => new Promise((r) => setImmediate(r));

// ---------- DOM stub ----------

class MockClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    want ? this.set.add(c) : this.set.delete(c);
    return want;
  }
}

class MockElement {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this._classList = new MockClassList();
    this._textContent = '';
    this._innerHTML = '';
    this.title = '';
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.onclick = null;
    this.oncontextmenu = null;
    this.onchange = null;
    this.onblur = null;
    this.onkeydown = null;
  }
  get classList() { return this._classList; }
  get className() { return [...this._classList.set].join(' '); }
  set className(v) { this._classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, ref) {
    child.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  contains() { return false; }
  closest() { return null; }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  get firstChild() { return this.children[0] ?? null; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get scrollTop() { return 0; }
  set scrollTop(v) {}
  get scrollHeight() { return 0; }
}

function makeDocument() {
  const byId = new Map();
  const getById = (id) => {
    if (!byId.has(id)) byId.set(id, new MockElement(id));
    return byId.get(id);
  };
  const document = {
    getElementById: getById,
    createElement: (tag) => new MockElement(`el-${tag}-${Math.random().toString(36).slice(2)}`),
    documentElement: { dataset: { surface: 'widget' } },
    body: new MockElement('body'),
    addEventListener() {},
    removeEventListener() {},
  };
  return { document, byId };
}

// ---------- fetch stub（请求入队，手动 resolve，模拟网络时序） ----------

function makeFetch() {
  const requests = [];
  const fetch = (url, options = {}) => new Promise((resolve, reject) => {
    requests.push({ url: String(url), options, resolve, reject, resolved: false });
  });
  return { fetch, requests };
}

function jsonResponse(body) {
  return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function respond(requests, urlSubstr, body, method) {
  const req = requests.find(
    (r) => !r.resolved && r.url.includes(urlSubstr) && (!method || r.options.method === method),
  );
  if (!req) throw new Error(`未找到未决请求：${urlSubstr}${method ? ' ' + method : ''}`);
  req.resolved = true;
  req.resolve(jsonResponse(body));
}

// ---------- 加载 app.js ----------

function loadApp() {
  const { fetch, requests } = makeFetch();
  const { document, byId } = makeDocument();
  const timers = []; // 捕获 setInterval 回调（不自动触发，测试里手动 tick）
  const sandbox = {
    console,
    window: { parent: { postMessage() {} }, addEventListener() {}, innerWidth: 400, innerHeight: 600 },
    parent: { postMessage() {} },
    document,
    location: { search: '' },
    URLSearchParams,
    AbortController,
    fetch,
    EventSource: function MockEventSource() { this.close = function () {}; },
    MD: { mdToHtml: (s) => String(s), sanitizeHtml: (s) => String(s) },
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearInterval: () => {},
    navigator: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox);
  return { sandbox, requests, byId, timers };
}

// ---------- 观察辅助 ----------

const EMPTY_LABEL = '（暂无会话，点 ＋ 新建）';
const label = (byId) => byId.get('session-trigger-label').textContent;
const messagesHtml = (byId) => byId.get('messages').children.map((c) => c.innerHTML).join('|');
const btnNewDisabled = (byId) => byId.get('btn-new').disabled;
const btnNewText = (byId) => byId.get('btn-new').textContent;

const session = (id, title) => ({ id, sessionPath: `/data/${id}.jsonl`, title, boundMain: null });

function stateBody(list) {
  return {
    ok: true,
    config: { contextMode: 'windowed', windowSize: 30, includeThinking: true, model: '', selfPrompt: '' },
    sessions: list,
    main: { found: false, rounds: 0, mode: 'windowed' },
  };
}

// boot：解析初始 /api/state，若非空则顺带解析 init 里 openSession(sessions[0]) 的 GET
async function boot(app, list) {
  respond(app.requests, '/api/state', stateBody(list));
  await flush();
  if (list.length) {
    respond(app.requests, `/api/sessions/${list[0].id}`, { ok: true, session: list[0], history: [] });
    await flush();
  }
}

// 触发「＋」新建并解析 POST，停在「openSession 已设置 currentId、GET 未决」的状态
async function beginCreate(app) {
  app.sandbox.newSession();
  respond(app.requests, '/api/sessions', { ok: true, session: session('S1', '测试会话') }, 'POST');
  await flush();
}

// ---------- 场景 ----------

async function scenarioZeroToOneFast() {
  const app = loadApp();
  await boot(app, []);
  check('0→1 初始空态', label(app.byId) === EMPTY_LABEL, label(app.byId));
  await beginCreate(app);
  check('0→1 GET 未决时触发器已进入', label(app.byId) === '测试会话', label(app.byId));
  respond(app.requests, '/api/sessions/S1', { ok: true, session: session('S1', '测试会话'), history: [] });
  await flush();
  check('0→1 GET 成功后仍进入', label(app.byId) === '测试会话', label(app.byId));
}

async function scenarioZeroToOneGetFail() {
  const app = loadApp();
  await boot(app, []);
  await beginCreate(app);
  check('0→1 GET 失败时触发器已进入', label(app.byId) === '测试会话', label(app.byId));
  respond(app.requests, '/api/sessions/S1', { ok: false, error: '读取历史失败：mock' });
  await flush();
  check('0→1 GET 失败后触发器保持进入', label(app.byId) === '测试会话', label(app.byId));
  check('0→1 GET 失败后有错误提示', messagesHtml(app.byId).includes('读取历史失败'), messagesHtml(app.byId));
}

async function scenarioZeroToOneGetHang() {
  const app = loadApp();
  await boot(app, []);
  await beginCreate(app);
  // GET 一直未决（等价「GET 慢 3 秒」的观察窗口）
  check('0→1 GET 挂起时触发器已进入', label(app.byId) === '测试会话', label(app.byId));
}

async function scenarioPostSlowWithPoll() {
  const app = loadApp();
  await boot(app, []);
  app.sandbox.newSession(); // POST 未决（快照耗时）
  // 模拟 POST 期间的一次轮询：后端列表已含新会话
  app.sandbox.pollStateOnce();
  await flush();
  respond(app.requests, '/api/state', stateBody([session('S1', '测试会话')]));
  await flush();
  // POST 返回
  respond(app.requests, '/api/sessions', { ok: true, session: session('S1', '测试会话') }, 'POST');
  await flush();
  check('0→1 POST 慢 + 轮询交错后触发器已进入', label(app.byId) === '测试会话', label(app.byId));
  respond(app.requests, '/api/sessions/S1', { ok: true, session: session('S1', '测试会话'), history: [] });
  await flush();
  check('0→1 POST 慢 + 轮询交错后 GET 成功仍进入', label(app.byId) === '测试会话', label(app.byId));
}

async function scenarioNToNPlusOne() {
  const app = loadApp();
  await boot(app, [session('S0', '旧会话')]);
  check('N→N+1 初始已进入旧会话', label(app.byId) === '旧会话', label(app.byId));
  await beginCreate(app);
  check('N→N+1 新建后触发器进入新会话', label(app.byId) === '测试会话', label(app.byId));
}

async function scenarioSwitchExisting() {
  const app = loadApp();
  await boot(app, [session('S0', '旧会话'), session('S1', '测试会话')]);
  check('切换前为旧会话', label(app.byId) === '旧会话', label(app.byId));
  app.sandbox.openSession('S1');
  respond(app.requests, '/api/sessions/S1', { ok: true, session: session('S1', '测试会话'), history: [] });
  await flush();
  check('切换后为测试会话', label(app.byId) === '测试会话', label(app.byId));
}

async function scenarioAutoCreateSend() {
  const app = loadApp();
  await boot(app, []);
  const input = app.byId.get('input');
  input.value = '你好';
  app.sandbox.send(); // 空白态发消息 → 自动创建
  await flush();
  const createReq = app.requests.find(
    (r) => !r.resolved && r.url.includes('/api/sessions') && r.options.method === 'POST' && !r.url.includes('/messages'),
  );
  check('自动创建先发 POST /api/sessions 且 skipSummary', !!createReq && JSON.parse(createReq.options.body).skipSummary === true);
  respond(app.requests, '/api/sessions', { ok: true, session: session('S1', '测试会话') }, 'POST');
  await flush();
  const createIdx = app.requests.findIndex((r) => r.url.includes('/api/sessions') && r.options.method === 'POST' && !r.url.includes('/messages'));
  const msgIdx = app.requests.findIndex((r) => r.url.includes('/messages'));
  check('顺序：先创建再发消息', createIdx >= 0 && msgIdx >= 0 && createIdx < msgIdx);
  check('自动创建后触发器进入新会话', label(app.byId) === '测试会话', label(app.byId));
  check('自动创建后消息已渲染', messagesHtml(app.byId).includes('你好'), messagesHtml(app.byId));
  check('自动创建后输入框清空', input.value === '', input.value);
  // 排空：loadHistory 的 GET 与 /messages 都收尾，避免残留定时器
  respond(app.requests, '/api/sessions/S1', { ok: true, session: session('S1', '测试会话'), history: [] });
  respond(app.requests, '/messages', { ok: false, error: 'mock' });
  await flush();
}

async function scenarioAutoCreateFail() {
  const app = loadApp();
  await boot(app, []);
  const input = app.byId.get('input');
  input.value = '你好';
  app.sandbox.send();
  await flush();
  respond(app.requests, '/api/sessions', { ok: false, error: '创建会话失败' }, 'POST');
  await flush();
  check('自动创建失败提示错误', messagesHtml(app.byId).includes('创建会话失败'), messagesHtml(app.byId));
  check('自动创建失败不发送（无 /messages）', !app.requests.some((r) => r.url.includes('/messages')));
  check('自动创建失败输入保留', input.value === '你好', input.value);
  check('自动创建失败仍空白态', label(app.byId) === EMPTY_LABEL, label(app.byId));
}

async function scenarioPlaceholder() {
  const app = loadApp();
  await boot(app, []);
  check('空白态 placeholder 引导文案', app.byId.get('input').placeholder === '直接输入，将自动创建第一个会话', app.byId.get('input').placeholder);
  app.sandbox.newSession();
  respond(app.requests, '/api/sessions', { ok: true, session: session('S1', '测试会话') }, 'POST');
  await flush();
  check('有会话后 placeholder 恢复原文案', app.byId.get('input').placeholder === '在此提问（参考上下文会自动带入主对话内容）', app.byId.get('input').placeholder);
}

// ---------- 主流程 ----------

async function main() {
  console.log('=== side-chat UI 模拟回归（debug/ui-sim-test.mjs） ===\n');
  await scenarioZeroToOneFast();
  console.log('');
  await scenarioZeroToOneGetFail();
  console.log('');
  await scenarioZeroToOneGetHang();
  console.log('');
  await scenarioPostSlowWithPoll();
  console.log('');
  await scenarioNToNPlusOne();
  console.log('');
  await scenarioSwitchExisting();
  console.log('');
  await scenarioAutoCreateSend();
  console.log('');
  await scenarioAutoCreateFail();
  console.log('');
  await scenarioPlaceholder();
  console.log('');
  const passed = results.filter((r) => r.ok).length;
  console.log(`---- ${passed}/${results.length} PASS ----`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
