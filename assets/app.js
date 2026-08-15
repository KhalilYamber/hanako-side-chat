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

let state = { sessions: [], config: null, currentId: null, busy: false };
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

// 加载阶段错误可见化：面板打开即失败时，把具体原因显示在消息区
function showFatal(error) {
  $('messages').innerHTML = '';
  const el = document.createElement('div');
  el.className = 'msg sys fatal';
  el.textContent = `⚠ 初始化失败：${error}\n\n（token=${TOKEN ? '有' : '无'}，agentId=${AGENT_ID || '无'}）`;
  $('messages').appendChild(el);
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
  dot.className = 'ok';
  const rounds = main.rounds ?? 0;
  const mode = main.mode ?? (state.config?.contextMode ?? 'windowed');
  label.textContent = `主对话：${rounds} 轮 · ${mode === 'full' ? '全量' : `最近 ${state.config?.windowSize ?? 30} 轮+摘要`}`;
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
}

async function openSession(id) {
  state.currentId = id;
  $('messages').innerHTML = '';
  if (!id) return;
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) {
    addMsg('sys', res.error ?? '加载失败');
    return;
  }
  for (const m of res.history ?? []) {
    if (m.role === 'user' || m.role === 'assistant') addMsg(m.role, m.text ?? '');
  }
  renderSessionSelect();
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
  state.currentId = null;
  $('messages').innerHTML = '';
  renderSessionSelect();
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.currentId || state.busy) return;
  state.busy = true;
  $('btn-send').disabled = true;
  addMsg('user', text);
  input.value = '';
  const res = await api(`/api/sessions/${encodeURIComponent(state.currentId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    addMsg('sys', res.error ?? '发送失败');
  } else {
    renderMainBar(res.mainStats);
  }
  // 拉取回复（轮询直至出现新助手消息）
  await pollReply(state.currentId, Date.now());
  state.busy = false;
  $('btn-send').disabled = false;
}

async function pollReply(sessionId, afterTs) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
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
  // 定时轻量刷新状态（新消息自动同步由后端发送时完成）
  timer = setInterval(async () => {
    const res = await api('/api/state');
    if (res.ok) {
      renderMainBar(res.main);
      if (res.sessions?.length !== state.sessions.length) {
        state.sessions = res.sessions;
        renderSessionSelect();
      }
    }
  }, 15000);
})();
