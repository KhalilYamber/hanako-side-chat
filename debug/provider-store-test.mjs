// provider-store-test.mjs —— ProviderStore（lib/provider-store.js）最小验证
// 纯逻辑单测：mock pctx.config（get/setMany 内存实现），验证：
//   1. 空配置 / config 异常 → 容错空结构，绝不 throw
//   2. saveProviders 整体写读回 + apiKey 合并规则（缺省保留 / 空串清空 / null 清空）
//   3. upsertProvider 新增与更新、removeProvider 删除（含默认选择联动清理）
//   4. 预置模板：数量 5、presetTemplate 深拷贝、未知 id 返回 null
//   5. resolveDefault 逐级兜底（配置优先 → 第一个可用 → 无配置）
//   6. sanitizeProvider 校验（非法 id/baseUrl 拒绝、models 规整、上限）
//   7. 默认选择有效性规整（defaultProviderId/defaultModel 失效自动清空）
//   8. setMany 失败 → { ok:false }，不 throw
// 用法：node debug/provider-store-test.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ps = await import(`../lib/provider-store.js?t=${Date.now()}`);

// ---------- mock config ----------

function mockConfig(initial = {}) {
  const store = { ...initial };
  return {
    store,
    pctx: {
      config: {
        async get() {
          return { ...store };
        },
        async setMany(updates) {
          Object.assign(store, updates);
        },
      },
    },
  };
}

// config.get 抛错的 pctx（模拟 host 通道故障）
const BROKEN_PCTX = {
  config: {
    async get() {
      throw new Error('config down');
    },
    async setMany() {
      throw new Error('config down');
    },
  },
};

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

const DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test-123',
  builtin: true,
  protocol: 'openai',
  enabled: true,
  models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', params: { temperature: 0.7 } }],
};

// ---------- 用例 ----------

// 1. 空配置 → 空结构
{
  const { pctx } = mockConfig();
  const r = await ps.loadProviders(pctx);
  check('1.1 空配置：providers 空数组', Array.isArray(r.providers) && r.providers.length === 0);
  check('1.2 空配置：defaultProviderId 空', r.defaultProviderId === '');
  check('1.3 空配置：defaultModel 空', r.defaultModel === '');
}

// 2. config 通道故障 → 容错空结构，不 throw
{
  const r = await ps.loadProviders(BROKEN_PCTX);
  check('2.1 config.get 抛错：providers 空数组', Array.isArray(r.providers) && r.providers.length === 0);
  const r2 = await ps.saveProviders(BROKEN_PCTX, { providers: [DEEPSEEK] });
  check('2.2 config.setMany 抛错：{ ok:false }', r2.ok === false && typeof r2.error === 'string', JSON.stringify(r2));
  const r3 = await ps.saveDefaults(BROKEN_PCTX, { defaultProviderId: 'x' });
  check('2.3 saveDefaults 抛错：{ ok:false }', r3.ok === false);
  const r4 = await ps.upsertProvider(BROKEN_PCTX, DEEPSEEK);
  check('2.4 upsertProvider 抛错：{ ok:false }', r4.ok === false);
  const r5 = await ps.removeProvider(BROKEN_PCTX, 'deepseek');
  check('2.5 removeProvider 抛错：{ ok:false }', r5.ok === false && typeof r5.error === 'string', JSON.stringify(r5));
  const r6 = await ps.resolveDefault(BROKEN_PCTX);
  check('2.6 resolveDefault 抛错：全空结构', r6.provider === null && r6.providerId === '');
}

// 3. saveProviders 写读回 + 默认规整
{
  const { store, pctx } = mockConfig();
  const res = await ps.saveProviders(pctx, {
    providers: [DEEPSEEK],
    defaultProviderId: 'deepseek',
    defaultModel: 'deepseek-chat',
  });
  check('3.1 保存成功 { ok:true }', res.ok === true);
  const r = await ps.loadProviders(pctx);
  check('3.2 读回：providers 1 个', r.providers.length === 1);
  check('3.3 读回：apiKey 明文保留', r.providers[0].apiKey === 'sk-test-123');
  check('3.4 读回：defaultProviderId', r.defaultProviderId === 'deepseek');
  check('3.5 读回：defaultModel', r.defaultModel === 'deepseek-chat');
  check('3.6 providersJson 为 JSON 字符串', typeof store.providersJson === 'string' && JSON.parse(store.providersJson).length === 1);
}

// 4. apiKey 合并规则：缺省保留 / 空串清空 / null 清空
{
  const { pctx } = mockConfig();
  await ps.saveProviders(pctx, { providers: [DEEPSEEK] });
  // 4a. 缺省 apiKey 字段 → 保留
  const { id, apiKey, ...noKey } = DEEPSEEK;
  await ps.saveProviders(pctx, { providers: [{ ...noKey, id }] });
  let r = await ps.loadProviders(pctx);
  check('4.1 apiKey 字段缺省：保留原 key', r.providers[0].apiKey === 'sk-test-123');
  // 4b. 空串 → 清空
  await ps.saveProviders(pctx, { providers: [{ ...DEEPSEEK, apiKey: '' }] });
  r = await ps.loadProviders(pctx);
  check('4.2 apiKey 空串：清空', r.providers[0].apiKey === '');
  // 4c. null → 清空
  await ps.saveProviders(pctx, { providers: [{ ...DEEPSEEK, apiKey: null }] });
  r = await ps.loadProviders(pctx);
  check('4.3 apiKey null：清空', r.providers[0].apiKey === '');
}

// 5. upsertProvider：新增 + 更新（apiKey 缺省保留）
{
  const { pctx } = mockConfig();
  const res1 = await ps.upsertProvider(pctx, DEEPSEEK);
  check('5.1 upsert 新增成功', res1.ok === true && res1.provider.id === 'deepseek');
  const res2 = await ps.upsertProvider(pctx, { ...DEEPSEEK, name: 'DeepSeek 改名' });
  check('5.2 upsert 更新：name 生效', res2.ok === true && res2.provider.name === 'DeepSeek 改名');
  check('5.3 upsert 更新：apiKey 缺省保留', res2.provider.apiKey === 'sk-test-123');
  const r = await ps.loadProviders(pctx);
  check('5.4 upsert 后列表仍 1 个（无重复）', r.providers.length === 1);
  const bad = await ps.upsertProvider(pctx, { id: 'bad id!', name: 'x', baseUrl: 'https://x.com/v1' });
  check('5.5 upsert 非法 id：{ ok:false }', bad.ok === false);
}

// 6. removeProvider：删除 / 删除默认联动清空 / 不存在
{
  const { pctx } = mockConfig();
  await ps.saveProviders(pctx, { providers: [DEEPSEEK], defaultProviderId: 'deepseek', defaultModel: 'deepseek-chat' });
  const r0 = await ps.removeProvider(pctx, 'nope');
  check('6.1 remove 不存在：removed:false 且 ok', r0.ok === true && r0.removed === false);
  const r1 = await ps.removeProvider(pctx, 'deepseek');
  check('6.2 remove 成功：removed:true', r1.ok === true && r1.removed === true);
  const r = await ps.loadProviders(pctx);
  check('6.3 remove 后列表空', r.providers.length === 0);
  check('6.4 remove 默认供应商：defaultProviderId 清空', r.defaultProviderId === '');
  check('6.5 remove 默认供应商：defaultModel 清空', r.defaultModel === '');
}

// 7. 预置模板
{
  check('7.1 预置模板数量 5', ps.PRESET_PROVIDERS.length === 5, `got ${ps.PRESET_PROVIDERS.length}`);
  const ids = ps.PRESET_PROVIDERS.map((p) => p.id);
  check('7.2 模板 id 齐全', ['deepseek', 'openai', 'siliconflow', 'ollama', 'openrouter'].every((i) => ids.includes(i)), ids.join(','));
  check('7.3 模板 baseUrl 带 /v1', ps.PRESET_PROVIDERS.every((p) => /\/v1$/.test(p.baseUrl)), ps.PRESET_PROVIDERS.map((p) => p.baseUrl).join(','));
  const t = ps.presetTemplate('deepseek');
  check('7.4 presetTemplate 返回深拷贝', t && t.id === 'deepseek' && t !== ps.PRESET_PROVIDERS[0] && t.models !== ps.PRESET_PROVIDERS[0].models);
  t.models.push({ id: 'evil', name: 'evil', params: {} });
  check('7.5 模板副本修改不影响原模板', ps.PRESET_PROVIDERS[0].models.length === 2);
  check('7.6 presetTemplate 未知 id：null', ps.presetTemplate('nope') === null);
  check('7.7 模板均无密钥', ps.PRESET_PROVIDERS.every((p) => (p.apiKey ?? '') === ''));
}

// 8. resolveDefault 逐级兜底
{
  // 8.1 无配置 → 全 null
  const r0 = await ps.resolveDefault(mockConfig().pctx);
  check('8.1 无配置：provider null', r0.provider === null && r0.providerId === '');
  // 8.2 配置指定 → 取指定
  const a = mockConfig();
  await ps.saveProviders(a.pctx, { providers: [DEEPSEEK, { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', builtin: true, protocol: 'openai', enabled: true, models: [{ id: 'gpt-4o', name: 'GPT-4o', params: {} }] }], defaultProviderId: 'openai', defaultModel: 'gpt-4o' });
  const r2 = await ps.resolveDefault(a.pctx);
  check('8.2 指定默认：providerId=openai', r2.providerId === 'openai');
  check('8.3 指定默认：modelId=gpt-4o', r2.modelId === 'gpt-4o');
  // 8.4 defaultProviderId 失效 → 兜底第一个 enabled
  const b = mockConfig();
  await ps.saveProviders(b.pctx, { providers: [DEEPSEEK], defaultProviderId: 'ghost', defaultModel: 'x' });
  const r4 = await ps.resolveDefault(b.pctx);
  check('8.4 默认失效兜底第一个：deepseek', r4.providerId === 'deepseek');
  // 8.5 defaultModel 不存在 → 兜底该供应商第一个模型
  const c = mockConfig();
  await ps.saveProviders(c.pctx, { providers: [DEEPSEEK], defaultProviderId: 'deepseek', defaultModel: 'ghost-model' });
  const r5 = await ps.resolveDefault(c.pctx);
  check('8.5 默认模型失效兜底第一个模型：deepseek-chat', r5.modelId === 'deepseek-chat');
  // 8.6 全部禁用 → 全 null
  const d = mockConfig();
  await ps.saveProviders(d.pctx, { providers: [{ ...DEEPSEEK, enabled: false }] });
  const r6 = await ps.resolveDefault(d.pctx);
  check('8.6 全部禁用：全 null', r6.provider === null && r6.providerId === '');
  // 8.7 供应商无模型 → provider 有、model null
  const e = mockConfig();
  await ps.saveProviders(e.pctx, { providers: [{ ...DEEPSEEK, models: [] }] });
  const r7 = await ps.resolveDefault(e.pctx);
  check('8.7 无模型供应商：modelId 空', r7.providerId === 'deepseek' && r7.modelId === '');
}

// 9. sanitizeProvider 校验
{
  check('9.1 非法 id（含空格）→ null', ps.sanitizeProvider({ id: 'bad id', baseUrl: 'https://x.com/v1' }) === null);
  check('9.2 非法 id（超长）→ null', ps.sanitizeProvider({ id: 'x'.repeat(65), baseUrl: 'https://x.com/v1' }) === null);
  check('9.3 非 http(s) baseUrl → null', ps.sanitizeProvider({ id: 'x', baseUrl: 'javascript:alert(1)' }) === null);
  check('9.4 空 baseUrl → null', ps.sanitizeProvider({ id: 'x', baseUrl: '' }) === null);
  const s = ps.sanitizeProvider({ id: ' x ', name: '  ', baseUrl: ' https://x.com/v1/ ', models: [{ id: 'm1' }, { id: 'm2', name: 'M2' }, { id: '' }, 'junk'], enabled: 1 });
  check('9.5 规整：id trim、name 缺省=id', s.id === 'x' && s.name === 'x');
  check('9.6 规整：baseUrl trim（尾部斜杠保留，由 model-adapter 规整）', s.baseUrl === 'https://x.com/v1/', s.baseUrl);
  check('9.7 规整：models 过滤空 id/非法项', s.models.length === 2, JSON.stringify(s.models));
  check('9.8 规整：models name 缺省=id', s.models[0].name === 'm1');
  check('9.9 规整：enabled 非布尔回落 true', s.enabled === true);
  check('9.10 规整：protocol 缺省 openai', s.protocol === 'openai');
  const big = ps.sanitizeProvider({ id: 'big', baseUrl: 'https://x.com/v1', models: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` })) });
  check('9.11 models 上限 100', big.models.length === 100);
}

// 10. 默认选择有效性规整（保存时失效自动清空）
{
  const { pctx } = mockConfig();
  await ps.saveProviders(pctx, { providers: [DEEPSEEK], defaultProviderId: 'ghost', defaultModel: 'ghost-model' });
  const r = await ps.loadProviders(pctx);
  check('10.1 defaultProviderId 不存在：保存后清空', r.defaultProviderId === '');
  check('10.2 defaultModel 一并清空', r.defaultModel === '');
  await ps.saveProviders(pctx, { providers: [DEEPSEEK], defaultProviderId: 'deepseek', defaultModel: 'ghost-model' });
  const r2 = await ps.loadProviders(pctx);
  check('10.3 defaultModel 不存在：保存后清空', r2.defaultProviderId === 'deepseek' && r2.defaultModel === '');
}

// 11. 损坏的 providersJson → 容错空
{
  const { pctx } = mockConfig({ providersJson: '{broken json' });
  const r = await ps.loadProviders(pctx);
  check('11.1 损坏 JSON：providers 空数组', Array.isArray(r.providers) && r.providers.length === 0);
  const { pctx: p2 } = mockConfig({ providersJson: '{"not":"array"}' });
  const r2 = await ps.loadProviders(p2);
  check('11.2 非数组 JSON：providers 空数组', Array.isArray(r2.providers) && r2.providers.length === 0);
  // 数组中混入非法项 → 逐项过滤
  const { pctx: p3 } = mockConfig({ providersJson: JSON.stringify([DEEPSEEK, { id: 'bad id', baseUrl: 'x' }, null]) });
  const r3 = await ps.loadProviders(p3);
  check('11.3 混入非法项：逐项过滤', r3.providers.length === 1 && r3.providers[0].id === 'deepseek');
}

// 12. 并发写：两个 upsert 同时进行不丢更新
{
  const { pctx } = mockConfig();
  await Promise.all([
    ps.upsertProvider(pctx, { ...DEEPSEEK, apiKey: 'key-a' }),
    ps.upsertProvider(pctx, { ...DEEPSEEK, apiKey: 'key-b' }),
  ]);
  const r = await ps.loadProviders(pctx);
  check('12.1 并发 upsert 同 id：列表仍 1 个', r.providers.length === 1);
  await Promise.all([
    ps.upsertProvider(pctx, { id: 'p1', name: 'P1', baseUrl: 'https://p1.com/v1' }),
    ps.upsertProvider(pctx, { id: 'p2', name: 'P2', baseUrl: 'https://p2.com/v1' }),
  ]);
  const r2 = await ps.loadProviders(pctx);
  check('12.2 并发 upsert 不同 id：两个都在', r2.providers.length === 3 && r2.providers.some((p) => p.id === 'p1') && r2.providers.some((p) => p.id === 'p2'));
}

// 13. 空 pctx / 无 config → 容错（绝不 throw 契约）
{
  const r = await ps.loadProviders({});
  check('13.1 无 config：空结构', Array.isArray(r.providers) && r.providers.length === 0);
  const r2 = await ps.saveProviders({}, { providers: [DEEPSEEK] });
  check('13.2 无 config：{ ok:false }', r2.ok === false);
  const r3 = await ps.resolveDefault(null);
  check('13.3 resolveDefault(null)：全 null', r3.provider === null);
  const r4 = await ps.getProvider({}, 'x');
  check('13.4 getProvider 无 config：null', r4 === null);
}

// ---------- 汇总 ----------

console.log(`\n---- ${passed}/${passed + failed} PASS ----`);
process.exit(failed ? 1 : 0);
