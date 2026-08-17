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
let _adapter = null;
async function loadAdapter() {
  return _adapter ??= import(`../lib/host-adapter.js?t=${Date.now()}`);
}
let _store = null;
async function loadStore() {
  return _store ??= import(`../lib/store.js?t=${Date.now()}`);
}
let _profile = null;
async function loadProfile() {
  return _profile ??= import(`../lib/profile-provider.js?t=${Date.now()}`);
}
let _providerStore = null;
async function loadProviderStore() {
  return _providerStore ??= import(`../lib/provider-store.js?t=${Date.now()}`);
}
let _modelAdapter = null;
async function loadModelAdapter() {
  return _modelAdapter ??= import(`../lib/model-adapter.js?t=${Date.now()}`);
}

// 默认「自我意识」提示词：辅助对话的身份定位。
// 用户可在设置面板编辑（配置字段 selfPrompt），发送时作为附加 system 块注入，
// 不替换主对话/辅助对话共用的原有系统提示词机制。
const DEFAULT_SELF_PROMPT =
  '你是「辅助对话」——主对话的顾问副手，不是主对话本身。\n' +
  '\n' +
  '你的身份：你是一个依附于某个主对话而存在的独立辅助对话。主对话负责执行（调用工具、读写文件、运行命令、修改系统），而你只负责思考与建议。你与主对话是「军师与主公」的关系：主对话动手，你出谋。\n' +
  '\n' +
  '行为准则：\n' +
  '1. 你没有任何工具与操作权限：绝不调用工具、绝不读写或修改任何文件、绝不执行任何命令、绝不访问网络，只输出文字。\n' +
  '2. 你的产出形态是「建议」：操作方案、实现思路、风险提醒、决策参考。需要动手的事，给出明确可执行的指示让主人在主对话中执行（例如：建议在主对话里说：「请执行 xxx」）。\n' +
  '3. 不要把自己当作主对话来回答：不要声称自己执行过任何操作、修改过任何文件、发送过任何消息。主人若要执行，应由主人在主对话中提出。\n' +
  '4. 【主对话参考上下文】只以只读形式提供主对话的一问一答与思考过程，供你引用线索；它不是你的记忆，也不是本对话的历史。\n' +
  '5. 你的记忆只来自本辅助对话自己的历史。请始终区分两套上下文：主对话的材料是「参考资料」，辅助对话的历史才是「你的记忆」。\n' +
  '6. 主人向你求助操作问题时，给出建议与步骤，而不是宣称代劳；你可以追问澄清，帮助主人把需求想清楚。';

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
    const visible = main?.sessionPath ? await filterSessionsByMain(pctx, sessions, main.sessionPath) : sessions;
    return c.json({ ok: true, config: cfg, sessions: visible, main });
  });

  // ---------- 健康自检（借鉴 DSHana 诊断思路） ----------

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
    // renderer 补丁状态（sessionPath 注入，升级即丢）：检查关键特征字符串（与 debug/check-renderer-patch.js 同源）
    let rendererPatch = { status: 'unknown' };
    try {
      const rAssets = path.join(home, 'artifacts', 'renderer');
      // 找最新版本目录（与 server 版本号对应，取 mtime 最新）
      let bestDir = null;
      let bestMtime = 0;
      if (fs.existsSync(rAssets)) {
        for (const d of fs.readdirSync(rAssets)) {
          const p = path.join(rAssets, d);
          try {
            const st = fs.statSync(p);
            if (st.isDirectory() && st.mtimeMs > bestMtime) {
              bestDir = p;
              bestMtime = st.mtimeMs;
            }
          } catch {
            // 跳过
          }
        }
      }
      if (bestDir) {
        const files = fs.readdirSync(path.join(bestDir, 'assets')).filter((f) => f.endsWith('.js'));
        const sb = files.find((f) => f.startsWith('SendButton-'));
        const wr = files.find((f) => f.startsWith('WorkspaceCompanionRail-'));
        const read = (f) => (f ? fs.readFileSync(path.join(bestDir, 'assets', f), 'utf8') : '');
        const sbc = read(sb);
        const wrc = read(wr);
        const okSend = sbc.includes('function xl(t,e,g){') && sbc.includes('q&&m.searchParams.set("sessionPath",q)');
        const okRail = wrc.includes('b=m(u=>u.currentSessionPath??null)') && wrc.includes('r=ms(o?.routeUrl??null,a,b)');
        rendererPatch = okSend && okRail
          ? { status: 'pass', detail: 'renderer sessionPath 注入补丁在（SendButton + WorkspaceCompanionRail）' }
          : { status: 'fail', detail: `renderer 补丁丢失（SendButton:${okSend ? '✓' : '✗'} WorkspaceCompanionRail:${okRail ? '✓' : '✗'}），升级会覆盖 artifacts，重跑 debug/apply-sessionpath-patch.cjs` };
      } else {
        rendererPatch = { status: 'unknown', detail: '未找到 renderer 目录' };
      }
    } catch (e) {
      rendererPatch = { status: 'unknown', detail: String(e?.message ?? e) };
    }
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
      config: { contextMode: cfg.contextMode, windowSize: cfg.windowSize, includeThinking: cfg.includeThinking, model: cfg.model || null, selfPrompt: cfg.selfPrompt ?? '' },
      mainSession,
      hostPatch,
      rendererPatch,
      cache: cache
        ? { exists: true, lastRoundCount: cache.lastRoundCount ?? 0, mainSessionPath: cache.mainSessionPath ?? null, lastPending: !!cache.lastPending, hasSummary: !!(cache.summaryText ?? '') }
        : { exists: false },
    });
  });

  // ---------- 人格读取（ProfileProvider 只读接口） ----------

  // 读取主对话 agent 人格（identity/ishiki/personality/name/yuan）。
  // 供新架构直连 API 时组装 system 提示词；当前官方管道路径下仅诊断/调试用。
  // agentId 取 query（显式优先），缺省回落 requestAgentId。内部失败不报错，
  // 返回空字段（profile-provider 不 throw 契约）。
  app.get('/api/profile', async (c) => {
    const agentId = c.req.query('agentId') || requestAgentId(c) || '';
    const profile = await (await loadProfile()).getProfile(pctx, agentId);
    return c.json({ ok: true, agentId, ...profile });
  });

  // ---------- 主对话实时同步（SSE） ----------

  app.get('/api/main-events', (c) => {
    const agentId = requestAgentId(c);
    const signal = c.req.raw?.signal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        // adapter 预加载：subscribe 同步回调内不能 await，先取好引用（模块无副作用）
        const adapter = await loadAdapter();
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
            const paths = await adapter.getPublicSessionPaths(pctx, force);
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
            if (sessionPath && !publicSet.has(adapter.normSessionPath(sessionPath))) {
              return; // 非 public 主会话（辅助会话自身/其它）：不透传，避免污染
            }
            send({ type: 'main-changed', eventType: event?.type ?? null, sessionPath: sessionPath || null });
          }, { types: ['message_end', 'turn_end', 'session_user_message'] });
        } catch (e) {
          send({ type: 'error', message: String(e?.message ?? e) });
        }
        const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
        send({ type: 'ready', agentId });
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return; // 幂等：abort / 自检 / 超时可重复触发
          cleaned = true;
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
        // 自清理兜底（REVIEW2 发现 12）：host 不触发 abort 时（raw.signal 不可靠），
        // 30 秒自检流是否已被消费端取消（desiredSize === null），是则主动清理；
        // 10 分钟无活动超时兜底。双保险防订阅与定时器泄漏。
        const selfCheck = setInterval(() => {
          if (controller.desiredSize === null) cleanup();
        }, 30000);
        const idleTimer = setTimeout(cleanup, 10 * 60 * 1000);
        // 兜底定时器随 cleanup 一并回收（在 cleanup 后补挂的清理，靠 cleaned 幂等兜住）
        const _base = cleanup;
        const cleanupAll = () => {
          clearInterval(selfCheck);
          clearTimeout(idleTimer);
          _base();
        };
        // 用 cleanupAll 替换信号监听与 selfCheck/idleTimer 的调用目标
        signal?.addEventListener('abort', cleanupAll, { once: true });
        // selfCheck/idleTimer 里仍指向 cleanup（原版），cleanup 幂等 + 兜底定时器
        // 在 cleanupAll 里回收；若 abort 先触发，selfCheck 会继续跑但 cleanup 幂等无害，
        // 30 秒后自检 desiredSize===null 再触发一次 cleanup（也幂等）。可接受。
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
      // 模型选择：设置里选的模型（provider/model）通过 session:create 的 model 参数绑定，
      // 实测生效（会话 model_change 记录正确）。绑定主对话 agent（人格由官方管道注入）。
      const cfg = await readConfig(pctx);
      const modelSpec = parseModelSpec(cfg.model);
      const { sessionId, sessionPath } = await (await loadAdapter()).createSession(pctx, {
        agentId: await resolveBoundAgent(pctx, c),
        ...(modelSpec ? { model: modelSpec } : {}),
      });
      // 绑定主会话：创建时 resolveMainSessionPath 解析的「最近活跃主会话」路径（前端 SSE 追踪值优先）。
      // 解析失败/无主会话时为 null（未绑定，前端提示条不显示，行为与旧版一致）。
      let boundMain = null;
      try {
        boundMain = await (await loadAdapter()).resolveMainSessionPath(pctx, c);
      } catch {
        boundMain = null;
      }
      created = (await loadStore()).upsertSession(pctx.dataDir, {
        id: sessionId,
        sessionPath,
        // 绑定主会话：参考上下文来源路径（前端「绑定 ≠ 当前主会话」时提示一键切换）
        boundMain,
        // agent 级归属：记录创建时的主对话 agent，列表据此过滤（按 agent 域隔离）
        agentId: requestAgentId(c) || undefined,
        title: body.title || `辅助对话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // 创建时快照（2026-08-16 用户设计）：立即采集主对话上下文，快照即完整。
      // full = 全部轮原文；windowed = 最近 N 轮原文 + 更早轮摘要（摘要此刻调一次模型）。
      // 无主会话/读取失败时不阻断创建：mainCtx 缺失，首次发消息时自动补建。
      // skipSummary（空白态自动创建用）：跳过快照（含摘要模型调用），创建更快；
      // mainCtx 缺失由 POST /messages 的 syncMainContext 在首次发消息时补建。
      if (boundMain && created?.id && body.skipSummary !== true) {
        try {
          const snap = await buildMainSnapshot(pctx, c, cfg, boundMain);
          if (snap) {
            created = (await loadStore()).upsertSession(pctx.dataDir, { id: created.id, mainCtx: snap });
          }
        } catch {
          // 快照失败不阻断创建（首次发消息时补）
        }
      }
    } catch (e) {
      return c.json({ ok: false, error: `创建会话失败：${e?.message ?? e}` });
    }
    return c.json({ ok: true, session: created });
  });

  app.get('/api/sessions', async (c) => {
    const sessions = (await loadStore()).listSessions(pctx.dataDir, requestAgentId(c));
    // 与 /api/state 一致：按当前主会话隔离过滤（mainSessionInfo 走 skipSummary，零 LLM）
    const main = await mainSessionInfo(pctx, c);
    const visible = main?.sessionPath ? await filterSessionsByMain(pctx, sessions, main.sessionPath) : sessions;
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
      const res = await (await loadAdapter()).readHistory(pctx, entry.sessionPath, 200);
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

    // 1. 采集主对话参考上下文（快照+增量机制，2026-08-16）：
    //    创建时已快照（mainCtx），此处只同步主对话新增的完整轮次并追加，然后注入累积文本。
    //    归属优先：同步源是 boundMain 归属的主会话（树叶认树枝），无效才回退原解析逻辑。
    const cfg = await readConfig(pctx);
    const mainInfo = await syncMainContext(pctx, c, entry, cfg);
    const reference = mainInfo.reference;
    const mainStats = mainInfo.stats;

    // 2. 人格跟随：会话绑定主对话 agent，官方管道自动注入其完整人格，
    //    这里只注入边界声明与「自我意识」提示词（用户可编辑，见设置面板）。
    const systemBlocks = [
      // 自我意识块（用户可编辑；空串/未配置则不注入，走原有机制）
      ...(cfg.selfPrompt && String(cfg.selfPrompt).trim()
        ? [{ label: 'sidechat-identity', text: String(cfg.selfPrompt).trim() }]
        : []),
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
      await (await loadAdapter()).sendMessage(pctx, {
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
    // 错配的计数，导致下次误复用旧摘要（审查发现的验收补充）。

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
    if (!(await loadAdapter()).isAgentSessionPath(pctx, mainPath, requestAgentId(c))) {
      return c.json({ ok: false, error: 'mainPath 非法：必须是主对话会话路径' });
    }
    (await loadStore()).upsertSession(pctx.dataDir, { id, boundMain: mainPath });
    return c.json({ ok: true, boundMain: mainPath });
  });

  // 重命名会话：只改索引 title；不动 updatedAt（重命名不该把会话顶到列表最前）
  app.post('/api/sessions/:id/rename', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const entry = (await loadStore()).getSession(pctx.dataDir, id);
    if (!entry) return c.json({ ok: false, error: '会话不存在' });
    // 归属校验：跨域改名拦截（同删除/绑定）
    if (!isOwnedBy(entry, requestAgentId(c))) {
      return c.json({ ok: false, error: '会话不属于当前主对话' });
    }
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ ok: false, error: '标题不能为空' });
    if (title.length > 60) return c.json({ ok: false, error: '标题过长（最多 60 字）' });
    (await loadStore()).upsertSession(pctx.dataDir, { id, title });
    return c.json({ ok: true, title });
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
    for (const k of ['contextMode', 'windowSize', 'includeThinking', 'model', 'selfPrompt']) {
      if (body[k] !== undefined) {
        let v = body[k];
        // 防御：windowSize 收进 1..200（0 值会让 buildReferenceContext 的 slice(-0)=全量，
        // 与窗口语义不符，REVIEW2 发现 8）；includeThinking 强制布尔，避免字符串真值；
        // selfPrompt 纯文本，trim + 4000 字上限（空串=清空，走原有机制）
        if (k === 'windowSize') v = Math.min(200, Math.max(1, Number(v) || 30));
        if (k === 'includeThinking') v = !!v;
        if (k === 'selfPrompt') v = String(v ?? '').slice(0, 4000);
        cfg[k] = v;
        updates[k] = v;
      }
    }
    // config.set 只写单 key，多 key 用 setMany（受 manifest schema 校验）
    if (Object.keys(updates).length) {
      try {
        await pctx.config.setMany(updates);
      } catch (e) {
        // REVIEW3 H1：setMany 失败（如 schema 校验拒绝）必须显式报错，前端不再静默丢设置
        return c.json({ ok: false, error: `设置保存失败：${String(e?.message ?? e).slice(0, 200)}` });
      }
    }
    return c.json({ ok: true, config: cfg });
  });

  // ---------- 供应商（插件独立配置，直连 API 架构） ----------

  // GET /api/providers —— 插件自己的供应商配置。apiKey 脱敏：明文密钥绝不回传
  // （回 hasKey 布尔，供 UI 提示「密钥已保存，留空保持不变」），避免日志/调试链路泄露。
  app.get('/api/providers', async (c) => {
    const ps = await loadProviderStore();
    const data = await ps.loadProviders(pctx);
    return c.json({
      ok: true,
      providers: data.providers.map(maskProvider),
      defaultProviderId: data.defaultProviderId,
      defaultModel: data.defaultModel,
    });
  });

  // PUT /api/providers —— 整体保存（providers + 默认选择）。
  // apiKey 合并规则见 provider-store.saveProviders：新对象缺省 apiKey 字段时保留原 key
  // （前端拿到的是脱敏数据，整体提交不会丢密钥）；显式提供（含空串）则覆盖/清空。
  app.put('/api/providers', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ps = await loadProviderStore();
    const res = await ps.saveProviders(pctx, {
      providers: Array.isArray(body.providers) ? body.providers : undefined,
      defaultProviderId: body.defaultProviderId,
      defaultModel: body.defaultModel,
    });
    if (!res.ok) return c.json({ ok: false, error: `供应商保存失败：${res.error}` });
    return c.json({ ok: true, providers: res.providers.map(maskProvider) });
  });

  // POST /api/providers/default —— 只更新默认供应商/模型（模型切换下拉用，轻量不碰列表）
  app.post('/api/providers/default', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ps = await loadProviderStore();
    const res = await ps.saveDefaults(pctx, {
      defaultProviderId: body.defaultProviderId,
      defaultModel: body.defaultModel,
    });
    if (!res.ok) return c.json({ ok: false, error: `默认选择保存失败：${res.error}` });
    return c.json({ ok: true });
  });

  // POST /api/providers/test —— 测试连接：GET {规整 baseUrl}/models 轻量验证 baseUrl+key
  // （key 仅本次请求使用，不落盘；用户确认可用后再保存）
  app.post('/api/providers/test', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const adapter = await loadModelAdapter();
    const res = await adapter.testConnection({ baseUrl: body.baseUrl, apiKey: body.apiKey });
    if (!res.ok) {
      const err = res.error ?? {};
      return c.json({ ok: false, error: err.message ?? '连接失败', ...(err.status ? { status: err.status } : {}) });
    }
    return c.json({ ok: true, status: res.status, models: res.models });
  });

  // GET /api/providers/templates —— 预置模板清单（不含任何密钥，前端「添加供应商」下拉用）
  app.get('/api/providers/templates', async (c) => {
    const ps = await loadProviderStore();
    const templates = ps.PRESET_PROVIDERS.map(({ apiKey, ...rest }) => rest);
    return c.json({ ok: true, templates });
  });

  // GET /api/providers/meta —— 主设置供应商元数据（仅 baseUrl/api/models，无密钥），
  // 供「从主设置一键导入」按钮使用（旧 GET /api/providers 逻辑迁至此处）。
  app.get('/api/providers/meta', async (c) => {
    const meta = readMainProviderMeta(pctx);
    return c.json({ ok: true, providers: meta });
  });

  // POST /api/providers/import —— 把主设置元数据导入为插件 providers（builtin=false，
  // apiKey 留空待用户填写）。替代旧 providerImportJson 快照方案（密钥不再进 config 快照）。
  app.post('/api/providers/import', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const all = readMainProviderMeta(pctx);
    const want = Array.isArray(body.ids) && body.ids.length ? body.ids : Object.keys(all);
    const ps = await loadProviderStore();
    const data = await ps.loadProviders(pctx);
    const existing = new Set(data.providers.map((p) => p.id));
    const imported = [];
    for (const id of want) {
      if (!all[id] || existing.has(id)) continue;
      data.providers.push({
        id,
        name: id,
        baseUrl: all[id].baseUrl,
        apiKey: '',
        builtin: false,
        protocol: all[id].api || 'openai',
        enabled: true,
        models: (all[id].models ?? []).map((m) => ({ id: m, name: m, params: {} })),
      });
      imported.push(id);
    }
    if (!imported.length) return c.json({ ok: true, imported: [], note: '没有可导入的新供应商（可能已全部存在）' });
    if (!data.defaultProviderId && want.length && all[want[0]]) data.defaultProviderId = want[0];
    const res = await ps.saveProviders(pctx, data);
    if (!res.ok) return c.json({ ok: false, error: `导入失败：${res.error}` });
    return c.json({ ok: true, imported, selected: data.defaultProviderId });
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

// 供应商脱敏：明文 apiKey 不出后端（回传 hasKey 布尔，供 UI 提示「密钥已保存」）
function maskProvider(p) {
  if (!p || typeof p !== 'object') return p;
  const { apiKey, ...rest } = p;
  return { ...rest, apiKey: '', hasKey: !!String(apiKey ?? '').trim() };
}

async function readConfig(ctx) {
  const base = {
    contextMode: 'windowed',
    windowSize: 30,
    includeThinking: true,
    model: '',
    selfPrompt: DEFAULT_SELF_PROMPT,
    providerImportJson: '',
    importedProviders: {},
    providersJson: '',
    defaultProviderId: '',
    defaultModel: '',
  };
  const cur = ctx.config?.get ? await ctx.config.get() : null;
  if (cur && typeof cur === 'object') {
    for (const k of ['contextMode', 'windowSize', 'includeThinking', 'model', 'selfPrompt', 'providerImportJson', 'providersJson', 'defaultProviderId', 'defaultModel']) {
      if (cur[k] !== undefined) base[k] = cur[k];
    }
  }
  // selfPrompt 空串（新装默认/用户清空）回退内置默认文案：
  // 语义 =「清空恢复默认」，而不是禁用（REVIEW3 H1 修正，保证机制始终可用）
  if (!String(base.selfPrompt ?? '').trim()) base.selfPrompt = DEFAULT_SELF_PROMPT;
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

// 主会话定位（resolveMainSessionPath 五级降级链）与白名单（isAgentSessionPath）、
// public 路径集合（getPublicSessionPaths）、路径规范化（normSessionPath）等私有函数
// 已迁入 lib/host-adapter.js（HOST_ADAPTER.md 迁移步骤 1），本文件经由 loadAdapter()
// 动态引用。以下保留 api.js 自己的业务逻辑。

// boundMain 有效性：白名单路径校验通过 + 指向的文件仍存在。
// 主对话会话被删除后 boundMain 即失效，归未绑定组，下次使用惰性重绑。
// （async 化：白名单校验已迁入 host-adapter，经动态 import 引用，调用点均处 async 上下文）
async function isBoundMainValid(pctx, boundMain, agentId) {
  if (!(await loadAdapter()).isAgentSessionPath(pctx, boundMain, agentId)) return false;
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
// （async 化：路径规范化已迁入 host-adapter，经动态 import 引用，调用点均处 async 上下文）
async function filterSessionsByMain(pctx, sessions, mainPath) {
  const adapter = await loadAdapter();
  if (!mainPath || !Array.isArray(sessions)) return sessions ?? [];
  const m = adapter.normSessionPath(mainPath);
  const out = [];
  for (const s of sessions) {
    if (await isBoundMainValid(pctx, s?.boundMain, s?.agentId)) {
      if (adapter.normSessionPath(s.boundMain) === m) out.push(s);
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
  if (!entry || (await isBoundMainValid(pctx, entry.boundMain, entry.agentId))) return false;
  const mainPath = await (await loadAdapter()).resolveMainSessionPath(pctx, c).catch(() => null);
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
  if (entry && (await isBoundMainValid(pctx, entry.boundMain, entry.agentId))) return entry.boundMain;
  return (await loadAdapter()).resolveMainSessionPath(pctx, c);
}

// 主会话信息：优先本地文件直读（parseSessionJsonl，无 200 条上限与过滤），
// 文件无结果时兜底官方 history API（2026-08-16 主源切换）。
// opts.skipSummary=true 时跳过旧轮摘要（状态接口用，零 LLM 调用）
async function collectMainContext(pctx, c, cfg, opts = {}) {
  // 归属优先：调用方显式给出会话路径（辅助会话 boundMain）且通过白名单时直接用，
  // 否则走 resolveMainSessionPath 原解析逻辑。
  // opts.relocate=true（重定位模式）：显式 sessionPath 仍归属优先，其余情况跳过前端
  // mainPath，按 mtime 系兜底重新定位（主对话切换纠正）。
  const sessionPath =
    opts.sessionPath && (await loadAdapter()).isAgentSessionPath(pctx, opts.sessionPath, requestAgentId(c))
      ? opts.sessionPath
      : await (await loadAdapter()).resolveMainSessionPath(pctx, c, !!opts.relocate);
  if (!sessionPath) {
    return { ok: false, error: '未找到主会话', stats: { rounds: 0, mode: cfg.contextMode }, rounds: [], reference: '' };
  }
  const { rounds, viaApi, apiError } = await readMainRounds(pctx, sessionPath);
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
      reference = (await loadLib()).buildReferenceContext(recent, { ...cfg, baseIndex: old.length });
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

// ---------- 快照 + 增量机制（2026-08-16 用户设计） ----------

// 读主会话轮次：主源文件直读（parseSessionJsonl，与 host 的 Gv 读同一文件、同一套字段），
// 绕开 host session:history 200 条上限与过滤（host 源码实锤，2026-08-16）。
// 文件读取异常或解析结果为空时，fallback 官方 session:history（至少能拿到最近可用数据）。
// 返回 { rounds, viaApi, apiError }：viaApi=true 表示本次实际来源为官方通道（history fallback），
// false=文件直读；apiError 仅 history 路径失败时记录。
async function readMainRounds(pctx, sessionPath) {
  const lib = await loadLib();
  const adapter = await loadAdapter();
  let rounds = [];
  try {
    rounds = adapter.parseSessionJsonl(sessionPath);
  } catch (e) {
    // parseSessionJsonl 内部已容错返回 []，此处防御未来改动
    rounds = [];
  }
  if (!rounds.length) {
    // 文件直读无结果：兜底官方通道（limit 500 会被 host 截到 200，仅作保底）
    try {
      const res = await adapter.readHistory(pctx, sessionPath, 500);
      return { rounds: lib.roundsFromHistory(res?.messages), viaApi: true, apiError: null };
    } catch (e) {
      return { rounds: [], viaApi: true, apiError: String(e?.message ?? e) };
    }
  }
  return { rounds, viaApi: false, apiError: null };
}

// 创建会话时的初始快照：full = 全部轮原文；windowed = 最近 N 轮原文 + 更早轮摘要（此刻调一次模型）。
// 返回 { text, lastRoundCount, mainSessionPath, mode }；无轮次返回 null。
// lastRoundCount 只计「配对完整的轮数」（pending 轮等配对完成后再进增量）。
// 2026-08-16：主源文件直读，绕开 host session:history 200 条上限与过滤（host 源码实锤）。
async function buildMainSnapshot(pctx, c, cfg, sessionPath) {
  const lib = await loadLib();
  const { rounds } = await readMainRounds(pctx, sessionPath);
  if (!rounds.length) return null;
  const fullCount = lib.completedRounds(rounds);
  const windowSize = cfg.contextMode === 'full' ? Infinity : Math.max(1, Number(cfg.windowSize) || 30);
  // REVIEW3 H2：只渲染「已配对」轮次（slice(0, fullCount)），pending 轮（最后一条未回复的 user）
  // 不渲染，等配对完成后由增量路径追加——保证每一轮在参考上下文里恰好出现一次。
  const recent = rounds.slice(0, fullCount).slice(-windowSize);
  const old = rounds.slice(0, Math.max(0, fullCount - windowSize));
  // full 模式总量自适应：主对话几百轮时每轮 4000 字会让注入文本远超模型上下文
  // （被模型侧截断，用户看到「还是不全」）。8 万字符 ≈ 4 万 token 总量预算，
  // 按轮数均摊每轮上限（每轮最低 500 字），保证覆盖全部轮次且总量可控。
  let text = lib.buildReferenceContext(recent, {
    ...cfg,
    baseIndex: old.length, // REVIEW3 M2：窗口内序号 = 全局序号（窗口外的轮次编号继续）
    maxTotalChars: cfg.contextMode === 'full' ? 80000 : undefined,
  });
  if (old.length && cfg.contextMode !== 'full') {
    const summary = await lib.summarizeOld(pctx, old).catch(() => null);
    if (summary) text = `【主对话早期轮次摘要】\n${summary}\n\n${text}`;
  }
  return { text, lastRoundCount: fullCount, mainSessionPath: sessionPath, mode: cfg.contextMode };
}

// 发消息时同步：快照缺失/来源变化则重建；否则只追加主对话新增的完整轮次（pending 轮等完成）。
// 返回结构兼容 collectMainContext（stats.rounds/pending/viaApi/mode 供前端指示条）。
async function syncMainContext(pctx, c, entry, cfg) {
  const lib = await loadLib();
  const sessionPath = await resolveContextSessionPath(pctx, c, entry);
  if (!sessionPath) {
    return { ok: false, error: '未找到主会话', reference: '', stats: { rounds: 0 } };
  }
  const { rounds, viaApi, apiError } = await readMainRounds(pctx, sessionPath);
  const fullCount = lib.completedRounds(rounds);
  const lastRound = rounds[rounds.length - 1];
  const pending = !!(lastRound && lastRound.user && !lastRound.assistant);
  // 读-改-写原子化（REVIEW3 H3）：增量计算与写回在同一索引锁内，
  // 并发窗口不会互相覆盖；重建（慢，含摘要模型调用）在锁外做。
  let res = await (await loadStore()).updateSession(pctx.dataDir, entry.id, (cur) => {
    const ctx = cur.mainCtx;
    // 快照缺失 / 来源会话变化 / 模式变化 → 需要重建（不在此写入，锁外做）
    if (!ctx || ctx.mainSessionPath !== sessionPath || ctx.mode !== cfg.contextMode) return null;
    // M1（REVIEW3）：轮数回退（文件被替换/截断/归档清理）→ 清空触发下次重建，防陈旧残留
    if (fullCount < ctx.lastRoundCount) return { mainCtx: null };
    // 增量追加：只追配对完整的轮次，原文形式追加（序号接着全局编号）
    if (fullCount > ctx.lastRoundCount) {
      const added = rounds.slice(ctx.lastRoundCount, fullCount);
      if (added.length) {
        const append = lib.formatRounds(added, cfg, ctx.lastRoundCount);
        ctx.text = ctx.text ? `${ctx.text}\n\n${append}` : append;
        ctx.lastRoundCount = fullCount;
        return { mainCtx: ctx };
      }
    }
    return null; // 无变化不写
  });
  let mainCtx = res.entry?.mainCtx;
  // 锁内判定需要重建（缺失/来源或模式变化）→ 锁外重建再原子写入
  if (!mainCtx || mainCtx.mainSessionPath !== sessionPath || mainCtx.mode !== cfg.contextMode) {
    const rebuilt = await buildMainSnapshot(pctx, c, cfg, sessionPath);
    res = rebuilt
      ? await (await loadStore()).updateSession(pctx.dataDir, entry.id, () => ({ mainCtx: rebuilt }))
      : res;
    mainCtx = res.entry?.mainCtx ?? rebuilt;
  }
  if (!mainCtx) {
    return {
      ok: true,
      reference: '',
      stats: { rounds: fullCount, viaApi, pending, file: path.basename(sessionPath), ...(apiError ? { apiError } : {}) },
    };
  }
  return {
    ok: true,
    reference: mainCtx.text,
    stats: {
      rounds: fullCount,
      viaApi,
      pending,
      file: path.basename(sessionPath),
      mode: cfg.contextMode,
      snapshot: true,
      lastSynced: mainCtx.lastRoundCount,
      ...(apiError ? { apiError } : {}),
    },
  };
}

// ---------- 主会话统计短 TTL 缓存（REVIEW2） ----------

// /api/state 每 5 秒轮询 + SSE 事件刷新都会调 mainSessionInfo → collectMainContext(skipSummary)，
// 每次都直读主对话 JSONL 文件（无结果时兜底 history API），高频重复读浪费，这里加 10 秒短 TTL。
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
  // 缓存键必须含 sessionPath：host 注入的真实主会话路径（切主对话时它变化，
  // 只含 mainPath 的键会在切主对话后命中旧缓存，最多滞后 10 秒（2026-08-16 审视发现）
  const key = `${requestAgentId(c)}|${c.req.query('mainPath') || ''}|${c.req.query('sessionPath') || ''}|${cfg.contextMode}`;
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
    const mainPath = await (await loadAdapter()).resolveMainSessionPath(pctx, c);
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
  // 过滤空消息（流式分段产物）：assistant 空文本且无思考、user 空文本都不渲染
  // （REVIEW2 发现 20：user 空消息原不过滤，会渲染空气泡）；透传 thinking 供思考块渲染
  return list
    .map((m) => ({
      role: m?.role ?? 'unknown',
      text: typeof m?.content === 'string' ? m.content : (typeof m?.text === 'string' ? m.text : ''),
      thinking: typeof m?.thinking === 'string' ? m.thinking : '',
    }))
    .filter((m) =>
      m.role === 'assistant'
        ? (m.text ?? '').trim() !== '' || (m.thinking ?? '').trim() !== ''
        : m.role === 'user'
          ? (m.text ?? '').trim() !== ''
          : true
    );
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
