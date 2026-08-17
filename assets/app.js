// 就绪握手：host 的 widget 组件靠监听 iframe 的 postMessage("ready") 才把面板从
// 「加载失败」态切换为 ready（否则 iframe 会一直被 opacity:0 遮住）。
window.parent.postMessage({ type: "ready" }, "*");

// app.js —— SideChat widget 前端
// 插件 routes 挂载在 /api/plugins/side-chat/ 下，用普通 fetch + 绝对基址调用。
// 认证：首次打开 widget 时 host 通过 pluginIframeTicket 换取会话 cookie，
// 后续同源请求自动携带，无需手动处理 token。

const $ = (id) => document.getElementById(id);

const API_BASE = '/api/plugins/side-chat';

// 认证兜底：真实环境里 host 已登录，fetch 走 hana_session cookie；
// 无 cookie 时（如直接打开 iframe URL），host 会把 token 放在 URL query 里，一并带上。
// agentId 是主对话 agent 标识（host 打开 iframe 时传入），后端靠它定位主会话。
const URL_PARAMS = new URLSearchParams(location.search);
const TOKEN = URL_PARAMS.get('token') || '';
const AGENT_ID = URL_PARAMS.get('agentId') || '';
// sessionPath 来自 host 补丁注入的 iframe URL，是「当前打开主对话」的真实路径，
// 优先级高于任何猜测值（后端 resolveMainSessionPath 第一个校验它）
const SESSION_PATH = URL_PARAMS.get('sessionPath') || '';
// [page-ext] 页面模式主会话接口位：/page 未来承载大界面功能时需获取「当前主会话」，
// 经 sessionPath 注入或等价机制传递（当前 /page 与 /widget 共用下方定位逻辑，行为不变）

// 运行表面分层：/widget（侧栏面板）与 /page（页面入口）共用同一前端，
// 靠 <html data-surface> 区分（模板默认 widget，后端 /page 渲染时替换为 page）。
// 当前两侧逻辑与外观一致，仅预留扩展位。
const SURFACE = document.documentElement.dataset.surface || 'widget';

let state = { sessions: [], config: null, currentId: null, busy: false, creating: false, deleting: false, currentHasMessages: false, lastMainPath: null, mainPath: null, providers: [], defaultProviderId: '', defaultModel: '' };
let timer = null;

// 输入框引导文案：空白态（无会话）提示自动创建，有会话恢复原文案
const INPUT_PLACEHOLDER_DEFAULT = '在此提问（参考上下文会自动带入主对话内容）';
const INPUT_PLACEHOLDER_EMPTY = '直接输入，将自动创建第一个会话';
function updateInputPlaceholder() {
  $('input').placeholder = state.sessions.length ? INPUT_PLACEHOLDER_DEFAULT : INPUT_PLACEHOLDER_EMPTY;
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const extra = [];
  if (TOKEN) extra.push(`token=${encodeURIComponent(TOKEN)}`);
  if (AGENT_ID) extra.push(`agentId=${encodeURIComponent(AGENT_ID)}`);
  // sessionPath：host 补丁注入的「当前打开主对话」真实路径，优先级最高
  if (SESSION_PATH) extra.push(`sessionPath=${encodeURIComponent(SESSION_PATH)}`);
  // 透传「最近活跃主会话」路径：后端 resolveMainSessionPath 优先用它定位参考上下文
  // （SSE 追踪到才带；null 时后端走 agent 最近会话兜底，行为与旧版一致）
  if (state.lastMainPath) extra.push(`mainPath=${encodeURIComponent(state.lastMainPath)}`);
  const url = API_BASE + path + (extra.length ? `${sep}${extra.join('&')}` : '');
  // fetch 超时兜底：网络挂起时不能让 busy/轮询永久锁死（REVIEW1 发现 16 残余）。
  // 默认 30 秒；opts.timeout 可覆盖（REVIEW3 M10：POST /api/sessions 含快照摘要模型调用，放宽到 90 秒）
  let abortTimer = null;
  let timeoutMs = 30000; // 默认 30 秒；opts.timeout 可覆盖（REVIEW3 M10）
  if (!opts.signal) {
    const ctrl = new AbortController();
    timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : 30000;
    abortTimer = setTimeout(() => ctrl.abort(), timeoutMs);
    opts = { ...opts, signal: ctrl.signal };
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch (e) {
    return { ok: false, error: `网络错误：${e?.name === 'AbortError' ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : (e?.message ?? e)}` };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
  try {
    return await res.json();
  } catch {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}${body ? `：${body.slice(0, 300)}` : ''}` };
  }
}

// 加载阶段错误可见化：面板打开即失败时，拉取诊断信息并渲染为清单（借鉴 DSHana 诊断思路）
function showFatal(error) {
  $('messages').innerHTML = '';
  const el = document.createElement('div');
  el.className = 'msg sys fatal';
  el.textContent = `⚠ 初始化失败：${error}\n\n（token=${TOKEN ? '有' : '无'}，agentId=${AGENT_ID || '无'}）`;
  $('messages').appendChild(el);
  // 失败时自动拉诊断，帮助定位根因（token 补丁 / 主会话定位等）
  api('/api/diagnostics').then((res) => {
    const d = document.createElement('div');
    d.className = 'msg sys fatal';
    d.textContent = '--- 健康自检 ---\n' + formatDiagnostics(res);
    $('messages').appendChild(d);
  });
}

// 把 /api/diagnostics 的返回格式化为可读文本
function formatDiagnostics(d) {
  if (!d || !d.ok) return '（诊断接口不可用，可能是插件未加载完成）';
  const lines = [];
  lines.push(`agentId：${d.agentId ? '✓ ' + d.agentId : '✗ 缺失（请从主对话重新打开面板，host 会附带 agentId）'}`);
  const ms = d.mainSession;
  lines.push(`主会话定位：${ms?.found ? `✓ ${ms.rounds} 轮（${ms.viaApi ? '官方通道(兜底)' : '文件直读'}${ms.pending ? '，回复中' : ''}）` : `✗ ${ms?.error ?? '未找到'}（主对话暂无内容或 agents 目录异常）`}`);
  const hp = d.hostPatch;
  if (hp?.status === 'pass') lines.push(`host 补丁：✓ ${hp.detail ?? '生效中'}`);
  else if (hp?.status === 'fail') lines.push(`host 补丁：✗ ${hp.detail ?? '丢失'}（升级会覆盖 artifacts，需重新打补丁：在 bundle 的 jot 集合补回 "token"，详见 debug/check-host-patch.js）`);
  else lines.push(`host 补丁：？ ${hp?.reason ?? '无法检测'}`);
  const ck = d.cache;
  lines.push(`摘要缓存：${ck?.exists ? `${ck.lastRoundCount} 轮${ck.hasSummary ? '（有摘要）' : ''}${ck.mainSessionPath ? '，主会话已绑定' : ''}` : '无（尚未生成）'}`);
  const cf = d.config;
  if (cf) lines.push(`配置：${cf.contextMode === 'full' ? '全量' : `最近 ${cf.windowSize} 轮+摘要`}${cf.includeThinking ? '，含思考' : ''}${cf.model ? '，模型 ' + cf.model : ''}`);
  return lines.join('\n');
}

// ---------- 渲染 ----------

// ---------- 会话选择器（自定义列表替代原生 select） ----------
// 排序与旧 renderSessionSelect 一致：未绑定（旧数据）分组排后，组内保持 state.sessions 原序
// （后端按 updatedAt 倒序返回）；排序用稳定 sort，同组相对顺序不变。
function orderedSessions() {
  return [...state.sessions].sort((a, b) => Number(!!a.unbound) - Number(!!b.unbound));
}

// 统一渲染：触发器标题（当前会话，含未绑定前缀；无会话显示占位）+ 列表内容（仅列表打开时重建）。
// 列表打开期间轮询不调用本函数（见 pollStateOnce 注释），避免展开态被刷新打断。
function renderSessionList() {
  const cur = state.sessions.find((s) => s.id === state.currentId);
  const label = cur ? (cur.unbound ? `（未绑定）${cur.title}` : cur.title) : '（暂无会话，点 ＋ 新建）';
  $('session-trigger-label').textContent = label;
  $('session-trigger').title = cur ? label : '选择会话';
  updateInputPlaceholder();
  if (!isSessionListOpen()) return;
  const list = $('session-list');
  list.innerHTML = '';
  const ordered = orderedSessions();
  if (!ordered.length) {
    const empty = document.createElement('div');
    empty.className = 'session-item empty';
    empty.textContent = '（暂无会话，点 ＋ 新建）';
    list.appendChild(empty);
    return;
  }
  for (const s of ordered) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === state.currentId ? ' current' : '') + (s.unbound ? ' unbound' : '');
    const t = document.createElement('span');
    t.className = 'session-item-title';
    t.textContent = s.unbound ? `（未绑定）${s.title}` : s.title;
    item.appendChild(t);
    item.dataset.id = s.id;
    // 左键：切换会话 + 收起列表（菜单一并关闭，见 closeSessionList）
    item.onclick = () => { closeSessionList(); openSession(s.id); };
    // 右键：操作目标 = 该项会话 id（无需先选中），菜单在列表浮层之上显示（z-index 高于列表）
    item.oncontextmenu = (e) => {
      e.preventDefault();
      closeCtxMenu(); // 再次右键：先关旧菜单
      if (!canOpenCtxMenu(s.id)) return; // 编辑态不弹（列表此时已收起，防御性检查）
      openCtxMenu(e.clientX, e.clientY, s.id);
    };
    list.appendChild(item);
  }
}

function isSessionListOpen() {
  return !$('session-list').classList.contains('hidden');
}

function openSessionList() {
  closeCtxMenu(); // 打开列表时同步关掉旧菜单（列表收起/打开都与菜单互斥）
  $('session-list').classList.remove('hidden');
  renderSessionList(); // 展开后再渲染内容（renderSessionList 仅在展开态重建列表，反映最新数据）
}

function closeSessionList() {
  $('session-list').classList.add('hidden');
  closeCtxMenu(); // 列表收起时同步关闭菜单
}

function toggleSessionList() {
  if (isSessionListOpen()) closeSessionList();
  else openSessionList();
}

// 统一刷新「新建会话」按钮态：
// - 无任何会话：允许建第一个；
// - 当前选中会话为空对话（0 条消息）：置灰，防止连点产生空壳会话；
// - 当前选中会话有内容：允许新建。
function updateNewBtn() {
  const btn = $('btn-new');
  if (renameSessionId !== null) { btn.disabled = true; return; } // 编辑态锁定（防轮询等路径解锁）
  if (!state.sessions.length) {
    btn.disabled = false;
    btn.title = '新建会话';
    return;
  }
  if (!state.currentHasMessages) {
    btn.disabled = true;
    btn.title = '当前会话还没有内容，聊几句后再开新会话';
    return;
  }
  btn.disabled = false;
  btn.title = '新建会话';
}

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = MD.sanitizeHtml(MD.mdToHtml(text));
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

// 渲染一条 assistant 消息：思考块（💭，点击折叠/展开）+ 正文。
// dataset.seen 存正文文本，供 pollReply 增量对比；dataset.think 存思考文本。
function addAssistantMsg(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  fillAssistantMsg(wrap, msg);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
  return wrap;
}

// 就地更新已有 assistant 块（thinking/text 增长时用，避免重复追加）
function updateAssistantMsg(wrap, msg) {
  fillAssistantMsg(wrap, msg);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function fillAssistantMsg(wrap, msg) {
  const think = (msg.thinking ?? '').trim();
  const text = (msg.text ?? '').trim();
  let t = wrap.querySelector('.think');
  if (think) {
    if (!t) {
      t = document.createElement('div');
      t.className = 'think collapsed'; // 默认折叠：只显示占位提示，点击展开完整思考
      t.title = '点击展开/收起思考';
      t.onclick = () => {
        t.classList.toggle('collapsed');
        refreshThink(t);
      };
      wrap.insertBefore(t, wrap.firstChild);
    }
    t.dataset.full = msg.thinking;
    refreshThink(t);
  } else if (t) {
    t.remove();
  }
  let b = wrap.querySelector('.body');
  if (text) {
    if (!b) {
      b = document.createElement('div');
      b.className = 'body';
      wrap.appendChild(b);
    }
    b.innerHTML = MD.sanitizeHtml(MD.mdToHtml(msg.text));
  } else if (b) {
    b.remove();
  }
  wrap.dataset.seen = msg.text ?? '';
  wrap.dataset.think = msg.thinking ?? '';
}

// 思考块显示刷新：折叠态显示占位提示，展开态显示完整思考文本
function refreshThink(t) {
  if (t.classList.contains('collapsed')) {
    t.textContent = '💭 思考内容（点击展开）';
  } else {
    t.textContent = `💭 ${t.dataset.full ?? ''}`;
  }
}

function renderMainBar(main) {
  const dot = $('main-dot');
  const label = $('main-label');
  if (!main) {
    dot.className = '';
    label.textContent = '主对话：未找到';
    return;
  }
  const rounds = main.rounds ?? 0;
  const mode = main.mode ?? (state.config?.contextMode ?? 'windowed');
  const pending = main.pending;
  dot.className = pending ? 'warn' : 'ok';
  let base = `主对话：${rounds} 轮 · ${mode === 'full' ? '全量' : `最近 ${state.config?.windowSize ?? 30} 轮+摘要`}`;
  // 快照同步状态：mainStats.snapshot=true 时展示已同步进度（M=main.lastSynced）；
  // M 与总轮数相等简化为「已同步」，M 缺失/为 0 时不追加（保持原文案）
  if (main.snapshot === true) {
    const synced = Number(main.lastSynced) || 0;
    if (synced > 0) base += synced >= rounds ? ' · 已同步' : ` · 已同步至 ${synced} 轮`;
  }
  label.textContent = pending ? `${base}（正在回复中…）` : base;
}

// 轻量刷新主对话指示（SSE 收到事件或轮询兜底时调用）
async function refreshMain() {
  const res = await api('/api/state');
  if (!res.ok) return;
  if (res.config) state.config = res.config;
  if (res.main) {
    // 服务端最终解析的主会话路径：与辅助会话 boundMain 对比（提示条判定依据）
    state.mainPath = res.main.sessionPath ?? null;
    renderMainBar(res.main);
  }
  renderBindHint();
}

// 绑定提示条：当前选中会话的 boundMain 与「当前主会话」都存在且不同 → 显示，点击一键切换。
// 相同或任一缺失（含旧数据未绑定）→ 隐藏，行为与旧版一致。
function renderBindHint() {
  const hint = $('bind-hint');
  const entry = state.sessions.find((s) => s.id === state.currentId);
  const bound = entry?.boundMain ?? null;
  const cur = state.mainPath ?? null;
  if (!bound || !cur || bound === cur) {
    hint.classList.add('hidden');
    return;
  }
  // 文案用文件名（去扩展名）指代绑定的主对话，完整路径太长不适合展示
  const name = (bound.split(/[\\/]/).pop() || '主对话').replace(/\.jsonl$/i, '');
  $('bind-hint-text').textContent = `⚠ 绑定主对话 ${name}，点击切换到当前`;
  hint.classList.remove('hidden');
}

// 提示条点击：把当前会话绑定到「当前主会话」（POST bind），成功后更新本地条目并隐藏提示条
async function bindToCurrent() {
  const id = state.currentId;
  if (!id || !state.mainPath) return;
  const res = await api(`/api/sessions/${encodeURIComponent(id)}/bind`, {
    method: 'POST',
    body: JSON.stringify({ mainPath: state.mainPath }),
  });
  if (!res.ok) {
    addMsg('sys', res.error ?? '切换绑定失败');
    return;
  }
  const entry = state.sessions.find((s) => s.id === id);
  if (entry) entry.boundMain = res.boundMain ?? state.mainPath;
  renderBindHint();
}

// 主对话实时同步：SSE 长连接，主对话有新消息/回复完成即刷新
function connectMainEvents() {
  if (typeof EventSource === 'undefined') return;
  const q = [];
  if (TOKEN) q.push(`token=${encodeURIComponent(TOKEN)}`);
  if (AGENT_ID) q.push(`agentId=${encodeURIComponent(AGENT_ID)}`);
  const url = `${API_BASE}/api/main-events${q.length ? '?' + q.join('&') : ''}`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'main-changed') {
        // 追踪「最近活跃主会话」：sessionPath 存在才更新（null 时保持旧值，自然降级不报错）
        if (msg.sessionPath) state.lastMainPath = msg.sessionPath;
        refreshMain();
      }
    } catch { /* 忽略非 JSON 心跳 */ }
  };
  // EventSource 断线会自动重连，无需手动处理
  es.onerror = () => { /* 交给 EventSource 自身重连 */ };
}

// ---------- 主对话切换重定位（relocate 机制，2026-08-16） ----------
// 背景：widget iframe 是 agent 级共享实例，同一 agent 下切换主对话时 iframe 不重载、
// host 也不通知切换事件，前端 state 全部保留；lastMainPath 只被 SSE 消息事件更新，
// 切到新主对话后若它暂无新消息，lastMainPath 会停留在旧值，列表/参考上下文锁死在旧主对话。
// relocate 用「面板激活/周期」信号补足：让后端忽略 lastMainPath，按最近活跃 public 主会话
// （mtime）重新定位。两个信号互补：SSE=最近消息，relocate=最近活跃纠正。

// 触发防抖：focus 与 visibilitychange 常成对触发，5 秒内只执行一次（时间戳记录）
let lastRelocateAt = 0;
const RELOCATE_DEBOUNCE_MS = 5000;

// 主对话重定位：调 /api/state?relocate=1（api() 会自动带 lastMainPath，后端 relocate
// 模式会忽略它）。返回是否发生了切换：是 → 更新 lastMainPath 并跑一轮轮询刷新
// 列表/指示，调用方（20 秒周期轮询）据此跳过本轮正常轮询，避免重复刷新 mainbar。
async function relocateMain() {
  const now = Date.now();
  if (now - lastRelocateAt < RELOCATE_DEBOUNCE_MS) return false; // 防抖：跳过
  lastRelocateAt = now;
  const res = await api('/api/state?relocate=1');
  if (!res.ok) return false;
  const newPath = res.main?.sessionPath ?? null;
  if (!newPath || newPath === state.lastMainPath) return false; // 未发生切换
  // 主会话已切换：更新追踪路径后跑一轮正常轮询（id 序列对比 + renderBindHint），
  // 列表过滤随新路径自动收敛，触发器/列表变化由轮询对比刷新（列表打开时跳过重渲染）
  state.lastMainPath = newPath;
  await pollStateOnce();
  return true;
}

// 单轮状态轮询：拉 /api/state 并同步主对话指示与列表
// （由 5 秒兜底轮询与 relocateMain 共用，避免两处重复逻辑）
async function pollStateOnce() {
  const res = await api('/api/state');
  if (!res.ok) return;
  state.mainPath = res.main?.sessionPath ?? null;
  renderMainBar(res.main);
  // 内容对比：id 序列 + unbound 标记（同长度不同内容/绑定状态变化也要刷新，
  // 惰性绑定后 unbound 标记消失即靠它收敛）
  const idSeq = (list) => (list ?? []).map((s) => `${s.id}:${s.unbound ? 'u' : 'b'}`).join(',');
  if (idSeq(res.sessions) !== idSeq(state.sessions)) {
    state.sessions = res.sessions;
    // 列表浮层打开期间不重渲染（避免展开态被打断/闪动），触发器标题不受影响；
    // 关闭后下一次打开时由 openSessionList 重渲染，自然反映最新列表（取舍见 A5 简单方案）。
    if (!isSessionListOpen()) renderSessionList();
  }
  // 会话失配回退：独立于 idSeq 变化，非创建期每轮校验一次（修复 H3）。
  // 创建期除外（!state.creating）：newSession 正把新建会话设为当前会话（快照耗时下 POST
  // 未返回期间轮询会先把新会话写进列表，形成交错），若此时触发回退会把 currentId 改写为
  // null/其它会话，并经 openSeq 丢弃 newSession 的 openSession 结果，导致「新建后未进入」
  // （0→1 首建时列表为空，openSession(null) 直接回到「无会话」空态）。创建期间交给
  // newSession 自己收口。创建结束后（含创建失败）每轮都会校验，避免「创建期跳过后列表
  // 已同步、idSeq 恒相等」导致 currentId 悬空永不纠正。
  if (!state.creating && state.currentId && !state.sessions.some((s) => s.id === state.currentId)) {
    await openSession(state.sessions[0]?.id ?? null);
  }
  renderBindHint();
}

async function loadState() {
  const res = await api('/api/state');
  if (!res.ok) {
    showFatal(res.error ?? '未知错误');
    return;
  }
  state.config = res.config;
  state.sessions = res.sessions ?? [];
  state.mainPath = res.main?.sessionPath ?? null;
  renderMainBar(res.main);
  renderSessionList();
  fillSettings();
  renderProviders();
  updateNewBtn();
  renderBindHint();
}

// 会话打开请求序号：快速切换时丢弃过期响应，避免旧会话内容覆盖新视图（REVIEW1 发现 16 残余）
let openSeq = 0;

async function openSession(id) {
  closeSessionList(); // 会话切换（含轮询/删除/新建等一切路径）时收起列表并关闭右键菜单
  // 防御：列表刷新后 currentId 指向的会话可能已被隔离过滤/删除（主对话切换/隔离导致），
  // 触发器仍显示旧标题但 currentId 是旧值，后续发消息/删除会打到不可见会话。
  // 这里统一回退：id 不在列表且列表非空 → 打开第一个；列表为空 → 空态。
  // 其它调用路径不受影响：newSession/删除后打开的 id 一定刚写进列表，不会命中防御。
  if (id && !state.sessions.some((s) => s.id === id)) {
    id = state.sessions.length ? state.sessions[0].id : null;
  }
  const seq = ++openSeq;
  state.currentId = id;
  state.currentHasMessages = false;
  $('messages').innerHTML = '';
  // 立即刷新触发器/列表标题：currentId 已变更，视图应立即反映「已进入该会话」，
  // 不依赖下方历史读取的网络往返。若 GET 慢或失败（session:history 对刚创建的会话
  // 可能未就绪），触发器也不会停在「（暂无会话，点 ＋ 新建）」/旧标题。
  renderSessionList();
  if (!id) {
    updateNewBtn();
    renderBindHint();
    return;
  }
  // 「进入」与「历史加载」彻底解耦：进入（currentId + 渲染）已同步完成，历史异步拉取，
  // 失败/挂起绝不影响「已进入」状态与发消息能力（newSession / 空白态自动创建都依赖此点）。
  loadHistory(seq, id).catch(() => {});
}

// 会话历史异步加载：只负责渲染历史与同步惰性归属，不参与「进入」判定。
// seq 用于丢弃过期结果（期间若已切换到别的会话，本次结果作废）。
async function loadHistory(seq, id) {
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if (seq !== openSeq) return; // 已有更新的打开请求：丢弃本次过期结果
  if (!res.ok) {
    addMsg('sys', res.error ?? '加载失败');
    // 历史加载失败不应把「新建」按钮锁死（currentHasMessages 恒 false 会导致按钮长期置灰、
    // 无重试入口）。放宽为「视为有内容」，允许开新会话或重新进入本会话重试（H4）。
    state.currentHasMessages = true;
    updateNewBtn();
    return;
  }
  // 惰性归属：后端打开时可能刚把旧数据自动绑定到当前主会话，同步本地条目
  // （去掉 unbound 标记、写入 boundMain，触发器/列表标题与提示条立即反映新状态）
  if (res.session?.boundMain) {
    const entry = state.sessions.find((s) => s.id === id);
    if (entry) {
      entry.boundMain = res.session.boundMain;
      delete entry.unbound;
    }
  }
  const history = res.history ?? [];
  state.currentHasMessages = history.length > 0;
  for (const m of history) {
    if (m.role === 'user') {
      addMsg('user', m.text ?? '');
    } else if (m.role === 'assistant') {
      // 思考块 + 正文一起渲染（thinking 由后端 normalizeHistory 透传）
      if ((m.text ?? '').trim() || (m.thinking ?? '').trim()) {
        addAssistantMsg({ thinking: m.thinking ?? '', text: m.text ?? '' });
      }
    }
  }
  renderSessionList();
  updateNewBtn();
  renderBindHint();
}

// ---------- 操作 ----------

async function newSession() {
  // 创建锁：连点「＋」会并发发多个 POST，产生空壳会话（REVIEW1 发现 4 实证）
  if (state.creating) return;
  state.creating = true;
  $('btn-new').disabled = true;
  // 创建反馈：windowed 模式创建时后端要调一次模型生成快照摘要（可能 5~30 秒），
  // 按钮置灰无提示会显得像卡死（2026-08-16 审视发现）
  const newBtn = $('btn-new');
  const originalText = newBtn.textContent;
  newBtn.textContent = '创建中…';
  newBtn.title = '正在创建并生成主对话上下文快照…';
  try {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}), timeout: 90000 });
    if (!res.ok) {
      addMsg('sys', res.error ?? '新建失败');
      return;
    }
    // 去重：轮询可能在 POST 未返回期间（快照耗时）已把新会话写进 state.sessions，
    // 这里按 id 去重后再置顶，避免同一会话出现两条重复项（重复项还会让后续轮询的
    // idSeq 恒不相等，反复触发列表替换）。
    state.sessions = [res.session, ...state.sessions.filter((s) => s.id !== res.session.id)];
    renderSessionList();
    await openSession(res.session.id);
  } finally {
    state.creating = false;
    newBtn.textContent = originalText;
    updateNewBtn(); // 恢复按钮态：新会话为空时保持置灰（防连点空壳）
  }
}

// 两态删除的 armed 状态按目标会话 id 独立存储（不同目标互不干扰）。
// 顶栏 🗑 已移除，入口统一走右键菜单（菜单项文本由 renderCtxMenuDel 同步）。
const delArmed = new Map(); // 目标会话 id -> 3 秒复原定时器句柄

// 进入确认态：3 秒内再点同一目标才执行删除；超时自动复原
function armDel(id) {
  disarmDel(id); // 防重复 arm（同一目标连点只保留一个计时窗口）
  const t = setTimeout(() => disarmDel(id), 3000);
  delArmed.set(id, t);
  renderCtxMenuDel(); // 菜单打开且目标为该 id 时，菜单项变「确认删除？」
}

// 退出确认态：清计时器与标记，同步复原菜单项显示（目标匹配时）
function disarmDel(id) {
  const t = delArmed.get(id);
  if (t) { clearTimeout(t); delArmed.delete(id); }
  renderCtxMenuDel();
}

async function delSession(id) {
  if (state.deleting) return; // 删除请求进行中防重入（重复点击会发二次请求）
  const targetId = id ?? state.currentId; // 无参 → 当前会话；有参 → 目标会话
  if (!targetId || !state.sessions.some((s) => s.id === targetId)) {
    addMsg('sys', '没有可删除的会话');
    return;
  }
  // 两态确认：iframe 环境里 window.confirm 会被 host 静默禁用（点删除没反应），
  // 改用「第一次点击变确认态，3 秒内再点才执行」的内联确认（armed 按目标 id 独立计时）。
  if (!delArmed.has(targetId)) {
    armDel(targetId);
    return; // 菜单路径：菜单保持打开，项文本变「确认删除？」（renderCtxMenuDel 同步）
  }
  disarmDel(targetId);
  state.deleting = true;
  let res;
  try {
    res = await api(`/api/sessions/${encodeURIComponent(targetId)}/delete`, { method: 'POST', body: JSON.stringify({}) });
  } finally {
    state.deleting = false;
  }
  if (!res.ok) {
    addMsg('sys', res.error ?? '删除失败');
    return;
  }
  state.sessions = state.sessions.filter((s) => s.id !== targetId);
  if (targetId === state.currentId) {
    // 删除的是当前会话：走现有切换/空态逻辑（openSession 内部会收列表）
    if (state.sessions.length) {
      await openSession(state.sessions[0].id);
    } else {
      state.currentId = null;
      state.currentHasMessages = false;
      $('messages').innerHTML = '';
      renderSessionList();
      updateNewBtn();
    }
  } else {
    // 删除的不是当前会话：只从列表移除，不切换当前会话
    renderSessionList();
  }
  // 删除成功：菜单关闭并收起列表（openSession 路径已收，此处幂等兜底）
  closeCtxMenu();
  closeSessionList();
}

// ---------- 会话重命名 ----------
// 编辑态：rename-bar 替换触发器（触发器隐藏即不可交互），列表收起，新建按钮禁用，
// 防止切换会话导致保存到错误 id。Enter 保存 / Esc 取消 / 按钮双支持；
// 失焦无改动退出不保存，有改动保留编辑态（防误触丢输入）。
// iframe 环境 confirm/prompt 均被禁用，错误用编辑条内红字提示（3 秒自动消失）。
let renameSessionId = null;  // 进入编辑态时的会话 id（编辑期间 currentId 可能被轮询改写，保存用此快照）
let renameOriginal = '';     // 进入编辑态时的原标题（失焦「无改动」判定基准）
let renameErrorTimer = null; // 红字错误提示自动消失定时器

function showRenameError(msg) {
  const err = $('rename-error');
  err.textContent = msg;
  err.classList.remove('hidden');
  if (renameErrorTimer) clearTimeout(renameErrorTimer);
  renameErrorTimer = setTimeout(() => err.classList.add('hidden'), 3000);
}

// 操作目标泛化。无参 → 当前会话（触发器/菜单默认）；有参 → 目标会话（列表项右键）。
// 编辑对象可以是「当前会话」或「右键目标会话」，编辑条预填目标标题，保存后目标条目 title 更新
// （目标非当前会话时只更新其 title，不切换当前会话）。
function startRename(id) {
  const targetId = id ?? state.currentId;
  const entry = state.sessions.find((s) => s.id === targetId);
  if (!entry) return;
  renameSessionId = entry.id;
  renameOriginal = entry.title;
  const input = $('rename-input');
  input.value = entry.title;
  $('rename-error').classList.add('hidden');
  // 编辑态切换：触发器隐藏（不可交互，等效禁用），列表收起，编辑条占据其位置
  closeCtxMenu();
  closeSessionList();
  $('session-trigger').classList.add('hidden');
  $('rename-bar').classList.remove('hidden');
  // 清理该目标的两态确认残留（进入编辑态后菜单不可达，不能停留在「确认删除？」计时中）
  disarmDel(entry.id);
  // 编辑态锁：防切换会话导致保存到错误 id
  $('btn-new').disabled = true;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length); // 光标置末尾，避免误覆盖原标题
}

function exitRename() {
  renameSessionId = null;
  $('rename-bar').classList.add('hidden');
  $('session-trigger').classList.remove('hidden');
  $('rename-error').classList.add('hidden');
  if (renameErrorTimer) { clearTimeout(renameErrorTimer); renameErrorTimer = null; }
  updateNewBtn(); // 恢复新建按钮态（空会话/无消息时保持置灰）
}

async function saveRename() {
  const id = renameSessionId;
  const entry = state.sessions.find((s) => s.id === id);
  if (!id || !entry) { exitRename(); return; } // 编辑期间会话被移除（隔离/删除）：安全退出
  const title = $('rename-input').value.trim();
  // 本地校验：与后端口径一致，不达标不发请求
  if (!title) { showRenameError('标题不能为空'); return; }
  if (title.length > 60) { showRenameError('标题过长（最多 60 字）'); return; }
  const res = await api(`/api/sessions/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    showRenameError(res.error ?? '重命名失败'); // 显示后端 error，不退出编辑态
    return;
  }
  entry.title = res.title ?? title; // 以服务端返回为准（trim 后）
  renderSessionList();              // 重渲染：目标为当前会话则触发器/列表同步新标题；非当前会话只更新其条目
  exitRename();
}

// 空白态发消息时自动创建第一个会话：skipSummary 跳过快照（快照由首次发消息时 syncMainContext 补建）。
// 成功则 currentId 已指向新会话（openSession 立即进入，历史异步加载）；失败则 currentId 保持空，调用方不发送。
async function ensureSessionForSend() {
  if (state.creating) return; // 创建锁：newSession 或本函数重入时直接返回
  state.creating = true;
  const btn = $('btn-send');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在创建会话…';
  try {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ skipSummary: true }), timeout: 90000 });
    if (!res.ok) {
      addMsg('sys', res.error ?? '自动创建会话失败');
      return;
    }
    state.sessions = [res.session, ...state.sessions.filter((s) => s.id !== res.session.id)];
    renderSessionList();
    openSession(res.session.id); // 进入（历史异步加载，不阻塞发送）
  } finally {
    state.creating = false;
    btn.textContent = original;
    btn.disabled = false;
  }
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.busy) return;
  // 点＋正在创建（快照耗时）：提示并保留输入，避免 Enter 重入被静默吞掉（M1/M2）
  if (state.creating) {
    addMsg('sys', '正在创建会话，请稍候再发送');
    return;
  }
  // 空白态自动创建：无会话时先创建第一个会话，消息进入该会话（产品语义）
  if (!state.currentId) {
    await ensureSessionForSend();
    if (!state.currentId) return; // 创建失败：不发送
  }
  const sid = state.currentId;
  state.busy = true;
  $('btn-send').disabled = true;
  addMsg('user', text);
  input.value = '';
  const res = await api(`/api/sessions/${encodeURIComponent(sid)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    // 发送失败（如 session_busy）：提示后立即恢复，不进入轮询，避免锁死 120 秒
    addMsg('sys', res.error ?? '发送失败');
    state.busy = false;
    $('btn-send').disabled = false;
    return;
  }
  renderMainBar(res.mainStats);
  if (res.mainStats?.pending) {
    addMsg('sys', '提示：主对话正在回复中，参考上下文可能不完整，稍候会自动同步~');
  }
  // 拉取回复（轮询直至出现新助手消息）
  await pollReply(sid);
  // 发过消息即视为会话有内容，恢复「新建」按钮（若期间未切换会话）
  if (state.currentId === sid) {
    state.currentHasMessages = true;
    updateNewBtn();
  }
  state.busy = false;
  $('btn-send').disabled = false;
}

async function pollReply(sessionId) {
  // 快照发起时的会话 id：轮询期间切换会话立即中止，避免把别的会话消息渲染进当前视图
  const startedId = sessionId;
  // 思考中占位：最后一条不是 assistant（刚发完消息、回复尚未落盘）时先显示「思考中」
  let placeholder = null;
  const lastEl0 = $('messages').lastElementChild;
  if (!lastEl0 || !lastEl0.classList.contains('assistant')) {
    placeholder = document.createElement('div');
    placeholder.className = 'msg sys thinking';
    placeholder.textContent = '思考中';
    $('messages').appendChild(placeholder);
  }
  let lastText = '';
  let stableRounds = 0;
  // 起始基线：记录轮询开始时历史最后一条消息的签名，作为「新内容」判定基准。
  // 修复 H1：会话已有历史（末条为旧 assistant）时，旧 assistant 与视图最后一块相同、
  // 会被误当作「稳定」累计，导致新回复落盘前就 return。先取一次基线，只有出现与基线
  // 不同的 assistant 才数稳定轮。
  let baselineSig = null;
  {
    const r0 = await api(`/api/sessions/${encodeURIComponent(startedId)}`);
    if (r0.ok) {
      const h0 = r0.history ?? [];
      const m0 = h0[h0.length - 1];
      baselineSig = m0 ? `${m0.role}|${m0.thinking ?? ''}|${m0.text ?? ''}` : '';
    }
  }
  // 轮询等待：块级流式（host 按「思考+文本」整块落盘，逐字流式插件拿不到）。
  // 第一个 assistant 块出现即渲染思考内容，正文增长则就地更新；连续无变化判定回复完成。
  for (let i = 0; i < 200; i++) {
    if (state.currentId !== startedId) return;
    await new Promise((r) => setTimeout(r, 800));
    const res = await api(`/api/sessions/${encodeURIComponent(startedId)}`);
    if (!res.ok) continue;
    const msgs = res.history ?? [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant' && ((last.text ?? '').trim() || (last.thinking ?? '').trim())) {
      const think = last.thinking ?? '';
      const text = last.text ?? '';
      // 与起始相同：仍是发送前已有的旧 assistant，不是本次回复，跳过（不渲染、不数稳定）
      if (baselineSig !== null && `assistant|${think}|${text}` === baselineSig) continue;
      if (placeholder) { placeholder.remove(); placeholder = null; }
      const cur = $('messages').lastElementChild;
      if (cur && cur.classList.contains('assistant') && cur.dataset.think === think) {
        // 同一块：正文有增长则就地更新（不重复追加）
        if (cur.dataset.seen !== text) updateAssistantMsg(cur, { thinking: think, text });
      } else {
        // 新块（思考不同或上一块不是 assistant）：追加
        addAssistantMsg({ thinking: think, text });
      }
      if (text.trim()) {
        stableRounds = lastText === text ? stableRounds + 1 : 0;
        lastText = text;
        if (stableRounds >= 3) return; // 连续 3 轮（约 2.4s）无增长：回复已完成
      }
    }
  }
}

// ---------- 设置面板 ----------

function fillSettings() {
  const cfg = state.config;
  if (!cfg) return;
  $('set-context-mode').value = cfg.contextMode;
  $('set-window').value = cfg.windowSize;
  $('set-thinking').checked = !!cfg.includeThinking;
  $('set-self-prompt').value = cfg.selfPrompt ?? ''; // 回显自我意识提示词（后端可能缺省，?? '' 兜底）
  $('wrap-window').style.display = cfg.contextMode === 'windowed' ? 'block' : 'none';
}

async function saveSettings() {
  const body = {
    contextMode: $('set-context-mode').value,
    windowSize: Number($('set-window').value) || 30,
    includeThinking: $('set-thinking').checked,
    selfPrompt: $('set-self-prompt').value.trim(), // 本地 trim 后提交，空串=恢复内置默认
  };
  const res = await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    // REVIEW3 M8：保存失败显式提示（原静默丢弃，配合 H1 时用户反复编辑无效无感知）
    showSettingsError(res.error ?? '设置保存失败');
    return false;
  }
  state.config = res.config;
  // 设置变更后重新拉主对话信息（mode/windowSize 影响指示条文案）；
  // 旧实现 renderMainBar(null) 会把指示条误显示为「主对话：未找到」
  await refreshMain();
  return true;
}

// 设置面板内错误提示（REVIEW3 M8）：红字 3 秒自动消失；saveSettings 失败时同时阻止面板关闭
function showSettingsError(msg) {
  let err = $('settings-error');
  if (!err) {
    err = document.createElement('div');
    err.id = 'settings-error';
    err.className = 'settings-error';
    $('settings-panel').appendChild(err);
  }
  err.textContent = msg;
  err.classList.remove('hidden');
  clearTimeout(showSettingsError._t);
  showSettingsError._t = setTimeout(() => err.classList.add('hidden'), 3000);
}

// ---------- 模型供应商（独立配置，直连 API 架构，v32） ----------

// 拉取供应商配置（脱敏）并刷新设置面板区块 + 模型切换下拉。
// 不 await：loadState 路径 fire-and-forget，失败只留空态不阻塞主流程。
async function renderProviders() {
  const res = await api('/api/providers');
  if (res.ok) {
    state.providers = res.providers ?? [];
    state.defaultProviderId = res.defaultProviderId ?? '';
    state.defaultModel = res.defaultModel ?? '';
  }
  renderProviderArea();
  renderModelSelect();
}

// 发消息框旁模型切换下拉：当前默认供应商的模型列表，切换即保存（立即生效）
function renderModelSelect() {
  const sel = $('model-select');
  sel.innerHTML = '';
  const provider = state.providers.find((p) => p.id === state.defaultProviderId && p.enabled) ?? null;
  const models = provider ? (provider.models ?? []) : [];
  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = provider ? '（该供应商暂无模型，请到设置添加）' : '（未配置模型，请到设置）';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  let found = false;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    if (m.id === state.defaultModel) { opt.selected = true; found = true; }
    sel.appendChild(opt);
  }
  if (!found) {
    // 默认模型不在当前列表（如刚切换默认供应商）：选中第一个并同步本地状态
    sel.selectedIndex = 0;
    state.defaultModel = models[0].id;
  }
}

// 保存默认供应商/模型（POST 轻量接口，模型切换下拉与设置面板默认选择共用）
async function saveDefault(providerId, modelId) {
  const res = await api('/api/providers/default', {
    method: 'POST',
    body: JSON.stringify({ defaultProviderId: providerId, defaultModel: modelId }),
  });
  if (res.ok) {
    state.defaultProviderId = providerId;
    state.defaultModel = modelId;
    return true;
  }
  addMsg('sys', res.error ?? '默认选择保存失败');
  return false;
}

// 整体保存 providers（PUT）：脱敏数据去掉 apiKey/hasKey 字段再提交，
// 后端对「缺省 apiKey 字段」的条目保留原密钥（详见 provider-store.saveProviders）
function stripForPut(p) {
  const { hasKey, apiKey, ...rest } = p;
  return rest;
}

// 模型列表文本 ⇄ 数组：每行一个模型 id，可带「|显示名」
function parseModels(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
    const i = line.indexOf('|');
    const id = (i > 0 ? line.slice(0, i) : line).trim();
    const name = (i > 0 ? line.slice(i + 1) : line).trim();
    return { id, name: name || id, params: {} };
  });
}

// 自定义供应商 id 生成（字符集符合后端 [A-Za-z0-9_-] 校验）
function genProviderId() {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// 设置面板：供应商管理区（列表卡片 + 编辑表单 + 测试连接 + 默认选择 + 添加）
function renderProviderArea() {
  const area = $('provider-area');
  area.innerHTML = '';
  area.appendChild(renderDefaultRow());
  if (!state.providers.length) {
    const empty = document.createElement('p');
    empty.className = 'provider-empty';
    empty.textContent = '尚未配置供应商。可从下方预置模板添加，或「从主设置一键导入」。';
    area.appendChild(empty);
  }
  for (const p of state.providers) area.appendChild(providerCard(p));
  area.appendChild(renderAddRow());
}

// 默认供应商/模型选择行
function renderDefaultRow() {
  const row = document.createElement('div');
  row.className = 'provider-defaults';
  const lbl = document.createElement('span');
  lbl.textContent = '默认供应商/模型：';
  const ps = document.createElement('select');
  ps.id = 'set-default-provider';
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = '（自动：第一个可用）';
  ps.appendChild(autoOpt);
  for (const p of state.providers) {
    if (!p.enabled) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    if (p.id === state.defaultProviderId) opt.selected = true;
    ps.appendChild(opt);
  }
  const ms = document.createElement('select');
  ms.id = 'set-default-model';
  const persist = () => saveDefault(ps.value, ms.value);
  ps.onchange = () => { fillDefaultModel(ps, ms); persist(); };
  ms.onchange = persist;
  fillDefaultModel(ps, ms);
  row.appendChild(lbl);
  row.appendChild(ps);
  row.appendChild(ms);
  return row;
}

// 填充默认模型下拉（跟随所选供应商的模型列表）
function fillDefaultModel(ps, ms) {
  const pid = ps.value;
  const p = state.providers.find((x) => x.id === pid);
  const models = p?.enabled ? (p.models ?? []) : [];
  ms.innerHTML = '';
  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（无模型）';
    ms.appendChild(opt);
    ms.disabled = true;
    return;
  }
  ms.disabled = false;
  let found = false;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    if (pid === state.defaultProviderId && m.id === state.defaultModel) { opt.selected = true; found = true; }
    ms.appendChild(opt);
  }
  if (!found) ms.selectedIndex = 0;
}

// 单个供应商卡片：名称 / Base URL / API 密钥（密码遮罩）/ 模型列表 / 测试连接 / 保存 / 删除
function providerCard(p) {
  const card = document.createElement('div');
  card.className = 'provider-item';

  const head = document.createElement('div');
  head.className = 'provider-head';
  const nameInput = document.createElement('input');
  nameInput.className = 'provider-name';
  nameInput.value = p.name;
  nameInput.placeholder = '供应商名称';
  head.appendChild(nameInput);
  if (p.builtin) {
    const tag = document.createElement('span');
    tag.className = 'provider-tag';
    tag.textContent = '模板';
    head.appendChild(tag);
  }
  const delBtn = document.createElement('button');
  delBtn.className = 'provider-del';
  delBtn.textContent = '删除';
  head.appendChild(delBtn);
  card.appendChild(head);

  const urlInput = field(card, 'Base URL', p.baseUrl, 'https://api.example.com/v1');
  const keyInput = field(card, 'API 密钥（仅存本机）', '', p.hasKey ? '密钥已保存，留空保持不变' : 'sk-…（可选）');
  keyInput.type = 'password';

  const ml = document.createElement('label');
  const mlText = document.createElement('span');
  mlText.textContent = '模型列表（每行一个，可带 |显示名）';
  ml.appendChild(mlText);
  const modelsInput = document.createElement('textarea');
  modelsInput.className = 'provider-models';
  modelsInput.rows = 3;
  modelsInput.value = (p.models ?? []).map((m) => (m.name && m.name !== m.id ? `${m.id}|${m.name}` : m.id)).join('\n');
  ml.appendChild(modelsInput);
  card.appendChild(ml);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const testBtn = document.createElement('button');
  testBtn.textContent = '测试连接';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.textContent = '保存';
  const result = document.createElement('span');
  result.className = 'provider-test-result';
  actions.appendChild(testBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(result);
  card.appendChild(actions);

  // 测试连接：优先用输入框里的 key；留空且有已保存 key 时由后端按 providerId 取原 key
  testBtn.onclick = async () => {
    const baseUrl = urlInput.value.trim();
    if (!baseUrl) {
      result.textContent = '请先填写 Base URL';
      result.className = 'provider-test-result fail';
      return;
    }
    result.textContent = '测试中…';
    result.className = 'provider-test-result';
    // 红队 P2-22：重入锁——测试中禁用按钮，防并发外呼（同一卡片可连点）
    testBtn.disabled = true;
    const body = { baseUrl, providerId: p.id };
    if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
    let res;
    try {
      res = await api('/api/providers/test', { method: 'POST', body: JSON.stringify(body) });
    } finally {
      testBtn.disabled = false;
    }
    if (res.ok) {
      // 拉取到的真实模型列表自动并入模型输入框（去重，保留用户自填项），
      // 保存后模型切换下拉即可用全部模型（模板写死列表的局限由此解除）
      const fetched = Array.isArray(res.models) ? res.models : [];
      if (fetched.length) {
        const existing = new Set(
          modelsInput.value.split('\n').map((s) => s.trim().split('|')[0]).filter(Boolean)
        );
        const added = fetched.filter((id) => !existing.has(id));
        if (added.length) {
          modelsInput.value = [modelsInput.value.trim(), ...added].filter(Boolean).join('\n');
          result.textContent = `✓ 连接成功（${res.status}，共 ${fetched.length} 个模型，新增 ${added.length} 个已并入列表，保存后生效）`;
        } else {
          result.textContent = `✓ 连接成功（${res.status}，模型列表已是最新，${fetched.length} 个模型可用）`;
        }
      } else {
        result.textContent = `✓ 连接成功（${res.status}，但未拉到模型列表，可手动填写）`;
      }
      result.className = 'provider-test-result ok';
    } else {
      result.textContent = `✗ ${res.error ?? '连接失败'}`;
      result.className = 'provider-test-result fail';
    }
  };

  // 保存：整体 PUT（未修改的条目去掉 apiKey 字段 → 后端保留原密钥）
  saveBtn.onclick = async () => {
    const body = {
      id: p.id,
      name: nameInput.value.trim() || p.id,
      baseUrl: urlInput.value.trim(),
      models: parseModels(modelsInput.value),
      builtin: p.builtin,
      enabled: p.enabled,
      protocol: p.protocol,
    };
    // 密钥：已有 key 且输入框留空 → 不传（后端保留）；否则传输入值（空串=清空）
    if (!(p.hasKey && !keyInput.value.trim())) body.apiKey = keyInput.value;
    const next = state.providers.map((x) => (x.id === p.id ? body : stripForPut(x)));
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    const res = await api('/api/providers', {
      method: 'PUT',
      body: JSON.stringify({ providers: next, defaultProviderId: state.defaultProviderId, defaultModel: state.defaultModel }),
    });
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
    if (!res.ok) {
      result.textContent = `✗ ${res.error ?? '保存失败'}`;
      result.className = 'provider-test-result fail';
      return;
    }
    state.providers = res.providers ?? next; // 后端返回脱敏结果（hasKey 同步更新）
    result.textContent = '✓ 已保存';
    result.className = 'provider-test-result ok';
    renderProviderArea();
    renderModelSelect();
  };

  // 删除：从列表移除后整体 PUT
  delBtn.onclick = async () => {
    const next = state.providers.filter((x) => x.id !== p.id);
    const res = await api('/api/providers', {
      method: 'PUT',
      body: JSON.stringify({ providers: next.map(stripForPut), defaultProviderId: state.defaultProviderId, defaultModel: state.defaultModel }),
    });
    if (!res.ok) {
      addMsg('sys', res.error ?? '删除失败');
      return;
    }
    state.providers = res.providers ?? next;
    renderProviderArea();
    renderModelSelect();
  };

  return card;
}

// 表单字段行（label + input）
function field(card, labelText, value, placeholder) {
  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.value = value;
  input.placeholder = placeholder;
  label.appendChild(span);
  label.appendChild(input);
  card.appendChild(label);
  return input;
}

// 添加供应商行：模板下拉（异步填充）+ 一键导入 + 添加按钮
function renderAddRow() {
  const row = document.createElement('div');
  row.className = 'provider-add';
  const sel = document.createElement('select');
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '自定义供应商…';
  sel.appendChild(customOpt);
  const loading = document.createElement('option');
  loading.value = '';
  loading.textContent = '（模板加载中…）';
  sel.appendChild(loading);
  sel.disabled = true;
  const addBtn = document.createElement('button');
  addBtn.textContent = '添加';
  addBtn.disabled = true;
  const importBtn = document.createElement('button');
  importBtn.textContent = '从主设置一键导入';
  row.appendChild(sel);
  row.appendChild(addBtn);
  row.appendChild(importBtn);
  // 模板清单（后端预置）
  api('/api/providers/templates').then((res) => {
    const tpls = res.ok ? (res.templates ?? []) : [];
    const oldValue = sel.value;
    sel.innerHTML = '';
    sel.appendChild(customOpt);
    for (const t of tpls) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name}（${t.id}）`;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    addBtn.disabled = false;
    // 恢复用户已选值（模板加载慢时可能已选择）；异常环境（如测试 stub 无 options）跳过
    try {
      if ([...sel.options].some((o) => o.value === oldValue)) sel.value = oldValue;
    } catch { /* 忽略 */ }
  });
  addBtn.onclick = async () => {
    if (sel.value === '__custom__') {
      await addProviderToState({ id: genProviderId(), name: '新供应商', baseUrl: '', apiKey: '', builtin: false, protocol: 'openai', enabled: true, models: [] });
      return;
    }
    const tpls = await api('/api/providers/templates').then((r) => (r.ok ? (r.templates ?? []) : []));
    const tpl = tpls.find((t) => t.id === sel.value);
    if (!tpl) return;
    await addProviderToState({
      id: tpl.id,
      name: tpl.name,
      baseUrl: tpl.baseUrl,
      apiKey: '',
      builtin: true,
      protocol: tpl.protocol,
      enabled: true,
      models: (tpl.models ?? []).map((m) => ({ id: m.id, name: m.name || m.id, params: {} })),
    });
  };
  importBtn.onclick = async () => {
    const r = await api('/api/providers/import', { method: 'POST', body: JSON.stringify({}) });
    if (!r.ok) {
      addMsg('sys', r.error ?? '导入失败');
      return;
    }
    if (!(r.imported ?? []).length) {
      addMsg('sys', r.note ?? '没有可导入的新供应商');
    }
    renderProviders();
  };
  return row;
}

// 把新供应商追加进列表并整体保存（模板/自定义添加共用）
async function addProviderToState(newProvider) {
  if (state.providers.some((x) => x.id === newProvider.id)) {
    addMsg('sys', `供应商 ${newProvider.id} 已存在`);
    return;
  }
  const next = [...state.providers, newProvider];
  const res = await api('/api/providers', {
    method: 'PUT',
    body: JSON.stringify({
      providers: next.map(stripForPut),
      defaultProviderId: state.defaultProviderId || newProvider.id,
      defaultModel: state.defaultModel,
    }),
  });
  if (!res.ok) {
    addMsg('sys', res.error ?? '添加失败');
    return;
  }
  state.providers = res.providers ?? next;
  if (!state.defaultProviderId) state.defaultProviderId = newProvider.id;
  renderProviderArea();
  renderModelSelect();
}

// ---------- 主对话内容选择器（T6） ----------

async function loadRounds() {
  const res = await api('/api/main-rounds?limit=20');
  const list = $('rounds-list');
  list.innerHTML = '';
  if (!res.ok) {
    list.textContent = res.error ?? '无法加载';
    return;
  }
  if (!res.rounds.length) {
    list.textContent = '（主对话暂无内容）';
    return;
  }
  for (const r of res.rounds) {
    const item = document.createElement('div');
    item.className = 'round-item';
    const head = document.createElement('div');
    head.className = 'round-head';
    const num = document.createElement('span');
    num.textContent = `第 ${r.n} 轮`;
    head.appendChild(num);
    const btn = document.createElement('button');
    btn.className = 'round-quote';
    btn.textContent = '引入';
    btn.onclick = () => quoteRound(r);
    head.appendChild(btn);
    item.appendChild(head);
    const body = document.createElement('div');
    body.className = 'round-body';
    const parts = [`您：${r.user || '（无）'}`];
    if (r.thinking) parts.push(`助手思考：${r.thinking}`);
    if (r.assistant) parts.push(`助手：${r.assistant}`);
    body.textContent = parts.join('\n\n');
    item.appendChild(body);
    list.appendChild(item);
  }
}

function quoteRound(r) {
  const input = $('input');
  const lines = [`> 第 ${r.n} 轮（来自主对话）：`];
  if (r.user) lines.push(`> 您：${r.user}`);
  if (r.assistant) lines.push(`> 助手：${r.assistant}`);
  const quote = lines.join('\n');
  input.value = input.value ? `${input.value}\n${quote}\n` : `${quote}\n`;
  $('preview-panel').classList.add('hidden');
  input.focus();
}

async function showFullPreview() {
  const res = await api('/api/main-preview');
  $('preview-text').textContent = res.ok ? res.preview : (res.error ?? '无法加载');
  $('rounds-list').classList.add('hidden');
  $('preview-text').classList.remove('hidden');
  $('btn-full-preview').classList.add('hidden');
  $('btn-back-list').classList.remove('hidden');
}

function showRoundList() {
  $('preview-text').classList.add('hidden');
  $('rounds-list').classList.remove('hidden');
  $('btn-full-preview').classList.remove('hidden');
  $('btn-back-list').classList.add('hidden');
}

// ---------- 事件绑定 ----------

// ---------- 会话右键菜单 ----------
// 右键触发器（目标=当前会话）或列表项（目标=该项会话 id，无需先选中）弹出「重命名/删除」两项。
// 操作目标快照存 ctxMenuTargetId；菜单内两态删除：点「🗑 删除」菜单不关闭、原地变「确认删除？」，
// 3 秒内再点真删，超时自动复原；菜单每次打开时重置删除项（不带历史 armed 显示残留）。
// 无会话 / 重命名编辑态不弹；点击菜单外 / Esc / 会话切换 / 再次右键 / 列表收起 → 关闭。
const ctxMenu = $('ctx-menu');
const ctxMenuDel = $('ctx-menu-del');
let ctxMenuTargetId = null; // 菜单当前操作目标会话 id（打开时快照，关闭时清空）

// 可弹出条件：非编辑态且目标 id 在会话列表中有效（无会话时触发器右键不弹）
function canOpenCtxMenu(targetId) {
  if (renameSessionId !== null) return false; // 编辑态锁
  return targetId != null && state.sessions.some((s) => s.id === targetId);
}

function openCtxMenu(x, y, targetId) {
  ctxMenuTargetId = targetId;
  // REVIEW3 M9：彻底重置该目标的 3 秒确认窗口（放弃残留 armed）——
  // 否则「菜单关闭后 3 秒内重开」时显示「🗑 删除」实际点击却直接真删，两态被绕过
  disarmDel(targetId);
  // 菜单每次打开重置删除项为「🗑 删除」（armDel/disarmDel 的 renderCtxMenuDel 也会同步）
  ctxMenuDel.textContent = '🗑 删除';
  ctxMenuDel.classList.remove('armed');
  ctxMenu.classList.remove('hidden');
  // 先显示再量尺寸：超出视口（面板）时自动收拢进可视区，四周留 4px 边距
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 4)) + 'px';
}

function closeCtxMenu() {
  ctxMenu.classList.add('hidden');
  ctxMenuTargetId = null;
}

// 菜单删除项显示与目标 id 的 armed 状态同步（armDel/disarmDel 调用；菜单关闭时无效果）
function renderCtxMenuDel() {
  if (ctxMenuTargetId == null) return;
  const armed = delArmed.has(ctxMenuTargetId);
  ctxMenuDel.textContent = armed ? '确认删除？' : '🗑 删除';
  ctxMenuDel.classList.toggle('armed', armed);
}

// 右键触发器：目标=当前会话；无会话 / 编辑态不弹
$('session-trigger').addEventListener('contextmenu', (e) => {
  e.preventDefault();               // 防浏览器原生菜单
  closeCtxMenu();                   // 再次右键：先关旧菜单
  if (!canOpenCtxMenu(state.currentId)) return; // 无会话 / 编辑态：不弹
  openCtxMenu(e.clientX, e.clientY, state.currentId);
});
// 菜单打开期间：任何位置的右键都拦截原生菜单（捕获阶段先于上面冒泡处理器执行）
document.addEventListener('contextmenu', (e) => {
  if (!ctxMenu.classList.contains('hidden')) e.preventDefault();
}, true);
// 点击菜单外关闭菜单；点击列表外（触发器/列表/菜单之外）收起列表
document.addEventListener('click', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) closeCtxMenu();
  const list = $('session-list');
  if (!list.classList.contains('hidden') &&
      !list.contains(e.target) &&
      e.target !== $('session-trigger') &&
      !ctxMenu.contains(e.target)) {
    closeSessionList();
  }
});
// Esc：关闭菜单 + 收起列表（编辑态中菜单/列表均不出现，与 rename-input 的 Esc 退出编辑互不干扰）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCtxMenu(); closeSessionList(); }
});
// 重命名：关闭菜单 + 收起列表 + 对目标 id 进入编辑态
$('ctx-menu-rename').onclick = () => {
  const id = ctxMenuTargetId;
  closeCtxMenu();
  closeSessionList();
  startRename(id); // 菜单弹出时已校验目标有效，startRename 内部再防御
};
// 删除：菜单不关闭、保持原地，两态确认在菜单项内进行（首次点击 arm，3 秒内再点真删）
$('ctx-menu-del').onclick = () => {
  if (ctxMenuTargetId == null) return;
  delSession(ctxMenuTargetId);
};

$('session-trigger').onclick = toggleSessionList;
$('btn-new').onclick = newSession;
$('btn-send').onclick = send;
$('btn-rename-ok').onclick = saveRename;
$('btn-rename-cancel').onclick = exitRename;
$('rename-input').addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 输入法选词中的 Enter 不触发保存
  if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
  else if (e.key === 'Escape') { e.preventDefault(); exitRename(); }
});
$('rename-input').addEventListener('blur', (e) => {
  // 点击 ✓/✕：焦点目标在编辑条内，交给对应 click 处理，这里不动
  if (e.relatedTarget && $('rename-bar').contains(e.relatedTarget)) return;
  // 失焦且无改动：退出编辑态不保存；有改动：保留编辑态（防误触丢输入）
  if ($('rename-input').value === renameOriginal) exitRename();
});
$('input').addEventListener('keydown', (e) => {
  if (e.isComposing) return; // REVIEW3 M7：输入法选词中的 Enter 不触发发送（对齐 rename-input）
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('btn-settings').onclick = () => {
  $('settings-panel').classList.remove('hidden');
  renderProviders(); // 打开设置时刷新供应商配置（含模型下拉）
};
// 发消息框旁模型切换：切换即保存默认模型（立即生效，下一里程碑直连发送直接读取）
$('model-select').onchange = () => {
  if ($('model-select').disabled) return;
  const mid = $('model-select').value;
  const provider = state.providers.find((p) => p.id === state.defaultProviderId && p.enabled);
  if (!provider || !mid) return;
  saveDefault(provider.id, mid);
};
$('btn-close-settings').onclick = async () => {
  // REVIEW3 M8：保存失败不关面板（用户看到错误提示后修正）；成功才关闭
  const ok = await saveSettings();
  if (ok) $('settings-panel').classList.add('hidden');
};
$('btn-diag').onclick = async () => {
  const out = $('diag-output');
  out.textContent = '诊断中…';
  out.classList.remove('hidden');
  const res = await api('/api/diagnostics');
  out.textContent = res.ok
    ? formatDiagnostics(res)
    : `诊断接口失败：${res.error ?? '未知错误'}\n（token=${TOKEN ? '有' : '无'}，agentId=${AGENT_ID || '无'}）`;
};
$('mainbar').onclick = async () => {
  $('preview-panel').classList.remove('hidden');
  showRoundList();
  await loadRounds();
};
// 绑定提示条：整条可点击切换；按钮同样触发切换（stopPropagation 防重复请求）
$('bind-hint').onclick = bindToCurrent;
$('btn-bind-switch').onclick = (e) => {
  e.stopPropagation();
  bindToCurrent();
};
$('btn-full-preview').onclick = showFullPreview;
$('btn-back-list').onclick = showRoundList;
$('btn-close-preview').onclick = () => $('preview-panel').classList.add('hidden');
$('set-context-mode').onchange = () => $('wrap-window').style.display = $('set-context-mode').value === 'windowed' ? 'block' : 'none';

// 主对话切换激活触发：窗口重新聚焦/重新可见时立即重定位主会话
// （防抖在 relocateMain 内部：focus 与 visibilitychange 常成对触发，5 秒内只执行一次）
window.addEventListener('focus', relocateMain);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) relocateMain();
});

// ---------- 启动 ----------

(async function init() {
  // [page-ext] 页面模式扩展入口：SURFACE==='page' 时未来在此挂载大界面功能（信息整理/写作分析）
  // 当前页面与侧栏共用同一逻辑，外观与行为不变
  await loadState();
  if (state.sessions.length) await openSession(state.sessions[0].id);
  // 主对话实时同步：SSE 长连接（主对话有新消息/回复完成即刷新）
  connectMainEvents();
  // 兜底轮询：SSE 失效时仍能定期刷新状态（每轮调 pollStateOnce）
  // 周期重定位：每第 4 轮（约 20 秒）先 relocateMain 纠正主会话定位，再走正常轮询。
  // relocate 发生切换时会自带一轮刷新，返回 true 则本轮跳过正常轮询（避免重复刷新）。
  let pollCount = 0;
  timer = setInterval(async () => {
    pollCount++;
    if (pollCount % 4 === 0) {
      if (await relocateMain()) return;
    }
    await pollStateOnce();
  }, 5000);
})();
