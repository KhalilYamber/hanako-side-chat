// provider-store.js —— 插件独立供应商配置管理（ProviderStore，新架构定稿第 6 项）
// 职责：providers 列表的读写（CRUD）、预置模板、默认供应商/模型解析。
// 存储：config 属性（manifest 已声明，REVIEW3 H1 教训）：
//   providersJson（string，providers 数组的 JSON 序列化，明文本地存储，密钥仅存本机）、
//   defaultProviderId（string）、defaultModel（string）。
// 与 lib 其它模块一致的约定：ESM 命名导出、不静态 import 其它 lib 模块、
// 绝不 throw 阻断主流程（任何一步失败返回空结构或 { ok:false, error }，由调用方决定策略）。

// ---------- 预置模板（用户确认清单 2026-08-17） ----------

// builtin 语义：仅「创建时预填」，不锁定不特权；模板可被用户编辑
// （改 baseUrl/模型列表），编辑后仍属该 provider，builtin 标记仅作展示。
export const PRESET_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    builtin: true,
    protocol: 'openai',
    enabled: true,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', params: { temperature: 0.7 } },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', params: {} },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    builtin: true,
    protocol: 'openai',
    enabled: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', params: {} },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', params: {} },
    ],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    builtin: true,
    protocol: 'openai',
    enabled: true,
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', params: {} },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1', params: {} },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B-Instruct', params: {} },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    builtin: true,
    protocol: 'openai',
    enabled: true,
    models: [], // 本地模型列表由用户自填（ollama list 的结果，无 key）
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    builtin: true,
    protocol: 'openai',
    enabled: true,
    models: [
      { id: 'openai/gpt-4o', name: 'GPT-4o', params: {} },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', params: {} },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', params: {} },
    ],
  },
];

const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const URL_RE = /^https?:\/\/[^\s]{1,2048}$/i;
const MAX_MODELS = 100;

// ---------- 内部工具 ----------

function str(v) {
  return typeof v === 'string' ? v : '';
}

function bool(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

function clone(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

// 写队列：config.setMany 读-改-写原子化（并发窗口防丢失更新，与 store.js 同思路）
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

// 读 config（容错）：get 缺省/失败返回 null
async function readConfig(pctx) {
  try {
    if (pctx?.config?.get) {
      const cur = await pctx.config.get();
      return cur && typeof cur === 'object' ? cur : null;
    }
  } catch {
    // 读取失败按无配置处理
  }
  return null;
}

// 从 config 解析 providersJson 字段（容错：损坏按空数组）
function parseProvidersJson(cur) {
  const raw = cur?.providersJson;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 单 provider 校验/规整：返回规整后的对象，非法返回 null（不 throw）。
// 字段规则：
//   id：必填，[A-Za-z0-9_-] 1..64（限制字符集，避免 URL/路径编码问题）
//   name：缺省用 id；baseUrl：必填，http(s) 开头（防 javascript: 等协议注入）
//   apiKey：任意字符串（明文本机存储，可空）；builtin/enabled：布尔
//   protocol：缺省 'openai'（第一版恒 openai，Anthropic/Gemini 原生协议预留）
//   models：数组，每项 { id（必填非空串）, name（缺省=id）, params（对象） }，上限 100
export function sanitizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id).trim();
  if (!PROVIDER_ID_RE.test(id)) return null;
  const baseUrl = str(raw.baseUrl).trim();
  if (!URL_RE.test(baseUrl)) return null;
  const name = str(raw.name).trim() || id;
  const models = [];
  if (Array.isArray(raw.models)) {
    for (const m of raw.models.slice(0, MAX_MODELS)) {
      if (!m || typeof m !== 'object') continue;
      const mid = str(m.id).trim();
      if (!mid) continue;
      const p = m.params && typeof m.params === 'object' ? clone(m.params) : {};
      models.push({ id: mid, name: str(m.name).trim() || mid, params: p ?? {} });
    }
  }
  return {
    id,
    name,
    baseUrl,
    apiKey: str(raw.apiKey),
    builtin: bool(raw.builtin, false),
    protocol: str(raw.protocol).trim() || 'openai',
    enabled: bool(raw.enabled, true),
    models,
  };
}

// ---------- 主入口（读写） ----------

// 读取完整供应商配置：{ providers, defaultProviderId, defaultModel }。
// config 不可用 / 数据损坏 → 空结构（不 throw）。providers 经 sanitize 逐项过滤。
export async function loadProviders(pctx) {
  const cur = await readConfig(pctx);
  const providers = parseProvidersJson(cur)
    .map(sanitizeProvider)
    .filter(Boolean);
  return {
    providers,
    defaultProviderId: str(cur?.defaultProviderId).trim(),
    defaultModel: str(cur?.defaultModel).trim(),
  };
}

// 默认选择有效性规整：defaultProviderId 必须存在且 enabled，否则清空；
// defaultModel 必须属于该供应商的模型列表，否则清空（由保存路径统一执行）。
function normalizeDefaults(providers, defaultProviderId, defaultModel) {
  let pid = str(defaultProviderId).trim();
  let mid = str(defaultModel).trim();
  const p = providers.find((x) => x.id === pid && x.enabled);
  if (!p) {
    pid = '';
    mid = '';
  } else if (!p.models.some((m) => m.id === mid)) {
    mid = '';
  }
  return { defaultProviderId: pid, defaultModel: mid };
}

// 写三个配置字段的公共封装（省去各处重复拼 setMany）
async function writeAll(pctx, providers, defaults) {
  const d = normalizeDefaults(providers, defaults.defaultProviderId, defaults.defaultModel);
  await pctx.config.setMany({
    providersJson: JSON.stringify(providers),
    defaultProviderId: d.defaultProviderId,
    defaultModel: d.defaultModel,
  });
  return d;
}

// 整体保存。data: { providers?, defaultProviderId?, defaultModel? }。
// apiKey 合并规则：新对象缺省 apiKey 字段（undefined）且原配置有同 id provider
// → 保留原 key（GET 接口脱敏返回后前端整体 PUT 不会丢密钥）；
// 显式提供（含空串/null）→ 以新值为准（空串/null = 清空密钥）。
// 返回 { ok:true } 或 { ok:false, error }。失败不 throw。
export async function saveProviders(pctx, data = {}) {
  if (!pctx?.config?.setMany) return { ok: false, error: 'config 通道不可用' };
  return withWriteLock(async () => {
    try {
      const cur = await readConfig(pctx);
      const oldProviders = parseProvidersJson(cur).map(sanitizeProvider).filter(Boolean);
      const oldByKey = new Map(oldProviders.map((p) => [p.id, p]));
      const newProviders = Array.isArray(data.providers) ? data.providers : oldProviders;
      const providers = [];
      const seen = new Set();
      for (const raw of newProviders) {
        const p = sanitizeProvider(raw);
        if (!p) continue;
        if (seen.has(p.id)) continue; // 同 id 去重（保留首个）
        seen.add(p.id);
        // apiKey 合并：字段缺省且原配置有同 id → 继承原 key
        if (raw.apiKey === undefined && oldByKey.has(p.id)) {
          p.apiKey = oldByKey.get(p.id).apiKey ?? '';
        }
        providers.push(p);
      }
      const defaultProviderId = str(data.defaultProviderId).trim();
      const defaultModel = str(data.defaultModel).trim();
      const d = await writeAll(pctx, providers, { defaultProviderId, defaultModel });
      // 红队 2026-08-17 P2-6：回传规整后的 defaults（前端拿到清空后的真实值，
      // 避免显示与持久化不一致）
      return { ok: true, providers, ...d };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

// 只更新默认选择（模型切换下拉用，不触碰 providers 列表）
// 红队 2026-08-17 P2-5：写入前须过 normalizeDefaults 校验（防脏默认值：
// 已删/已禁用 provider 的 id、不存在的模型），与 saveProviders 口径一致。
export async function saveDefaults(pctx, { defaultProviderId, defaultModel } = {}) {
  if (!pctx?.config?.setMany) return { ok: false, error: 'config 通道不可用' };
  return withWriteLock(async () => {
    try {
      const cur = await readConfig(pctx);
      if (!cur) return { ok: false, error: 'config 通道不可用' };
      const providers = parseProvidersJson(cur).map(sanitizeProvider).filter(Boolean);
      const d = normalizeDefaults(providers, str(defaultProviderId).trim(), str(defaultModel).trim());
      await pctx.config.setMany(d);
      return { ok: true, ...d };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

// 列表（loadProviders 的薄封装，返回 providers 数组）
export async function listProviders(pctx) {
  return (await loadProviders(pctx)).providers;
}

// 按 id 取单个 provider；不存在返回 null
export async function getProvider(pctx, id) {
  const key = str(id);
  if (!key) return null;
  return (await loadProviders(pctx)).providers.find((p) => p.id === key) ?? null;
}

// 新增或更新单个 provider（读-改-写在写锁内完成）。
// apiKey 合并规则同 saveProviders：字段缺省且原存在 → 保留原 key。
export async function upsertProvider(pctx, provider) {
  if (!pctx?.config?.setMany) return { ok: false, error: 'config 通道不可用' };
  return withWriteLock(async () => {
    try {
      const cur = await readConfig(pctx);
      if (!cur) return { ok: false, error: 'config 通道不可用' };
      const list = parseProvidersJson(cur).map(sanitizeProvider).filter(Boolean);
      const i = list.findIndex((p) => p.id === str(provider?.id));
      if (i >= 0) {
        if (provider?.apiKey === undefined) {
          provider = { ...provider, apiKey: list[i].apiKey ?? '' };
        }
        list[i] = sanitizeProvider(provider) ?? list[i];
      } else {
        const p = sanitizeProvider(provider);
        if (!p) return { ok: false, error: '供应商字段非法' };
        list.push(p);
      }
      await writeAll(pctx, list, { defaultProviderId: cur.defaultProviderId ?? '', defaultModel: cur.defaultModel ?? '' });
      return { ok: true, provider: list[i >= 0 ? i : list.length - 1] };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

// 删除单个 provider；若它是默认供应商则一并清空默认选择。
// 返回 { ok:true, removed:true } / { ok:true, removed:false }（不存在）/ { ok:false, error }。
export async function removeProvider(pctx, id) {
  if (!pctx?.config?.setMany) return { ok: false, error: 'config 通道不可用' };
  return withWriteLock(async () => {
    try {
      const cur = await readConfig(pctx);
      if (!cur) return { ok: false, error: 'config 通道不可用' };
      const providers = parseProvidersJson(cur).map(sanitizeProvider).filter(Boolean);
      const key = str(id);
      const next = providers.filter((p) => p.id !== key);
      if (next.length === providers.length) return { ok: true, removed: false };
      await writeAll(pctx, next, { defaultProviderId: cur.defaultProviderId ?? '', defaultModel: cur.defaultModel ?? '' });
      return { ok: true, removed: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

// ---------- 预置模板 ----------

// 模板深拷贝；未知 id 返回 null（不 throw）
export function presetTemplate(id) {
  const t = PRESET_PROVIDERS.find((p) => p.id === id);
  return t ? clone(t) : null;
}

// ---------- 默认解析 ----------

// 解析实际使用的默认供应商与模型（配置优先，逐级兜底）：
//   1. defaultProviderId 指定的 provider（enabled）→ 其 defaultModel（enabled 的模型）
//   2. defaultProviderId 无效 → 第一个 enabled provider → 其第一个模型
//   3. 无任何可用 provider → { provider: null, model: null }
// 返回 { provider（sanitize 后对象或 null）, model（模型对象或 null）, providerId, modelId }。
// 绝不 throw：任何异常路径返回全 null 结构。
export async function resolveDefault(pctx) {
  try {
    const cur = await loadProviders(pctx);
    const enabled = cur.providers.filter((p) => p.enabled);
    if (!enabled.length) return { provider: null, model: null, providerId: '', modelId: '' };
    let provider = enabled.find((p) => p.id === cur.defaultProviderId) ?? null;
    if (!provider) provider = enabled[0];
    let model = null;
    if (cur.defaultModel && provider.id === cur.defaultProviderId) {
      model = provider.models.find((m) => m.id === cur.defaultModel) ?? null;
    }
    if (!model) model = provider.models[0] ?? null;
    return {
      provider,
      model,
      providerId: provider?.id ?? '',
      modelId: model?.id ?? '',
    };
  } catch {
    return { provider: null, model: null, providerId: '', modelId: '' };
  }
}
