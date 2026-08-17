// model-adapter.js —— OpenAI 兼容 Chat Completions 客户端（ModelAdapter，新架构定稿第 6 项）
// 职责：直连 OpenAI 兼容 API（DeepSeek/OpenAI/SiliconFlow/Ollama/OpenRouter 等），
// 流式（stream:true）SSE 解析，提取 content 与 reasoning_content（DeepSeek thinking）。
// 与 lib 其它模块一致的约定：ESM 命名导出、不静态 import 其它 lib 模块、
// 绝不裸 throw（一切失败返回结构化结果 { ok:false, error:{ kind, message, status? } }）。
//
// 错误分类（kind）：
//   network —— fetch 抛错 / 超时（message 注明）
//   http    —— 响应非 2xx（含 status 与响应体摘要）
//   stream  —— 流中断（未收到 [DONE] 提前结束 / reader 读取出错 / 首块即无法解析）
//   abort   —— 调用方 AbortSignal 主动取消
//
// 本版职责边界：流式解析并返回给调用方；「SSE 逐字流到前端」是下一里程碑，
// 届时本模块的解析逻辑可复用（逐块回调预留：chunk 级解析函数独立导出便于测试）。

// ---------- URL 规整 ----------

// 规整 baseUrl（容忍带/不带 /v1、尾部斜杠、甚至完整 /chat/completions 端点）：
//   1. trim + 去尾部斜杠
//   2. 已含 /chat/completions 端点 → 保持原样
//   3. 已含 /v1 后缀（含 /api/v1 等任意前导）→ 保持
//   4. 其余 → 追加 /v1（OpenAI 兼容惯例）
// 非法（空 / 非 http(s)）→ 返回 ''（调用方应视为配置错误）。
export function normalizeBaseUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  s = s.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(s)) return s;
  if (/\/v1$/i.test(s)) return s;
  return `${s}/v1`;
}

// 完整 chat/completions 端点（基于 normalizeBaseUrl；已含端点则直接用）
export function chatCompletionsUrl(raw) {
  const s = normalizeBaseUrl(raw);
  if (!s) return '';
  return /\/chat\/completions$/i.test(s) ? s : `${s}/chat/completions`;
}

// 模型列表端点（测试连接用：GET 轻量验证 baseUrl+key）
export function modelsUrl(raw) {
  const s = normalizeBaseUrl(raw);
  if (!s) return '';
  return `${s}/models`;
}

// ---------- 请求体 ----------

// 组装请求体：{ model, messages, stream:true, ...params }。
// params 为模型级参数透传（temperature/max_tokens/top_p 等），stream 键被强制覆盖。
// 防御：messages 逐项规整（role/content 必须为字符串；非标准项丢弃），
// content 数组形态（多模态预留）原样透传不深究。
export function buildRequestBody({ model, messages, params } = {}) {
  const body = {
    model: str(model),
    messages: Array.isArray(messages)
      ? messages
          .map((m) => {
            if (!m || typeof m !== 'object') return null;
            const role = str(m.role);
            if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
            if (typeof m.content === 'string') return { role, content: m.content };
            if (Array.isArray(m.content)) return { role, content: m.content };
            return null;
          })
          .filter(Boolean)
      : [],
    stream: true,
  };
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (k === 'stream' || v === undefined || v === null) continue;
      body[k] = v;
    }
  }
  return body;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// ---------- SSE 解析 ----------

// 解析单行 SSE：返回 { type, data }。
//   type: 'data'（data: 行，data 为 payload 字符串，[DONE] 已判定为 done）|
//         'done'（data: [DONE]）| 'event'（event: 行，忽略）| 'comment'（: 注释）| null（空行/无法识别）
// 独立导出便于单测（含超长行截断防御）。
export function parseSseLine(line) {
  const s = String(line ?? '').replace(/\r$/, '');
  if (!s.trim()) return null;
  if (s.startsWith(':')) return { type: 'comment', data: '' };
  if (s.startsWith('data:')) {
    const data = s.slice(5).trimStart();
    if (data.trim() === '[DONE]') return { type: 'done', data: '' };
    return { type: 'data', data };
  }
  if (s.startsWith('event:')) return { type: 'event', data: s.slice(6).trim() };
  return null; // 未知行（如 HTTP 头残留）容忍跳过
}

// 从 data 块 JSON 提取增量：{ content, reasoning, usage }。
// delta.content（正文）与 delta.reasoning_content（DeepSeek thinking，兼容 reasoning 别名）。
// 解析失败返回 null（容忍脏块，由调用方决定）。
export function extractDelta(dataJson) {
  try {
    const obj = typeof dataJson === 'string' ? JSON.parse(dataJson) : dataJson;
    if (!obj || typeof obj !== 'object') return null;
    // OpenAI 兼容流错误块：{"error": {...}}
    if (obj.error) return { error: obj.error };
    const delta = obj.choices?.[0]?.delta ?? {};
    return {
      content: typeof delta.content === 'string' ? delta.content : '',
      reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : ''),
      usage: obj.usage && typeof obj.usage === 'object' ? obj.usage : null,
    };
  } catch {
    return null;
  }
}

// ---------- 流式请求 ----------

// 主入口：流式 Chat Completions。
// opts: {
//   baseUrl, apiKey, model,
//   messages: [{ role, content }],
//   params: { temperature, max_tokens, ... },   // 模型级参数透传
//   signal,                                     // 外部 AbortSignal（可选）
//   timeoutMs,                                  // 请求超时（缺省 120000）
//   fetchImpl,                                  // 测试注入；缺省 globalThis.fetch
// }
// 返回：
//   成功 { ok:true, content, reasoning, model, usage? }
//   失败 { ok:false, error:{ kind, message, status? } }
export async function streamChat(opts = {}) {
  const url = chatCompletionsUrl(opts.baseUrl);
  if (!url) return { ok: false, error: { kind: 'usage', message: 'baseUrl 非法或为空' } };
  const model = str(opts.model);
  if (!model) return { ok: false, error: { kind: 'usage', message: 'model 为空' } };
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (!messages.length) return { ok: false, error: { kind: 'usage', message: 'messages 为空' } };

  const apiKey = str(opts.apiKey);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (globalThis.fetch ?? null);
  if (!fetchImpl) return { ok: false, error: { kind: 'network', message: '当前环境无 fetch 可用' } };

  // 内部超时控制器 + 外部信号合并
  const ctrl = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  const outerSignal = opts.signal ?? null;
  if (outerSignal?.aborted) ctrl.abort();
  else outerSignal?.addEventListener?.('abort', onOuterAbort, { once: true });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequestBody({ model, messages, params: opts.params })),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timeoutTimer);
    outerSignal?.removeEventListener?.('abort', onOuterAbort);
    if (timedOut) return { ok: false, error: { kind: 'network', message: `请求超时（${timeoutMs}ms）` } };
    if (outerSignal?.aborted) return { ok: false, error: { kind: 'abort', message: '请求已取消' } };
    return { ok: false, error: { kind: 'network', message: String(e?.message ?? e) } };
  }

  if (!res.ok || (res.status >= 400)) {
    let detail = '';
    try {
      const text = await res.text();
      detail = String(text ?? '').slice(0, 200);
    } catch {
      // 读响应体失败不影响主错误
    }
    clearTimeout(timeoutTimer);
    outerSignal?.removeEventListener?.('abort', onOuterAbort);
    return {
      ok: false,
      error: { kind: 'http', status: res.status ?? 0, message: `HTTP ${res.status ?? '?'}${detail ? `：${detail}` : ''}` },
    };
  }

  // 流式读取 + SSE 解析
  let content = '';
  let reasoning = '';
  let usage = null;
  let sawDone = false;
  let sawAnyChunk = false;
  let parseFailStreak = 0;
  const decoder = new TextDecoder();
  let buf = '';
  let reader = null;
  try {
    reader = res.body?.getReader?.();
    if (!reader) {
      // 无 body（某些 mock/空响应）：读 text 兜底（非流）
      const text = await res.text();
      if (text.trim()) {
        const d = extractDelta(text);
        if (d?.error) return { ok: false, error: { kind: 'http', status: res.status, message: `API 错误：${errText(d.error)}` } };
        if (d) {
          content += d.content ?? '';
          reasoning += d.reasoning ?? '';
          if (d.usage) usage = d.usage;
          sawAnyChunk = true;
        }
      }
      sawDone = true; // 非流响应视为完整
    } else {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (timedOut) return finishStreamError('network', `请求超时（${timeoutMs}ms）`);
          if (outerSignal?.aborted) return finishStreamError('abort', '请求已取消');
          return finishStreamError('stream', `流读取中断：${String(e?.message ?? e)}`);
        }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? ''; // 末段可能不完整，留到下一轮
        for (const line of lines) {
          const parsed = parseSseLine(line);
          if (!parsed) continue;
          if (parsed.type === 'done') {
            sawDone = true;
            break;
          }
          if (parsed.type !== 'data') continue;
          sawAnyChunk = true;
          const d = extractDelta(parsed.data);
          if (!d) {
            parseFailStreak++;
            continue;
          }
          parseFailStreak = 0;
          if (d.error) return finishStreamError('http', `API 错误：${errText(d.error)}`, res.status);
          content += d.content ?? '';
          reasoning += d.reasoning ?? '';
          if (d.usage) usage = d.usage;
        }
        if (sawDone) break;
      }
      if (buf.trim()) {
        // 流末尾残留一行（无换行结尾）
        const parsed = parseSseLine(buf);
        if (parsed?.type === 'done') sawDone = true;
        else if (parsed?.type === 'data') {
          const d = extractDelta(parsed.data);
          if (d?.error) return finishStreamError('http', `API 错误：${errText(d.error)}`, res.status);
          if (d) {
            content += d.content ?? '';
            reasoning += d.reasoning ?? '';
            if (d.usage) usage = d.usage;
          }
        }
      }
    }
  } finally {
    clearTimeout(timeoutTimer);
    outerSignal?.removeEventListener?.('abort', onOuterAbort);
  }

  if (!sawDone) {
    // 流提前结束（未收到 [DONE]）：有内容则部分返回 + 标记截断，无内容报错
    if (!sawAnyChunk && !content && !reasoning) {
      return { ok: false, error: { kind: 'stream', message: '流中断：连接提前结束，未收到任何内容' } };
    }
    return {
      ok: true,
      content,
      reasoning,
      model,
      usage,
      truncated: true, // 调用方可感知截断
    };
  }
  return { ok: true, content, reasoning, model, usage };

  function finishStreamError(kind, message, status) {
    return { ok: false, error: { kind, message, ...(status ? { status } : {}) } };
  }
}

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const m = err?.message ?? '';
  return str(m).slice(0, 200) || JSON.stringify(err).slice(0, 200);
}

// ---------- 测试连接 ----------

// 轻量连通性验证：GET {规整 baseUrl}/models（Ollama/DeepSeek/OpenAI 兼容端点均支持）。
// 返回 { ok:true, status, models（模型 id 数组，最多 20 个）} 或 { ok:false, error:{ kind, message, status? } }。
// 绝不 throw。
export async function testConnection({ baseUrl, apiKey, timeoutMs, fetchImpl } = {}) {
  const url = modelsUrl(baseUrl);
  if (!url) return { ok: false, error: { kind: 'usage', message: 'baseUrl 非法或为空' } };
  const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
  const f = typeof fetchImpl === 'function' ? fetchImpl : (globalThis.fetch ?? null);
  if (!f) return { ok: false, error: { kind: 'network', message: '当前环境无 fetch 可用' } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), t);
  try {
    const headers = {};
    const key = str(apiKey);
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await f(url, { method: 'GET', headers, signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try {
        detail = String(await res.text()).slice(0, 200);
      } catch {
        // 忽略
      }
      return { ok: false, error: { kind: 'http', status: res.status ?? 0, message: `HTTP ${res.status ?? '?'}${detail ? `：${detail}` : ''}` } };
    }
    let models = [];
    try {
      const body = await res.json();
      models = (Array.isArray(body?.data) ? body.data : [])
        .map((m) => (typeof m === 'string' ? m : str(m?.id)))
        .filter(Boolean)
        .slice(0, 20);
    } catch {
      // 响应非 JSON 仍视为连通（部分网关返回 200 但空 body）
    }
    return { ok: true, status: res.status ?? 200, models };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'network',
        message: ctrl.signal.aborted ? `连接超时（${t}ms）` : String(e?.message ?? e),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
