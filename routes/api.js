// routes/api.js —— SideChat 后端 API（官方通道版）
// 主会话读取：session:history（含 thinking）；人格：agent:profile；发消息：session:create/send。

import fs from 'node:fs';
import path from 'node:path';

// lib 模块懒加载：插件 reload 后 Node 对静态 import 的模块缓存不会失效，
// 会拿到 dev 第一次安装时的旧版本（已踩坑），故用带时间戳的动态 import。
let _lib = null;
async function loadLib() {
  return _lib ??= import(`../lib/main-context.js?t=${Date.now()}`);
}
let _store = null;
async function loadStore() {
  return _store ??= import(`../lib/store.js?t=${Date.now()}`);
}

export default function registerSideChatRoutes(app, ctx) {
  const pctx = ctx;

  // ---------- 状态 ----------

  app.get('/api/state', async (c) => {
    const cfg = await readConfig(pctx);
    const sessions = (await loadStore()).listSessions(pctx.dataDir, requestAgentId(c));
    // relocate=1：重定位模式（主对话切换纠正）。前端 lastMainPath 只被 SSE 消息事件更新，
    // 切主对话后若新主对话暂无消息会停留在旧值；relocate 让后端忽略 mainPath，
    // 改按「最近活跃 public 主会话（mtime）」重新定位，返回路径供前端更新追踪。
    const main = await mainSessionInfo(pctx, c, { relocate: c.req.query('relocate') === '1' });
    // 隔离过滤（树枝-树叶模型）：有当前主会话时按归属过滤，无效绑定标记 unbound 透给前端
    const visible = main?.sessionPath ? filterSessionsByMain(pctx, sessions, main.sessionPath) : sessions;
    return c.json({ ok: true, config: cfg, sessions: visible, main });
  });

  // ---------- 健康自检（，借鉴 DSHana 诊断思路） ----------

  app.get('/api/diagnostics', async (c) => {
    const agentId = requestAgentId(c);
    // 主会话定位（不摘要，轻量）
    let mainSession = { found: false, error: null };
    try {
      const info = await collectMainContext(pctx, c, await readConfig(pctx), { skipSummary: true });
      mainSession = info.ok
        ? { found: true, rounds: info.roundCount, viaApi: info.viaApi, pending: !!info.pending, file: info.sessionPath ? path.basename(info.sessionPath) : null }
        : { found: false, error: info.error ?? '未找到主会话' };
    } catch (e) {
      mainSession = { found: false, error: String(e?.message ?? e) };
    }
    // host 补丁状态（只读 bundle，最新版本目录）
    const home = path.dirname(path.dirname(pctx.pluginDir));
    const patchLib = await import(`../lib/patch-check.mjs?t=${Date.now()}`).catch(() => null);
    const hostPatch = patchLib ? patchLib.checkHostPatch(home) : { status: 'unknown', reason: 'patch-check 模块加载失败' };
    // 摘要缓存状态（当前 agent 分域）
    let cache = null;
    try {
      const lc = await loadLib();
      cache = lc.loadCache(pctx.dataDir, agentId);
      if (cache && typeof cache === 'object' && !Object.keys(cache).length) cache = null;
    } catch {
      cache = null;
    }
    const cfg = await readConfig(pctx);
    return c.json({
      ok: true,
      agentId: agentId || null,
      config: { contextMode: cfg.contextMode, windowSize: cfg.windowSize, includeThinking: cfg.includeThinking, model: cfg.model || null },
      mainSession,
      hostPatch,
      cache: cache
        ? { exists: true, lastRoundCount: cache.lastRoundCount ?? 0, mainSessionPath: cache.mainSessionPath ?? null, lastPending: !!cache.lastPending, hasSummary: !!(cache.summaryText ?? '') }
        : { exists: false },
    });
  });

  // ---------- 主对话实时同步（SSE） ----------

  app.get('/api/main-events', (c) => {
    const agentId = requestAgentId(c);
    const signal = c.req.raw?.signal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        let closed = false;
        const send = (payload) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            // 客户端已断开，忽略
          }
        };
        // 订阅主对话会话事件：用户新消息 / 助手回复完成即推送，前端据此实时刷新参考上下文。
        // 订阅是全局的（不按 sessionPath 过滤，主对话 agent 会切换），只透传事件类型与 sessionPath，不泄露正文。
        // subscribe 回调第二参数 = sessionPath（server 契约），前端据此追踪「最近活跃主会话」。
        // 【2026-08-16 修复】public 过滤：辅助会话（plugin_private）自身的事件也会进总线，
        // 若透传会让前端把辅助会话当成主会话（上下文自噬、列表错乱）。故只透传 public 主会话的事件。
        const publicSet = new Set();
        const refreshPublic = async (force) => {
          try {
            const paths = await getPublicSessionPaths(pctx, force);
            publicSet.clear();
            for (const p of paths) publicSet.add(p);
          } catch {
            // 忽略，保持旧集合
          }
        };
        // 先等缓存就绪再注册订阅，避免连接初期的真实事件被空集合误过滤
        await refreshPublic(true).catch(() => {});
        const publicTimer = setInterval(() => refreshPublic(false), 60000);
        let unsubscribe = () => {};
        try {
          unsubscribe = pctx.bus.subscribe((event, sessionPath) => {
            if (sessionPath && !publicSet.has(normSessionPath(sessionPath))) {
              return; // 非 public 主会话（辅助会话自身/其它）：不透传，避免污染
            }
            send({ type: 'main-changed', eventType: event?.type ?? null, sessionPath: sessionPath || null });
          }, { types: ['message_end', 'turn_end', 'session_user_message'] });
        } catch (e) {
          send({ type: 'error', message: String(e?.message ?? e) });
        }
        const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
        send({ type: 'ready', agentId });
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearInterval(publicTimer);
          try {
            unsubscribe();
          } catch {
            // 忽略
          }
          try {
            controller.close();
          } catch {
            // 忽略
          }
        };
        signal?.addEventListener('abort', cleanup, { once: true });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  // ---------- 会话管理 ----------

  app.post('/api/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let created = null;
    try {
      // 模型选择（测试）：设置里选的模型（provider/model）通过 session:create 的 model 参数绑定，
      // 实测生效（会话 model_change 记录正确）。绑定主对话 agent（人格由官方管道注入）。
      const cfg = await readConfig(pctx);
      const modelSpec = parseModelSpec(cfg.model);
      const res = await pctx.bus.request('session:create', {
        visibility: 'plugin_private',
        ownerPluginId: pctx.pluginId,
        kind: 'sidechat',
        cwd: pctx.dataDir,
        agentId: await resolveBoundAgent(pctx, c),
        ...(modelSpec ? { model: modelSpec } : {}),
      });
      const sessionId = res?.sessionId ?? res?.session?.id ?? res?.sessionRef?.sessionId ?? null;
      const sessionPath = res?.sessionPath ?? res?.session?.sessionPath ?? res?.sessionRef?.sessionPath ?? null;
      if (!sessionId || !sessionPath) {
        throw new Error(`session:create 返回结构不完整：${JSON.stringify(res).slice(0, 300)}`);
      }
      // 绑定主会话：创建时 resolveMainSessionPath 解析的「最近活跃主会话」路径（前端 SSE 追踪值优先）。
      // 解析失败/无主会话时为 null（未绑定，前端提示条不显示，行为与旧版一致）。
      let boundMain = null;
      try {
        boundMain = await resolveMainSessionPath(pctx, c);
      } catch {
        boundMain = null;
      }
      created = (await loadStore()).upsertSession(pctx.dataDir, {
        id: sessionId,
        sessionPath,
        // 绑定主会话：参考上下文来源路径（前端「绑定 ≠ 当前主会话」时提示一键切换）
        boundMain,
        // agent 级归属：记录创建时的主对话 agent，列表据此过滤（维护者域/空老师域各自独立）
        agentId: requestAgentId(c) || undefined,
        title: body.title || `辅助对话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (e) {
      return c.json({ ok: false, error: `创建会话失败：${e?.message ?? e}` });
    }
    return c.json({ ok: true, session: created });
  });

  app.get('/api/sessions', async (c) => {
    const sessions = (await loadStore()).listSessions(pctx.dataDir, requestAgentId(c));
    // 与 /api/state 一致：按当前主会话隔离过滤（mainSessionInfo 走 skipSummary，零 LLM）
    const main = await mainSessionInfo(pctx, c);
    const visible = main?.sessionPath ? filterSessionsByMain(pctx, sessions, main.sessionPath) : sessions;
    return c.json({ ok: true, sessions: visible });
  });

  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const entry = (await loadStore()).getSession(pctx.dataDir, id);
    if (!entry) return c.json({ ok: false, error: '会话不存在' });
    // 归属校验：会话属于其它主对话 agent 时不透出（互不串门）
    if (!isOwnedBy(entry, requestAgentId(c))) {
      return c.json({ ok: false, error: '会话不属于当前主对话' });
    }
    // 惰性归属：未绑定/绑定无效的旧数据，打开时自动绑定到当前主会话（用户无感）
    await lazyBindUnbound(pctx, c, entry);
    let history = [];
    try {
      const res = await pctx.bus.request('session:history', { sessionPath: entry.sessionPath, limit: 200 });
      history = normalizeHistory(res);
    } catch (e) {
      return c.json({ ok: false, error: `读取历史失败：${e?.message ?? e}` });
    }
    return c.json({ ok: true, session: entry, history });
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text ?? '').trim();
    if (!text) return c.json({ ok: false, error: '消息为空' });
    const entry = (await loadStore()).getSession(pctx.dataDir, id);
    if (!entry) return c.json({ ok: false, error: '会话不存在' });
    // 归属校验：会话属于其它主对话 agent 时不透出（互不串门）
    if (!isOwnedBy(entry, requestAgentId(c))) {
      return c.json({ ok: false, error: '会话不属于当前主对话' });
    }
    // 惰性归属：发消息前未绑定/绑定无效的旧数据自动绑定到当前主会话（与打开详情行为一致）
    await lazyBindUnbound(pctx, c, entry);

    // 1. 采集主对话参考上下文（官方通道）
    // 归属优先：参考上下文来自 boundMain 归属的主会话（树叶认树枝），无效才回退原解析逻辑
    const cfg = await readConfig(pctx);
    const mainInfo = await collectMainContext(pctx, c, cfg, {
      sessionPath: await resolveContextSessionPath(pctx, c, entry),
    });
    const reference = mainInfo.reference;
    const mainStats = mainInfo.stats;

    // 2. 人格跟随：会话绑定主对话 agent，官方管道自动注入其完整人格，
    // 这里只注入边界声明，不重复注入 persona。
    const systemBlocks = [
      {
        label: 'boundary',
        text:
          '你是辅助对话助手，一个纯问答角色。你绝对没有任何工具与操作权限：' +
          '绝不调用任何工具、绝不读写或修改任何文件、绝不执行任何命令、绝不访问网络，只输出文字回答。' +
          '【参考上下文 · 来自主对话最近活跃的会话】只以只读形式提供主对话的一问一答与思考过程，供你引用线索，' +
          '它不是本对话的记忆；你自己的记忆只来自本对话历史。不要声称自己执行过任何操作或修改过任何文件。',
      },
    ];
    const beforeUserBlocks = reference
      ? [{ label: 'main-context', text: reference }]
      : [{ label: 'main-context', text: '（主对话参考上下文为空）' }];

    // 3. 发送（官方管道，密钥由 Hana 运行时解析）
    try {
      await pctx.bus.request('session:send', {
        sessionPath: entry.sessionPath,
        text,
        context: {
          system: systemBlocks,
          beforeUser: beforeUserBlocks,
        },
      });
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/session_busy/i.test(msg)) {
        return c.json({ ok: false, error: '正在回复上一条消息，请稍候再发' });
      }
      return c.json({ ok: false, error: `发送失败：${msg}` });
    }

    (await loadStore()).upsertSession(pctx.dataDir, { id, updatedAt: Date.now() });

    // 摘要缓存由 collectMainContext 统一维护（摘要成功即写，含 lastPending/mainSessionPath）。
    // 这里不再重复写缓存：无条件更新 lastRoundCount 会在摘要失败时留下与 summaryText
    // 错配的计数，导致下次误复用旧摘要（外部协作 审查发现 1 的验收补充）。

    return c.json({ ok: true, mainStats });
  });

  // 绑定主会话：把辅助会话绑定到指定主会话路径（前端提示条「一键切换」调用）
  app.post('/api/sessions/:id/bind', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const entry = (await loadStore()).getSession(pctx.dataDir, id);
    if (!entry) return c.json({ ok: false, error: '会话不存在' });
    // 归属校验：会话属于其它主对话 agent 时不透出（互不串门）
    if (!isOwnedBy(entry, requestAgentId(c))) {
      return c.json({ ok: false, error: '会话不属于当前主对话' });
    }
    const mainPath = String(body.mainPath ?? '').trim();
    // 白名单校验：必须是当前 agent 的 <HOME>/agents/<agentId>/sessions/*.jsonl 路径
    if (!isAgentSessionPath(pctx, mainPath, requestAgentId(c))) {
      return c.json({ ok: false, error: 'mainPath 非法：必须是主对话会话路径' });
    }
    (await loadStore()).upsertSession(pctx.dataDir, { id, boundMain: mainPath });
    return c.json({ ok: true, boundMain: mainPath });
  });

  // 删除会话：POST 端点为主（iframe 环境兼容性最好），DELETE 保留兼容
  const removeSessionHandler = async (c) => {
    const id = c.req.param('id');
    const entry = (await loadStore()).getSession(pctx.dataDir, id);
    if (!entry) return c.json({ ok: true });
    // 归属校验：跨域删除拦截
    if (!isOwnedBy(entry, requestAgentId(c))) {
      return c.json({ ok: false, error: '会话不属于当前主对话' });
    }
    (await loadStore()).removeSession(pctx.dataDir, id);
    return c.json({ ok: true });
  };
  app.post('/api/sessions/:id/delete', removeSessionHandler);
  app.delete('/api/sessions/:id', removeSessionHandler);

  // ---------- 主对话参考上下文预览 ----------

  app.get('/api/main-preview', async (c) => {
    const cfg = await readConfig(pctx);
    // preview 轻量预览：跳过旧轮摘要（预览不需要 LLM，避免点开主对话条就烧一次采样）
    const info = await collectMainContext(pctx, c, cfg, { preview: true, skipSummary: true });
    if (!info.ok) return c.json({ ok: false, error: info.error ?? '未找到主会话' });
    const rounds = info.rounds ?? [];
    const preview = (await loadLib()).buildReferenceContext(rounds.slice(-Math.min(5, cfg.windowSize || 5)), cfg);
    return c.json({
      ok: true,
      sessionPath: info.sessionPath,
      rounds: rounds.length,
      mode: cfg.contextMode,
      preview,
    });
  });

  // ---------- 转送交互（T6）：主对话最近轮次列表 ----------

  app.get('/api/main-rounds', async (c) => {
    const cfg = await readConfig(pctx);
    // preview 轻量预览：跳过旧轮摘要（预览不需要 LLM，避免点开主对话条就烧一次采样）
    const info = await collectMainContext(pctx, c, cfg, { preview: true, skipSummary: true });
    if (!info.ok) return c.json({ ok: false, error: info.error ?? '未找到主会话' });
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 50);
    const all = info.rounds ?? [];
    const rounds = all.slice(-limit);
    return c.json({
      ok: true,
      total: all.length,
      rounds: rounds.map((r, i) => ({
        n: all.length - rounds.length + i + 1,
        user: truncate(r.user, 500),
        thinking: cfg.includeThinking ? truncate(r.thinking, 800) : '',
        assistant: truncate(r.assistant, 800),
      })),
    });
  });

  // ---------- 设置 ----------

  app.post('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = await readConfig(pctx);
    const updates = {};
    for (const k of ['contextMode', 'windowSize', 'includeThinking', 'model']) {
      if (body[k] !== undefined) {
        let v = body[k];
        // 防御：windowSize 收进 1..200（0 值会让 buildReferenceContext 的 slice(-0)=全量，
        // 与窗口语义不符，REVIEW2 发现 8）；includeThinking 强制布尔，避免字符串真值
        if (k === 'windowSize') v = Math.min(200, Math.max(1, Number(v) || 30));
        if (k === 'includeThinking') v = !!v;
        cfg[k] = v;
        updates[k] = v;
      }
    }
    // config.set 只写单 key，多 key 用 setMany（受 manifest schema 校验）
    if (Object.keys(updates).length) await pctx.config.setMany(updates);
    return c.json({ ok: true, config: cfg });
  });

  // ---------- 供应商 ----------

  app.get('/api/providers', async (c) => {
    const meta = readMainProviderMeta(pctx);
    return c.json({ ok: true, providers: meta });
  });

  app.post('/api/providers/import', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const all = readMainProviderMeta(pctx);
    const want = Array.isArray(body.ids) && body.ids.length ? body.ids : Object.keys(all);
    const cfg = await readConfig(pctx);
    for (const id of want) {
      if (all[id]) {
        cfg.importedProviders[id] = {
          baseUrl: all[id].baseUrl,
          api: all[id].api,
          models: all[id].models,
        };
      }
    }
    if (!cfg.model && want.length) {
      const first = cfg.importedProviders[want[0]];
      if (first?.models?.length) cfg.model = `${want[0]}/${first.models[0]}`;
    }
    // 快照存进 manifest 声明的 providerImportJson 字段（不含密钥）
    await pctx.config.setMany({
      providerImportJson: JSON.stringify(cfg.importedProviders),
      ...(cfg.model ? { model: cfg.model } : {}),
    });
    return c.json({ ok: true, imported: Object.keys(cfg.importedProviders), selected: cfg.model });
  });

  app.get('/api/providers/ready', async (c) => {
    const cfg = await readConfig(pctx);
    return c.json({ ok: true, imported: cfg.importedProviders ?? {}, selected: cfg.model ?? '' });
  });
}

// ---------- 内部工具 ----------

// "provider/model" → { id, provider }（agent:update-config 的 models.chat 参数格式）
function parseModelSpec(m) {
  if (!m || typeof m !== 'string') return null;
  const idx = m.lastIndexOf('/');
  if (idx <= 0 || idx >= m.length - 1) return null;
  return { id: m.slice(idx + 1), provider: m.slice(0, idx) };
}

// 当前主对话 agent 标识：host 打开 widget 时通过 iframe URL 的 agentId query 透传。
// 主会话 id 拿不到（pluginSurfaceSession 的 sessionId 是 pss_ 随机、header 被剥离），
// 故只能做 agent 级归属隔离。
function requestAgentId(c) {
  return c.req.query('agentId') || (typeof c.get === 'function' ? c.get('agentId') : null) || '';
}

// 归属校验：会话属于当前主对话 agent（或无归属的旧数据）才放行。
// 无 agentId 请求（兼容旧前端/调试）不拦截。
function isOwnedBy(entry, reqAgentId) {
  return !reqAgentId || !entry?.agentId || entry.agentId === reqAgentId;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

async function readConfig(ctx) {
  const base = {
    contextMode: 'windowed',
    windowSize: 30,
    includeThinking: true,
    model: '',
    providerImportJson: '',
    importedProviders: {},
  };
  const cur = ctx.config?.get ? await ctx.config.get() : null;
  if (cur && typeof cur === 'object') {
    for (const k of ['contextMode', 'windowSize', 'includeThinking', 'model', 'providerImportJson']) {
      if (cur[k] !== undefined) base[k] = cur[k];
    }
  }
  // 供应商导入快照（仅 baseUrl/api/models，无密钥）存于 manifest 声明的 providerImportJson 字段
  if (typeof base.providerImportJson === 'string' && base.providerImportJson) {
    try {
      const parsed = JSON.parse(base.providerImportJson);
      if (parsed && typeof parsed === 'object') base.importedProviders = parsed;
    } catch {
      // 解析失败按空处理
    }
  }
  return base;
}

// 从 widget 请求里解析主会话身份（T3 修正版 + 2026-08-16 主会话绑定增强）
// host 打开 widget 的 iframe URL 会带 agentId query（X-Hana-Plugin-Surface-Session 头
// 在转发到插件路由前已被 server 剥离，不可用）。主会话解析优先级：
//   0. 前端透传的 mainPath（SSE 事件实时追踪的「最近活跃主会话」，白名单校验）
//   1. query 显式 sessionPath/sessionId（调试，同样白名单校验）
//   2. agentId → session:list 取最近修改的 public 会话
//   3. mtime 兜底（仅当官方通道不可用）
// skipMainPath=true（relocate 重定位）时跳过 0，直接走 1/2/3（mtime 系重新定位）。
async function resolveMainSessionPath(pctx, c, skipMainPath = false) {
  const agentId = c.req.query('agentId') || '';
  const tryPath = (p) => (isAgentSessionPath(pctx, p, agentId) ? p : null);
  // 0. 前端 SSE 追踪的最近活跃主会话（最精确）
  const mp = c.req.query('mainPath') || '';
  if (!skipMainPath && mp) {
    if (isAgentSessionPath(pctx, mp, agentId)) {
      // 追加 public 校验：辅助会话（plugin_private）路径同样能过白名单，必须排除，
      // 否则 SSE 污染会让主会话定位指向辅助会话自身（参考上下文自噬）
      const publics = await getPublicSessionPaths(pctx);
      if (publics.has(normSessionPath(mp))) return mp;
    }
    // 非法/非 public：忽略，继续走后续兜底
  }
  // 1. query 里显式给 sessionPath/sessionId（调试或前端透传）
  const q = c.req.query('sessionPath') || c.req.query('sessionId') || c.req.query('session') || '';
  if (q) {
    if (q.includes('.jsonl')) {
      const ok = tryPath(q);
      if (ok) return ok;
    } else {
      // hint 是 sessionId：扫描各会话文件首行匹配（兜底）
      try {
        const root = (await loadLib()).agentsRoot(pctx);
        if (fs.existsSync(root)) {
          for (const agentDir of fs.readdirSync(root)) {
            const sessDir = path.join(root, agentDir, 'sessions');
            if (!fs.existsSync(sessDir)) continue;
            for (const f of fs.readdirSync(sessDir)) {
              if (!f.endsWith('.jsonl')) continue;
              const p = path.join(sessDir, f);
              try {
                const first = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0];
                if (first && first.includes(q)) return p;
              } catch {
                // 跳过
              }
            }
          }
        }
      } catch {
        // 忽略
      }
    }
  }
  // 2. agentId → 官方 session:list，取最近修改的 public 会话（主对话）
  if (agentId) {
    try {
      const res = await pctx.bus.request('session:list', { agentId });
      const publics = (res?.sessions ?? []).filter(
        (s) => s && s.path && s.visibility === 'public'
      );
      if (publics.length) {
        publics.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
        return publics[0].path;
      }
    } catch {
      // 继续走文件兜底
    }
  }
  // 3. mtime 兜底（仅当官方通道不可用时）
  return (await loadLib()).findMainSessionFile(pctx, null);
}

// 白名单：路径必须是 <HOME>/agents/<agentId>/sessions/*.jsonl 的绝对路径
// （防御 query 注入任意路径读取，对应 外部协作 审查发现 6）
function isAgentSessionPath(pctx, p, agentId) {
  try {
    if (typeof p !== 'string' || !p.includes('.jsonl')) return false;
    const home = path.dirname(path.dirname(pctx.pluginDir));
    const agentsDir = path.resolve(path.join(home, 'agents'));
    const rp = path.resolve(p);
    const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
    const ad = norm(agentsDir);
    const rr = norm(rp);
    if (!rr.startsWith(ad + '/')) return false;
    if (agentId) {
      const seg = rr.slice(ad.length + 1).split('/');
      if (seg[0] !== String(agentId).toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// public 主会话路径集合（规范化、去重）。带 60 秒全局缓存（SSE 过滤与 mainPath 校验共用）。
// 失败时返回旧缓存或空集合：SSE 不透传（保守，走 mtime 兜底），功能降级不崩溃。
async function getPublicSessionPaths(pctx, force = false) {
  const g = globalThis.__sideChat;
  const now = Date.now();
  if (!force && g?.publicPathsCache && now - g.publicPathsCache.ts < 60000) {
    return g.publicPathsCache.paths;
  }
  const paths = new Set();
  try {
    const res = await pctx.bus.request('session:list', {});
    for (const s of res?.sessions ?? []) {
      if (s && s.path && s.visibility === 'public') paths.add(normSessionPath(s.path));
    }
  } catch {
    // 拉取失败：保持空集合（或旧缓存），下游降级
  }
  if (g) g.publicPathsCache = { ts: now, paths };
  return paths;
}

// ---------- 主会话隔离（树枝-树叶模型） ----------

// 路径规范化：大小写与 \/ 分隔符统一（与 isAgentSessionPath 里的 norm 写法一致）
function normSessionPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : '';
}

// boundMain 有效性：白名单路径校验通过 + 指向的文件仍存在。
// 主对话会话被删除后 boundMain 即失效，归未绑定组，下次使用惰性重绑。
function isBoundMainValid(pctx, boundMain, agentId) {
  if (!isAgentSessionPath(pctx, boundMain, agentId)) return false;
  try {
    return fs.existsSync(boundMain);
  } catch {
    return false;
  }
}

// 列表过滤：当前主会话 M 时——
//   boundMain === M → 正常组；boundMain 空/无效 → 未绑定组（unbound: true）；
//   boundMain 为其它主会话 → 隔离（不返回）。
// 无 M（主会话定位失败）→ 全量返回（兼容旧行为）。纯本地判断，零 LLM。
function filterSessionsByMain(pctx, sessions, mainPath) {
  if (!mainPath || !Array.isArray(sessions)) return sessions ?? [];
  const m = normSessionPath(mainPath);
  const out = [];
  for (const s of sessions) {
    if (isBoundMainValid(pctx, s?.boundMain, s?.agentId)) {
      if (normSessionPath(s.boundMain) === m) out.push(s);
      // 绑定到其它主会话：不返回（树枝-树叶隔离）
    } else {
      // 未绑定或绑定已失效（文件被删）：可见但标记，前端显示「（未绑定）」
      out.push({ ...s, unbound: true });
    }
  }
  return out;
}

// 惰性归属：未绑定/绑定无效的会话，自动绑定到当前解析的主会话路径（旧数据自然归位，用户无感）。
// entry 就地更新 boundMain，调用方后续直接使用新绑定。
async function lazyBindUnbound(pctx, c, entry) {
  if (!entry || isBoundMainValid(pctx, entry.boundMain, entry.agentId)) return false;
  const mainPath = await resolveMainSessionPath(pctx, c).catch(() => null);
  if (!mainPath) return false;
  entry.boundMain = mainPath;
  // 归属完整化：旧数据缺 agentId 时一并补写（谁先打开归谁，REVIEW2 发现 22）
  const agentId = requestAgentId(c) || entry.agentId;
  if (agentId) entry.agentId = agentId;
  (await loadStore()).upsertSession(pctx.dataDir, { id: entry.id, boundMain: mainPath, ...(agentId ? { agentId } : {}) });
  return true;
}

// 参考上下文主会话定位（归属优先）：boundMain 有效则用它，无效/为空才走原解析逻辑
// （resolveMainSessionPath：mainPath query → sessionId → agent 最近会话 → mtime）。
async function resolveContextSessionPath(pctx, c, entry) {
  if (entry && isBoundMainValid(pctx, entry.boundMain, entry.agentId)) return entry.boundMain;
  return resolveMainSessionPath(pctx, c);
}

// 主会话信息：优先官方 history API，兜底 JSONL
// opts.skipSummary=true 时跳过旧轮摘要（状态接口用，零 LLM 调用）
async function collectMainContext(pctx, c, cfg, opts = {}) {
  // 归属优先：调用方显式给出会话路径（辅助会话 boundMain）且通过白名单时直接用，
  // 否则走 resolveMainSessionPath 原解析逻辑。
  // opts.relocate=true（重定位模式）：显式 sessionPath 仍归属优先，其余情况跳过前端
  // mainPath，按 mtime 系兜底重新定位（主对话切换纠正）。
  const sessionPath =
    opts.sessionPath && isAgentSessionPath(pctx, opts.sessionPath, requestAgentId(c))
      ? opts.sessionPath
      : await resolveMainSessionPath(pctx, c, !!opts.relocate);
  if (!sessionPath) {
    return { ok: false, error: '未找到主会话', stats: { rounds: 0, mode: cfg.contextMode }, rounds: [], reference: '' };
  }
  let rounds = [];
  let viaApi = true;
  let apiError = null;
  try {
    const res = await pctx.bus.request('session:history', { sessionPath, limit: 500 });
    rounds = (await loadLib()).roundsFromHistory(res?.messages);
  } catch (e) {
    viaApi = false;
    apiError = String(e?.message ?? e);
    rounds = (await loadLib()).parseSessionJsonl(sessionPath);
  }
  const roundCount = rounds.length;
  // 半截快照检测：主对话最后一条是用户消息、助手尚未回复（助手还在生成中）
  const lastRound = rounds[roundCount - 1];
  const pending = !!(lastRound && lastRound.user && !lastRound.assistant);
  let reference = '';
  if (rounds.length) {
    if (cfg.contextMode === 'full') {
      // full 模式全量：buildReferenceContext 默认按 windowSize 截尾，
      // 显式放开，避免「全量」实际只剩最近 30 轮（REVIEW2 发现 2）
      reference = (await loadLib()).buildReferenceContext(rounds, { ...cfg, windowSize: Infinity });
    } else {
      const windowSize = Math.max(1, Number(cfg.windowSize) || 30);
      const recent = rounds.slice(-windowSize);
      const old = rounds.slice(0, Math.max(0, rounds.length - windowSize));
      reference = (await loadLib()).buildReferenceContext(recent, cfg);
      if (old.length && !opts.skipSummary) {
        // 摘要缓存复用：同主会话、轮数未回退、pending 状态一致才可复用，否则重新摘要
        const cache = (await loadLib()).loadCache(pctx.dataDir, requestAgentId(c));
        const cacheOk =
          cache.mainSessionPath === sessionPath &&
          cache.lastRoundCount > 0 &&
          cache.lastRoundCount <= roundCount &&
          cache.lastPending === !!pending;
        let summary = cacheOk && cache.lastRoundCount === roundCount ? cache.summaryText || null : null;
        if (!summary) {
          summary = await (await loadLib()).summarizeOld(pctx, old).catch(() => null);
          if (summary) {
            // 摘要完成即写缓存（含 pending 状态），不等发送成功
            (await loadLib()).saveCache(pctx.dataDir, {
              lastRoundCount: roundCount,
              summaryText: summary,
              mainSessionPath: sessionPath,
              lastPending: !!pending,
            }, requestAgentId(c));
          }
          // 摘要失败：降级为不带摘要，不写坏缓存
        }
        if (summary) reference = `【主对话早期轮次摘要】\n${summary}\n\n${reference}`;
      }
    }
  }
  return {
    ok: true,
    sessionPath,
    rounds,
    roundCount,
    viaApi,
    reference,
    pending,
    stats: { rounds: roundCount, mode: cfg.contextMode, viaApi, pending, file: path.basename(sessionPath), ...(apiError ? { apiError } : {}) },
  };
}

// ---------- 主会话统计短 TTL 缓存（REVIEW2） ----------

// /api/state 每 5 秒轮询 + SSE 事件刷新都会调 mainSessionInfo → collectMainContext(skipSummary)，
// 每次都 session:history 读主对话 500 条，高频重复读浪费，这里加 10 秒短 TTL。
// 缓存键 = agentId + mainPath query + contextMode（mode 变才失效；mainPath 变说明主对话切换）。
// pending/轮数最多滞后 10 秒，可接受：SSE 事件也会触发前端刷新，但后端缓存 10 秒内仍复用，
// 这是有意的节流。collectMainContext 本身（发消息路径）不走此缓存。
const STATE_CACHE_TTL_MS = 10000;

// 缓存容器挂在 globalThis.__sideChat 单例上（与 getPublicSessionPaths 的 publicPathsCache 共用一个容器）；
// 单例不可用时（可能为 null）返回 null，调用方退化不缓存、每次重算。
function getStateCache() {
  if (!globalThis.__sideChat || typeof globalThis.__sideChat !== 'object') return null;
  if (!globalThis.__sideChat.stateCache) globalThis.__sideChat.stateCache = new Map();
  return globalThis.__sideChat.stateCache;
}

// 主会话信息（状态接口）：优先官方 history API，兜底 JSONL；带 10 秒短 TTL 缓存。
// opts.relocate=true（重定位模式）：不读缓存（要「当前时刻」的 mtime 定位，缓存可能返回
// 切换前的旧路径），也不写缓存（请求携带的 mainPath 仍是旧值，写进去会污染正常键；
// 下一轮正常请求带新 lastMainPath 会命中新键，无需回填）。
async function mainSessionInfo(pctx, c, opts = {}) {
  const cfg = await readConfig(pctx);
  const cache = getStateCache();
  const key = `${requestAgentId(c)}|${c.req.query('mainPath') || ''}|${cfg.contextMode}`;
  const now = Date.now();
  if (cache && !opts.relocate) {
    const hit = cache.get(key);
    if (hit && now - hit.ts < STATE_CACHE_TTL_MS) return hit.value;
  }
  // 状态接口零 LLM：跳过旧轮摘要（轮数/pending/stats 照常返回）
  const info = await collectMainContext(pctx, c, cfg, { skipSummary: true, relocate: !!opts.relocate }).catch(() => ({ ok: false }));
  let result;
  if (!info.ok) {
    result = { found: false, rounds: 0, mode: cfg.contextMode };
  } else {
    result = {
      found: true,
      rounds: info.roundCount,
      mode: cfg.contextMode,
      viaApi: info.viaApi,
      pending: !!info.pending,
      // 主会话路径：前端与辅助会话的 boundMain 对比，判定是否需提示切换
      sessionPath: info.sessionPath ?? null,
      ...(info.stats?.apiError ? { apiError: info.stats.apiError } : {}),
    };
  }
  if (cache && !opts.relocate) {
    // 顺带清理过期条目（键随 agent/主会话切换累积，量小直接遍历）
    for (const [k, v] of cache) {
      if (now - v.ts >= STATE_CACHE_TTL_MS) cache.delete(k);
    }
    cache.set(key, { ts: now, value: result });
  }
  return result;
}

// 绑定的 agent：主对话 agent（人格由官方管道注入）。失败返回 undefined（系统默认）。
async function resolveBoundAgent(pctx, c) {
  try {
    const mainPath = await resolveMainSessionPath(pctx, c);
    if (mainPath) {
      const agentId = path.basename(path.dirname(path.dirname(mainPath)));
      return agentId;
    }
  } catch {
    // 忽略
  }
  return undefined;
}

function normalizeHistory(res) {
  const list = res?.messages ?? (Array.isArray(res) ? res : null);
  if (!list) return [];
  // 过滤空 assistant 消息（流式分段产物），避免 UI 空气泡；透传 thinking 供思考块渲染
  return list
    .map((m) => ({
      role: m?.role ?? 'unknown',
      text: typeof m?.content === 'string' ? m.content : (typeof m?.text === 'string' ? m.text : ''),
      thinking: typeof m?.thinking === 'string' ? m.thinking : '',
    }))
    .filter((m) => (m.role === 'assistant' ? (m.text ?? '').trim() !== '' || (m.thinking ?? '').trim() !== '' : true));
}

function readMainProviderMeta(pctx) {
  // 读主配置 models.json 的供应商元数据（不含明文密钥，只含协议与模型列表）
  const home = path.dirname(path.dirname(pctx.pluginDir));
  const candidates = [path.join(home, 'models.json'), path.join(home, '..', 'models.json')];
  for (const f of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const providers = raw?.providers ?? raw?.models?.providers ?? null;
      if (!providers || typeof providers !== 'object') continue;
      const out = {};
      for (const [id, v] of Object.entries(providers)) {
        out[id] = {
          baseUrl: v?.baseUrl ?? '',
          api: v?.api ?? '',
          models: Array.isArray(v?.models)
            ? v.models.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.model ?? '')).filter(Boolean)
            : [],
        };
      }
      return out;
    } catch {
      // 尝试下一个候选
    }
  }
  return {};
}
