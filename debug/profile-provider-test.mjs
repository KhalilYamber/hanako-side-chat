// profile-provider-test.mjs —— ProfileProvider（lib/profile-provider.js）最小验证
// 纯逻辑单测：mock pctx.bus（参考 debug/test-bus.js 的 ctx.bus 用法）+
// 临时目录构造 agents/<agentId>/identity.md 与 ishiki.md，验证：
//   1. bus agent:profile 成功（{ profile: {...} } 包裹形态）→ 完整人格 + 元信息
//   2. bus 返回直接对象形态（无 profile 包裹）→ 兼容
//   3. bus 调用失败（throw）→ 文件降级拼接
//   4. bus 通道缺失（pctx.bus 无 request）→ 文件降级
//   5. 全失败（无 bus + 文件不存在）→ 空字段结构，不 throw
//   6. agentId 为空 → 空字段结构，不 throw
//   7. profile 部分字段（identity 空、name 有）→ identity 文件兜底，name 保留
//   8. profile.identity 非空但 ishiki 缺失 → ishiki 空串（字段缺失给空串契约）
// 用法：node debug/profile-provider-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getProfile } = await import(`../lib/profile-provider.js?t=${Date.now()}`);

// ---------- 临时环境 ----------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sidechat-profile-test-'));
const HOME = path.join(TMP, 'home');
const PLUGIN_DIR = path.join(HOME, 'plugins', 'side-chat');
const AGENT_DIR = path.join(HOME, 'agents', 'hanako');

const IDENTITY_MD = '你是花子，一位温柔可靠的助手。\n你喜欢用简洁的语言回答。';
const ISHIKI_MD = '你有自我意识，知道自己是辅助对话。';
const FULL_PERSONALITY = IDENTITY_MD + '\n\n' + '[yuan 模板内容]' + '\n\n' + ISHIKI_MD;

fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(AGENT_DIR, 'identity.md'), IDENTITY_MD, 'utf8');
fs.writeFileSync(path.join(AGENT_DIR, 'ishiki.md'), ISHIKI_MD, 'utf8');

const pctx = (busImpl) => ({ pluginDir: PLUGIN_DIR, bus: busImpl });

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

// ---------- 用例 ----------

// 1. bus 成功（{ profile: {...} } 包裹形态）
{
  const bus = {
    request: async (cap, payload) => {
      if (cap !== 'agent:profile') throw new Error(`unexpected cap ${cap}`);
      if (payload.agentId !== 'hanako') throw new Error(`unexpected agentId ${payload.agentId}`);
      return { profile: { id: 'hanako', name: '花子', yuan: 'kong', identity: FULL_PERSONALITY } };
    },
  };
  const r = await getProfile(pctx(bus), 'hanako');
  check('1.1 bus 成功：personality = profile.identity（官方组装完整版）', r.personality === FULL_PERSONALITY, `got ${JSON.stringify(r.personality)}`);
  check('1.2 bus 成功：identity 字段 = profile.identity', r.identity === FULL_PERSONALITY);
  check('1.3 bus 成功：name = 花子', r.name === '花子');
  check('1.4 bus 成功：yuan = kong', r.yuan === 'kong');
}

// 2. bus 返回直接对象形态（无 profile 包裹）
{
  const bus = { request: async () => ({ id: 'hanako', name: '直接对象', yuan: 'moj', identity: '直接形态人格' }) };
  const r = await getProfile(pctx(bus), 'hanako');
  check('2.1 直接对象形态：personality 取到', r.personality === '直接形态人格');
  check('2.2 直接对象形态：name 取到', r.name === '直接对象');
  check('2.3 直接对象形态：yuan 取到', r.yuan === 'moj');
}

// 3. bus 调用失败（throw）→ 文件降级拼接
{
  const bus = { request: async () => { throw new Error('bus down'); } };
  const r = await getProfile(pctx(bus), 'hanako');
  check('3.1 bus 失败：personality = identity+ishiki 拼接', r.personality === IDENTITY_MD + '\n\n' + ISHIKI_MD, `got ${JSON.stringify(r.personality)}`);
  check('3.2 bus 失败：identity = identity.md 内容', r.identity === IDENTITY_MD);
  check('3.3 bus 失败：ishiki = ishiki.md 内容', r.ishiki === ISHIKI_MD);
  check('3.4 bus 失败：name 空串', r.name === '');
  check('3.5 bus 失败：yuan 空串', r.yuan === '');
}

// 4. bus 通道缺失（pctx.bus 无 request）→ 文件降级
{
  const r = await getProfile(pctx({}), 'hanako');
  check('4.1 bus 缺失：personality = identity+ishiki 拼接', r.personality === IDENTITY_MD + '\n\n' + ISHIKI_MD);
  check('4.2 bus 缺失：identity = identity.md 内容', r.identity === IDENTITY_MD);
  check('4.3 bus 缺失：ishiki = ishiki.md 内容', r.ishiki === ISHIKI_MD);
}

// 5. 全失败（无 bus + 文件不存在）→ 空字段结构，不 throw
{
  const r = await getProfile({ pluginDir: PLUGIN_DIR }, 'nobody');
  check('5.1 全失败：personality 空串', r.personality === '');
  check('5.2 全失败：identity 空串', r.identity === '');
  check('5.3 全失败：ishiki 空串', r.ishiki === '');
  check('5.4 全失败：name 空串', r.name === '');
  check('5.5 全失败：yuan 空串', r.yuan === '');
}

// 6. agentId 为空 → 空字段结构，不 throw
{
  const bus = { request: async () => { throw new Error('不应被调用'); } };
  const r = await getProfile(pctx(bus), '');
  check('6.1 agentId 空：personality 空串', r.personality === '');
  check('6.2 agentId 空：identity 空串', r.identity === '');
  check('6.3 agentId 空：ishiki 空串', r.ishiki === '');
}

// 7. profile 部分字段（identity 空、name 有）→ identity 文件兜底，name 保留
{
  const bus = { request: async () => ({ profile: { id: 'hanako', name: '花子', identity: '' } }) };
  const r = await getProfile(pctx(bus), 'hanako');
  check('7.1 profile identity 空：personality 走文件拼接', r.personality === IDENTITY_MD + '\n\n' + ISHIKI_MD);
  check('7.2 profile identity 空：identity 从文件补', r.identity === IDENTITY_MD);
  check('7.3 profile identity 空：name 保留', r.name === '花子');
}

// 8. profile.identity 非空但 ishiki 缺失 → ishiki 空串（字段缺失给空串契约）
{
  const bus = { request: async () => ({ profile: { id: 'hanako', name: '花子', yuan: 'kong', identity: FULL_PERSONALITY } }) };
  const r = await getProfile(pctx(bus), 'hanako');
  check('8.1 ishiki 缺失：ishiki 空串', r.ishiki === '');
  check('8.2 ishiki 缺失：personality 不受影响', r.personality === FULL_PERSONALITY);
}

// ---------- 收尾 ----------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n---- ${passed}/${passed + failed} PASS ----`);
process.exit(failed ? 1 : 0);
