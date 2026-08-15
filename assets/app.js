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

let state = { sessions: [], config: null, currentId: null, busy: false, currentHasMessages: false };
let timer = null;

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const extra = [];
  if (TOKEN) extra.push(`token=${encodeURIComponent(TOKEN)}`);
  if (AGENT_ID) extra.push(`agentId=${encodeURIComponent(AGENT_ID)}`);
  const url = API_BASE + path + (extra.length ? `${sep}${extra.join('&')}` : '');
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch (e) {
    return { ok: false, error: `网络错误：${e?.message ?? e}` };
  }
  try {
    return await res.json();
  } catch {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}${body ? `：${body.slice(0, 300)}` : ''}` };
  }
}

// 加载阶段错误可见化：面板打开即失败时，拉取诊断信息并渲染为清单（，学 DSHana 诊断思路）
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
  lines.push(`主会话定位：${ms?.found ? `✓ ${ms.rounds} 轮（${ms.viaApi ? '官方通道' : '文件兑底'}${ms.pending ? '，回复中' : ''}）` : `✗ ${ms?.error ?? '未找到'}（主对话暂无内容或 agents 目录异常）`}`);
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

function renderSessionSelect() {
  const sel = $('session-select');
  sel.innerHTML = '';
  for (const s of state.sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    if (s.id === state.currentId) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!state.sessions.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（暂无会话，点 ＋ 新建）';
    sel.appendChild(opt);
  }
}

// 统一刷新「新建会话」按钮态：
// - 无任何会话：允许建第一个；
// - 当前选中会话为空对话（0 条消息）：置灰，防止连点产生空壳会话；
// - 当前选中会话有内容：允许新建。
function updateNewBtn() {
  const btn = $('btn-new');
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
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
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
  const base = `主对话：${rounds} 轮 · ${mode === 'full' ? '全量' : `最近 ${state.config?.windowSize ?? 30} 轮+摘要`}`;
  label.textContent = pending ? `${base}（正在回复中…）` : base;
}

// 轻量刷新主对话指示（SSE 收到事件或轮询兜底时调用）
async function refreshMain() {
  const res = await api('/api/state');
  if (!res.ok) return;
  if (res.config) state.config = res.config;
  if (res.main) renderMainBar(res.main);
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
      if (msg.type === 'main-changed') refreshMain();
    } catch { /* 忽略非 JSON 心跳 */ }
  };
  // EventSource 断线会自动重连，无需手动处理
  es.onerror = () => { /* 交给 EventSource 自身重连 */ };
}

async function loadState() {
  const res = await api('/api/state');
  if (!res.ok) {
    showFatal(res.error ?? '未知错误');
    return;
  }
  state.config = res.config;
  state.sessions = res.sessions ?? [];
  renderMainBar(res.main);
  renderSessionSelect();
  fillSettings();
  renderProviders();
  updateNewBtn();
}

async function openSession(id) {
  state.currentId = id;
  state.currentHasMessages = false;
  $('messages').innerHTML = '';
  if (!id) {
    updateNewBtn();
    return;
  }
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) {
    addMsg('sys', res.error ?? '加载失败');
    updateNewBtn();
    return;
  }
  const history = res.history ?? [];
  state.currentHasMessages = history.length > 0;
  let lastAssistantText = null;
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      addMsg(m.role, m.text ?? '');
      if (m.role === 'assistant') lastAssistantText = m.text ?? '';
    }
  }
  // 给最后一条 assistant 节点标 seen，避免 pollReply 把旧回复当新回复重复渲染
  if (lastAssistantText) {
    const assistants = $('messages').querySelectorAll('.msg.assistant');
    const lastEl = assistants[assistants.length - 1];
    if (lastEl) lastEl.dataset.seen = lastAssistantText;
  }
  renderSessionSelect();
  updateNewBtn();
}

// ---------- 操作 ----------

async function newSession() {
  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
  if (!res.ok) {
    addMsg('sys', res.error ?? '新建失败');
    return;
  }
  state.sessions = [res.session, ...state.sessions];
  renderSessionSelect();
  await openSession(res.session.id);
}

async function delSession() {
  const id = state.currentId;
  if (!id) {
    addMsg('sys', '没有可删除的会话');
    return;
  }
  const entry = state.sessions.find((s) => s.id === id);
  const title = entry?.title ?? '当前会话';
  if (!window.confirm(`确定删除「${title}」？此操作不可恢复。`)) return;
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    addMsg('sys', res.error ?? '删除失败');
    return;
  }
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessions.length) {
    // 还有会话：自动打开列表第一个
    await openSession(state.sessions[0].id);
  } else {
    // 一个不剩：回到可建第一个的空态
    state.currentId = null;
    state.currentHasMessages = false;
    $('messages').innerHTML = '';
    renderSessionSelect();
    updateNewBtn();
  }
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.currentId || state.busy) return;
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
  for (let i = 0; i < 120; i++) {
    if (state.currentId !== startedId) return;
    await new Promise((r) => setTimeout(r, 1000));
    const res = await api(`/api/sessions/${encodeURIComponent(startedId)}`);
    if (!res.ok) continue;
    const msgs = res.history ?? [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant' && last.text) {
      // 检查是否已渲染（避免重复）
      const rendered = $('messages').lastElementChild;
      if (!rendered || rendered.dataset.seen !== last.text) {
        addMsg('assistant', last.text);
        const lastEl = $('messages').lastElementChild;
        lastEl.dataset.seen = last.text;
      }
      return;
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
  $('wrap-window').style.display = cfg.contextMode === 'windowed' ? 'block' : 'none';
}

async function saveSettings() {
  const body = {
    contextMode: $('set-context-mode').value,
    windowSize: Number($('set-window').value) || 30,
    includeThinking: $('set-thinking').checked,
  };
  const res = await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
  if (res.ok) state.config = res.config;
  renderMainBar(null);
}

async function renderProviders() {
  const area = $('provider-area');
  area.innerHTML = '';
  const ready = await api('/api/providers/ready');
  const imported = ready.imported ?? {};
  if (!Object.keys(imported).length) {
    const meta = await api('/api/providers');
    if (meta.ok && Object.keys(meta.providers).length) {
      const btn = document.createElement('button');
      btn.textContent = `从主设置一键导入供应商（${Object.keys(meta.providers).length} 个可用）`;
      btn.onclick = async () => {
        const r = await api('/api/providers/import', { method: 'POST', body: JSON.stringify({}) });
        if (r.ok) renderProviders();
      };
      area.appendChild(btn);
    } else {
      area.textContent = '未发现可导入的供应商。';
    }
    return;
  }
  for (const [pid, p] of Object.entries(imported)) {
    const item = document.createElement('div');
    item.className = 'provider-item';
    const h = document.createElement('h5');
    h.textContent = pid;
    item.appendChild(h);
    const models = p.models ?? [];
    if (models.length) {
      const sel = document.createElement('select');
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
      }
      item.appendChild(sel);
      const save = document.createElement('button');
      save.textContent = '设为辅助对话模型';
      save.onclick = async () => {
        await api('/api/settings', { method: 'POST', body: JSON.stringify({ model: `${pid}/${sel.value}` }) });
        save.textContent = '已设置 ✓';
      };
      item.appendChild(save);
    }
    area.appendChild(item);
  }
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

$('btn-new').onclick = newSession;
$('btn-del').onclick = delSession;
$('btn-send').onclick = send;
$('session-select').onchange = (e) => openSession(e.target.value);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('btn-settings').onclick = () => $('settings-panel').classList.remove('hidden');
$('btn-close-settings').onclick = () => {
  saveSettings();
  $('settings-panel').classList.add('hidden');
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
$('btn-full-preview').onclick = showFullPreview;
$('btn-back-list').onclick = showRoundList;
$('btn-close-preview').onclick = () => $('preview-panel').classList.add('hidden');
$('set-context-mode').onchange = () => $('wrap-window').style.display = $('set-context-mode').value === 'windowed' ? 'block' : 'none';

// ---------- 启动 ----------

(async function init() {
  await loadState();
  if (state.sessions.length) await openSession(state.sessions[0].id);
  // 主对话实时同步：SSE 长连接（主对话有新消息/回复完成即刷新）
  connectMainEvents();
  // 兜底轮询：SSE 失效时仍能定期刷新状态
  timer = setInterval(async () => {
    const res = await api('/api/state');
    if (res.ok) {
      renderMainBar(res.main);
      if (res.sessions?.length !== state.sessions.length) {
        state.sessions = res.sessions;
        renderSessionSelect();
      }
    }
  }, 5000);
})();
