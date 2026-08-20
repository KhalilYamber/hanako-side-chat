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
  get parentElement() { return this.parentNode; } // 与真实 DOM 对齐（providerCard 常驻提示挂 keyInput.parentElement）
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

function loadApp(opts = {}) {
  const { fetch, requests } = makeFetch();
  const { document, byId } = makeDocument();
  const timers = []; // 捕获 setInterval 回调（不自动触发，测试里手动 tick）
  const setTimeoutImpl = opts.setTimeout || setTimeout;
  const clearTimeoutImpl = opts.clearTimeout || clearTimeout;
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
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
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
// 递归收集 messages 子树里的 innerHTML（assistant 正文在 .body 子元素里，非顶层）
const messagesDeepHtml = (byId) => {
  const walk = (el) => {
    let parts = [];
    if (el.innerHTML) parts.push(el.innerHTML);
    for (const c of el.children) parts = parts.concat(walk(c));
    return parts;
  };
  return walk(byId.get('messages')).join('|');
};
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

// 等待下一个未决请求出现（pollReply 循环用），超时返回 null
async function waitForRequest(app, urlSubstr, method, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const req = app.requests.find((r) => {
      if (r.resolved || !r.url.includes(urlSubstr)) return false;
      if (!method) return true;
      const m = r.options.method || 'GET'; // api() 对 GET 不传 method
      return m === method;
    });
    if (req) return req;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

// 驱动 pollReply 的 GET 轮询：按给定 history 序列依次应答；pollReply 提前退出则返回 false
async function drivePollReply(app, id, histories) {
  for (const h of histories) {
    const req = await waitForRequest(app, `/api/sessions/${id}`, 'GET');
    if (!req) return false;
    req.resolved = true;
    req.resolve(jsonResponse({ ok: true, session: session(id, '测试会话'), history: h }));
    await flush();
  }
  return true;
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

async function scenarioH1SlowReply() {
  // 同步 setTimeout：pollReply 的 800ms 延迟即时触发，由测试按 GET 应答节奏驱动
  const app = loadApp({ setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} });
  const OLD = [
    { role: 'user', text: '旧问题' },
    { role: 'assistant', thinking: '旧思考', text: '旧回复' },
  ];
  const NEW = [
    { role: 'user', text: '旧问题' },
    { role: 'assistant', thinking: '旧思考', text: '旧回复' },
    { role: 'user', text: '新问题' },
    { role: 'assistant', thinking: '新思考', text: '新回复' },
  ];
  respond(app.requests, '/api/state', stateBody([session('S1', '测试会话')]));
  await flush();
  respond(app.requests, '/api/sessions/S1', { ok: true, session: session('S1', '测试会话'), history: OLD });
  await flush();
  check('H1 初始末条为旧 assistant', messagesDeepHtml(app.byId).includes('旧回复'), messagesDeepHtml(app.byId));
  app.byId.get('input').value = '新问题';
  app.sandbox.send();
  await flush();
  respond(app.requests, '/messages', { ok: true, mainStats: { rounds: 0, mode: 'windowed' } });
  await flush();
  // 基线 + 4 轮旧 assistant（修复后跳过）+ 新 assistant（渲染）+ 3 轮稳定（return）
  const driven = await drivePollReply(app, 'S1', [OLD, OLD, OLD, OLD, OLD, NEW, NEW, NEW, NEW]);
  check('H1 轮询完整驱动（未提前退出）', driven === true);
  check('H1 慢回复最终渲染新回复', messagesDeepHtml(app.byId).includes('新回复'), messagesDeepHtml(app.byId));
}

async function scenarioCreatingThenSend() {
  const app = loadApp();
  await boot(app, []);
  app.sandbox.newSession(); // 点＋创建，POST 未决（快照耗时）
  await flush();
  const input = app.byId.get('input');
  input.value = '你好';
  app.sandbox.send(); // 创建中按 Enter
  await flush();
  check('M1 创建中 send 提示稍候', messagesHtml(app.byId).includes('正在创建会话，请稍候再发送'), messagesHtml(app.byId));
  check('M1 创建中 send 输入保留', input.value === '你好', input.value);
  check('M1 创建中 send 不发消息', !app.requests.some((r) => r.url.includes('/messages')));
}

async function scenarioDoubleEnter() {
  const app = loadApp();
  await boot(app, []);
  const input = app.byId.get('input');
  input.value = '你好';
  app.sandbox.send(); // 第一次 Enter：自动创建开始
  await flush();
  app.sandbox.send(); // 第二次 Enter：creating=true → 提示，不发
  await flush();
  check('M2 第二次 Enter 提示稍候', messagesHtml(app.byId).includes('正在创建会话，请稍候再发送'), messagesHtml(app.byId));
  respond(app.requests, '/api/sessions', { ok: true, session: session('S1', '测试会话') }, 'POST');
  await flush();
  const msgReqs = app.requests.filter((r) => r.url.includes('/messages'));
  check('M2 仅发送一次消息', msgReqs.length === 1, `messages 请求数=${msgReqs.length}`);
  // 排空：loadHistory 的 GET 与 /messages 收尾
  respond(app.requests, '/api/sessions/S1', { ok: true, session: session('S1', '测试会话'), history: [] });
  respond(app.requests, '/messages', { ok: false, error: 'mock' });
  await flush();
}

// ---------- v32：模型供应商（模型下拉 + 切换保存 + 卡片保存） ----------

const PROVIDER_DS = (hasKey = false) => ({
  id: 'ds',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  hasKey,
  builtin: true,
  protocol: 'openai',
  enabled: true,
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', params: {} },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', params: {} },
  ],
});
const PROVIDERS_BODY = { ok: true, providers: [PROVIDER_DS(true)], defaultProviderId: 'ds', defaultModel: 'deepseek-chat' };

// respond GET /api/providers：renderProviderArea 每次重渲染都会发 GET /api/providers/templates
// （可能先入队），其 url 也包含 '/api/providers'，须先精确消费掉，避免 urlSubstr 误匹配
function respondProviders(app, body) {
  for (const r of app.requests) {
    if (!r.resolved && r.url.includes('/api/providers/templates')) {
      r.resolved = true;
      r.resolve(jsonResponse({ ok: true, templates: [] }));
    }
  }
  respond(app.requests, '/api/providers', body);
}

async function scenarioModelSelectAndSwitch() {
  const app = loadApp();
  await boot(app, [session('S1', '测试会话')]);
  // loadState → renderProviders 的 GET /api/providers（fire-and-forget，此时已入队）
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  const sel = app.byId.get('model-select');
  check('v32 模型下拉渲染两个选项', sel.children.length === 2, `len=${sel.children.length}`);
  check('v32 模型下拉未禁用', sel.disabled === false, `disabled=${sel.disabled}`);
  check('v32 模型下拉默认选中 deepseek-chat', sel.children[0]?.selected === true, sel.children.map((o) => o.value).join(','));
  // 切换模型：设 value + 触发 onchange → POST /api/providers/default
  sel.value = 'deepseek-reasoner';
  sel.onchange();
  await flush();
  const req = app.requests.find((r) => !r.resolved && r.url.includes('/api/providers/default') && r.options.method === 'POST');
  check('v32 切换模型发出 POST default', !!req, 'no req');
  if (req) {
    const body = JSON.parse(req.options.body);
    check('v32 切换模型 body 正确', body.defaultProviderId === 'ds' && body.defaultModel === 'deepseek-reasoner', JSON.stringify(body));
    req.resolved = true;
    req.resolve(jsonResponse({ ok: true }));
    await flush();
  }
}

async function scenarioProviderCardSave() {
  const app = loadApp();
  await boot(app, []);
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  // 打开设置：btn-settings 触发 renderProviders 再拉一次
  app.byId.get('btn-settings').onclick();
  await flush();
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  const area = app.byId.get('provider-area');
  check('v32 设置面板渲染供应商卡片', area.children.length >= 2, `len=${area.children.length}`);
  const card = area.children[1];
  const nameInput = card.children[0].children[0]; // head > name input
  check('v32 卡片名称回显', nameInput.value === 'DeepSeek', nameInput.value);
  nameInput.value = 'DeepSeek 改名';
  const actions = card.children.find((c) => c.className === 'provider-actions');
  check('v32 卡片操作行存在', !!actions, 'no actions');
  actions.children[1].onclick(); // 保存按钮
  await flush();
  const putReq = app.requests.find((r) => !r.resolved && r.url.includes('/api/providers') && r.options.method === 'PUT');
  check('v32 保存发出 PUT /api/providers', !!putReq, 'no put');
  if (putReq) {
    const body = JSON.parse(putReq.options.body);
    check('v32 PUT body：改名生效', body.providers.length === 1 && body.providers[0].name === 'DeepSeek 改名', JSON.stringify(body.providers));
    check('v32 PUT body：apiKey 字段缺省（后端保留原密钥）', !('apiKey' in body.providers[0]), JSON.stringify(body.providers[0]));
    check('v32 PUT body：defaults 保留', body.defaultProviderId === 'ds' && body.defaultModel === 'deepseek-chat');
    putReq.resolved = true;
    putReq.resolve(jsonResponse({ ok: true, providers: [PROVIDER_DS(true)] }));
    await flush();
  }
  // 卡片保存后 provider-area 重渲染（保存按钮恢复可用）
  const area2 = app.byId.get('provider-area');
  check('v32 保存后卡片区重渲染', area2.children.length >= 2, `len=${area2.children.length}`);
}

async function scenarioProviderKeyInput() {
  const app = loadApp();
  await boot(app, []);
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  app.byId.get('btn-settings').onclick();
  await flush();
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  const card = app.byId.get('provider-area').children[1];
  // 卡片字段顺序：head、Base URL label、密钥 label、模型 label、actions
  const keyInput = card.children[2].children[1];
  check('v32 密钥输入框为密码遮罩', keyInput.type === 'password', keyInput.type);
  check('v32 密钥输入框占位提示「留空保持不变」', keyInput.placeholder.includes('留空保持不变'), keyInput.placeholder);
  // 未填新 key → 保存时不传 apiKey 字段（保留原密钥）
  const actions = card.children.find((c) => c.className === 'provider-actions');
  actions.children[1].onclick();
  await flush();
  const putReq = app.requests.find((r) => !r.resolved && r.url.includes('/api/providers') && r.options.method === 'PUT');
  check('v32 密钥留空保存：apiKey 字段缺省', !!putReq && !('apiKey' in JSON.parse(putReq.options.body).providers[0]));
  if (putReq) {
    putReq.resolved = true;
    putReq.resolve(jsonResponse({ ok: true, providers: [PROVIDER_DS(true)] }));
    await flush();
  }
  // 填写新 key → 保存时携带
  const card2 = app.byId.get('provider-area').children[1];
  const keyInput2 = card2.children[2].children[1];
  keyInput2.value = 'sk-new-key';
  const actions2 = card2.children.find((c) => c.className === 'provider-actions');
  actions2.children[1].onclick();
  await flush();
  const putReq2 = app.requests.find((r) => !r.resolved && r.url.includes('/api/providers') && r.options.method === 'PUT');
  check('v32 填写新 key：apiKey 字段携带', !!putReq2 && JSON.parse(putReq2.options.body).providers[0].apiKey === 'sk-new-key');
  if (putReq2) {
    putReq2.resolved = true;
    putReq2.resolve(jsonResponse({ ok: true, providers: [PROVIDER_DS(true)] }));
    await flush();
  }
}

async function scenarioTestConnectMergesModels() {
  const app = loadApp();
  await boot(app, []);
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  app.byId.get('btn-settings').onclick();
  await flush();
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  const card = app.byId.get('provider-area').children[1];
  const modelsInput = card.children[3].children[1];
  check('v33 测试前模型列表为模板两个', modelsInput.value.split('\n').length === 2, modelsInput.value);
  // 点击「测试连接」（actions 第一个按钮）→ POST /api/providers/test 返回真实模型列表
  const actions = card.children.find((c) => c.className === 'provider-actions');
  actions.children[0].onclick();
  await flush();
  const testReq = app.requests.find((r) => !r.resolved && r.url.includes('/api/providers/test') && r.options.method === 'POST');
  check('v33 测试连接发出 POST test', !!testReq, 'no req');
  if (testReq) {
    testReq.resolved = true;
    testReq.resolve(jsonResponse({ ok: true, status: 200, models: ['deepseek-chat', 'deepseek-v4-flash'] }));
    await flush();
    const lines = modelsInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const chatLines = lines.filter((l) => l.startsWith('deepseek-chat'));
    check('v33 拉取模型并入列表（去重保留已有）', lines.length === 3 && lines.some((l) => l.startsWith('deepseek-v4-flash')) && chatLines.length === 1, modelsInput.value);
    const result = actions.children[2];
    check('v33 提示含新增模型数量', result.textContent.includes('新增 1 个'), result.textContent);
  }
}

async function scenarioProviderKeySavedHint() {
  const app = loadApp();
  await boot(app, []);
  respondProviders(app, PROVIDERS_BODY); // ds hasKey=true
  await flush();
  app.byId.get('btn-settings').onclick();
  await flush();
  respondProviders(app, PROVIDERS_BODY);
  await flush();
  const card = app.byId.get('provider-area').children[1];
  // 卡片字段顺序：head、Base URL label、密钥 label（input + 常驻提示）、模型 label、actions
  const keyLabel = card.children[2];
  const hint = keyLabel.children[2];
  check('v36 hasKey 卡片渲染「密钥已保存」常驻提示', !!hint && hint.className === 'provider-key-saved' && hint.textContent.includes('密钥已保存'), hint?.textContent ?? 'no hint');
  check('v36 提示文案含「留空保持不变」', !!hint && hint.textContent.includes('留空保持不变'), hint?.textContent ?? 'no hint');
  // 保存成功 → 重渲染后提示仍常驻（基于 hasKey 渲染，不随 renderProviderArea 消失）
  const actions = card.children.find((c) => c.className === 'provider-actions');
  actions.children[1].onclick();
  await flush();
  const putReq = app.requests.find((r) => !r.resolved && r.url.includes('/api/providers') && r.options.method === 'PUT');
  if (putReq) {
    putReq.resolved = true;
    putReq.resolve(jsonResponse({ ok: true, providers: [PROVIDER_DS(true)] }));
    await flush();
  }
  const card2 = app.byId.get('provider-area').children[1];
  const hint2 = card2.children[2]?.children[2];
  check('v36 保存重渲染后提示仍常驻', !!hint2 && hint2.className === 'provider-key-saved' && hint2.textContent.includes('密钥已保存'), hint2?.textContent ?? 'no hint');
  // 反向：hasKey=false（未保存过密钥）不渲染提示
  const app2 = loadApp();
  await boot(app2, []);
  respondProviders(app2, { ok: true, providers: [PROVIDER_DS(false)], defaultProviderId: 'ds', defaultModel: 'deepseek-chat' });
  await flush();
  app2.byId.get('btn-settings').onclick();
  await flush();
  respondProviders(app2, { ok: true, providers: [PROVIDER_DS(false)], defaultProviderId: 'ds', defaultModel: 'deepseek-chat' });
  await flush();
  const cardN = app2.byId.get('provider-area').children[1];
  const keyLabelN = cardN.children[2];
  const hintN = keyLabelN.children[2];
  check('v36 hasKey=false 不渲染常驻提示', !hintN || hintN.className !== 'provider-key-saved', hintN?.className ?? 'no hint');
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
  await scenarioH1SlowReply();
  console.log('');
  await scenarioCreatingThenSend();
  console.log('');
  await scenarioDoubleEnter();
  console.log('');
  await scenarioModelSelectAndSwitch();
  console.log('');
  await scenarioProviderCardSave();
  console.log('');
  await scenarioProviderKeyInput();
  console.log('');
  await scenarioProviderKeySavedHint();
  console.log('');
  await scenarioTestConnectMergesModels();
  console.log('');
  const passed = results.filter((r) => r.ok).length;
  console.log(`---- ${passed}/${results.length} PASS ----`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
