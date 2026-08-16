// debug/dsh-adapter-demo.cjs —— DSH 适配试点数据流验证脚本
// 真实连本机 DSH web host（127.0.0.1:3080），跑通：
//   定位主会话 → 读上下文 → 建辅助会话 → 发消息 → 轮询读回
// 消耗：真实创建 1 个会话 + 跑 1 个最小 agent 任务（回复一行）。
// 用法：node debug/dsh-adapter-demo.cjs [baseUrl]

import { createClient, resolveMainSessionPath, toMessages } from '../lib/host-adapter-dsh.js';

const base = process.argv[2] || 'http://127.0.0.1:3080';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const client = createClient(base);

// 1. 健康检查
try {
  await client.health();
  check('健康检查 GET /', true);
} catch (e) {
  check('健康检查 GET /', false, e.message);
  console.log('\nDSH 服务不可达，终止。');
  process.exit(1);
}

// 2. 定位最近活跃会话（主会话定位，method=recent）
let main = null;
try {
  main = await resolveMainSessionPath(client);
  check('主会话定位（recent）', !!main.path, `${main.method} → ${main.path.slice(0, 20)}…`);
} catch (e) {
  check('主会话定位（recent）', false, e.message);
}

// 3. 读主会话历史
let mainEvents = null;
try {
  mainEvents = await client.readHistory(main.path, { limit: 20 });
  check('读主会话历史', Array.isArray(mainEvents.events) && mainEvents.events.length > 0,
    `${mainEvents.events?.length ?? 0} 事件`);
  const msgs = toMessages(mainEvents.events, { limit: 2 });
  if (msgs.length) console.log('    消息预览:', msgs[0].content.slice(0, 60).replace(/\n/g, ' '));
} catch (e) {
  check('读主会话历史', false, e.message);
}

// 4. 建辅助会话
let aux = null;
try {
  aux = await client.createSession({
    cwd: process.cwd(),
    agentPreset: 'standard',
    title: 'dsh-adapter-demo',
  });
  check('建辅助会话', !!aux?.sessionId, aux.sessionId.slice(0, 20) + '…');
} catch (e) {
  check('建辅助会话', false, e.message);
}

// 5. 发消息
try {
  const r = await client.sendMessage(aux.sessionId, '回复一行：dsh-adapter-demo-ok');
  check('发消息（session.prompt）', r?.accepted === true);
} catch (e) {
  check('发消息（session.prompt）', false, e.message);
}

// 6. 轮询读回（至多 90 秒）
let replied = false;
try {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await client.readHistory(aux.sessionId);
    const msgs = toMessages(h.events);
    if (msgs.some((m) => m.role === 'assistant' && m.content.includes('dsh-adapter-demo-ok'))) {
      replied = true;
      break;
    }
  }
  check('轮询读回回复', replied, replied ? '' : '90 秒内未出现预期文本');
} catch (e) {
  check('轮询读回回复', false, e.message);
}

// 汇总
const passed = results.filter((r) => r.ok).length;
console.log(`\n---- ${passed}/${results.length} PASS ----`);
process.exit(passed === results.length ? 0 : 1);
