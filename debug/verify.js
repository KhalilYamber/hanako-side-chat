// verify.js —— SideChat 全链路验收工具（Q1/Q2/Q6 进程内验证）+ 静态回归联动
// 分工说明（与 debug/smoke-test.cjs 的关系）：
//   verify.js（本文件）：运行时全链路验证，必须依赖插件进程环境（ctx.bus）：
//     1. 读主会话轮数（session:history）
//     2. 新建 plugin_private 会话（绑定当前主对话 agent）
//     3. 发消息并注入 context（system + beforeUser 两套上下文）
//     4. 轮询等待回复
//     5. 从会话 jsonl 确认实际绑定模型（model_change）
//     6. 从 usage-ledger.json 确认用量归因
//   debug/smoke-test.cjs：静态回归（CLI 独立运行，node debug/smoke-test.cjs [--json]）：
//     ① 语法校验（8 文件）② 补丁检测自测 ③ 索引完整性 ④ Docker 联动（可选）
//   两者互补无重叠：本工具执行时顺带以子进程调 smoke-test（--json 输出并入结果），
//   smoke-test 失败仅记入步骤，不阻断真实链路验证。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'verify';
export const description = 'SideChat 验收：全链路测试（新建会话、发消息注入、等回复、模型与用量确认）';
export const parameters = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      default: '你好，请先复述你收到的【参考上下文】里第 1 轮的内容摘要，再简单自我介绍。',
    },
  },
};
export const sessionPermission = {
  kind: 'plugin_output',
  describeSideEffect: () => ({
    kind: 'plugin_output',
    summary: '创建插件私有测试会话并发送一条消息，用于验收链路。',
  }),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function execute(input, ctx) {
  const out = { steps: {} };

  // 0. 静态回归联动：子进程调 debug/smoke-test.cjs（--json 输出并入结果），失败不阻断链路验证
  try {
    const smokePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke-test.cjs');
    const r = spawnSync(process.execPath, [smokePath, '--json'], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (r.error) {
      out.steps.smokeTest = { ok: false, error: String(r.error.message ?? r.error) };
    } else {
      try {
        const parsed = JSON.parse(r.stdout);
        out.steps.smokeTest = { ok: parsed.ok, summary: parsed.summary };
      } catch {
        out.steps.smokeTest = { ok: false, exitCode: r.status, raw: (r.stdout || r.stderr || '').slice(0, 500) };
      }
    }
  } catch (e) {
    out.steps.smokeTest = { ok: false, error: String(e?.message ?? e) };
  }

  // 1. 主会话轮数
  try {
    const res = await ctx.bus.request('session:history', { sessionPath: ctx.sessionPath, limit: 500 });
    const msgs = res?.messages ?? [];
    const userCount = msgs.filter((m) => m?.role === 'user').length;
    const last = msgs[msgs.length - 1];
    out.steps.mainRounds = { userMessages: userCount, viaApi: true, lastRole: last?.role ?? null };
  } catch (e) {
    out.steps.mainRounds = { error: String(e?.message ?? e) };
  }

  // 2. 新建会话
  let createdPath = null;
  let createdId = null;
  try {
    const created = await ctx.bus.request('session:create', {
      agentId: ctx.agentId,
      visibility: 'plugin_private',
      ownerPluginId: ctx.pluginId,
      kind: 'sidechat',
      cwd: ctx.dataDir,
    });
    createdId = created?.sessionId ?? created?.session?.id ?? created?.sessionRef?.sessionId ?? null;
    createdPath = created?.sessionPath ?? created?.session?.sessionPath ?? created?.sessionRef?.sessionPath ?? null;
    out.steps.create = { ok: true, sessionId: createdId, sessionPath: createdPath, rawKeys: Object.keys(created ?? {}) };
  } catch (e) {
    out.steps.create = { ok: false, error: String(e?.message ?? e) };
    return JSON.stringify(out, null, 2);
  }

  // 3. 发消息（两套上下文注入）
  try {
    const sendRes = await ctx.bus.request('session:send', {
      sessionPath: createdPath,
      text: input.text ?? '',
      context: {
        system: [
          { label: 'persona', text: '你是辅助对话测试助手，用一句话回答。' },
          { label: 'boundary', text: '你没有任何工具权限，只能问答。主对话参考上下文是只读的。' },
        ],
        beforeUser: [
          { label: 'main-context', text: '【参考上下文 · 来自主对话（只读）】\n第 1 轮：\n  您：你好，这是验收测试。\n  助手：收到，这是验收回复。' },
        ],
      },
    });
    out.steps.send = { ok: true, rawKeys: Object.keys(sendRes ?? {}) };
  } catch (e) {
    out.steps.send = { ok: false, error: String(e?.message ?? e) };
    return JSON.stringify(out, null, 2);
  }

  // 4. 轮询回复（最多 90 秒）
  let reply = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    try {
      const h = await ctx.bus.request('session:history', { sessionPath: createdPath, limit: 5 });
      const msgs = h?.messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant' && last.content) {
        reply = last.content.slice(0, 400);
        break;
      }
    } catch {
      // 重试
    }
  }
  out.steps.reply = reply ? { ok: true, text: reply } : { ok: false, error: '90 秒内未等到回复' };

  // 5. 模型确认：读会话 jsonl 的 model_change
  try {
    if (createdPath && fs.existsSync(createdPath)) {
      const lines = fs.readFileSync(createdPath, 'utf8').split(/\r?\n/);
      const mc = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((r) => r && r.type === 'model_change');
      out.steps.model = mc ? { provider: mc.provider, modelId: mc.modelId } : { note: '无 model_change 记录' };
    }
  } catch (e) {
    out.steps.model = { error: String(e?.message ?? e) };
  }

  // 6. 用量归因：查 usage-ledger.json 里该 sessionId 的记录
  try {
    const home = path.dirname(path.dirname(ctx.pluginDir));
    const ledger = path.join(home, 'usage-ledger.json');
    if (fs.existsSync(ledger)) {
      const raw = fs.readFileSync(ledger, 'utf8');
      const id = createdId;
      let count = 0;
      let sample = null;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.includes(id)) continue;
        count++;
        if (!sample) {
          try {
            const entry = JSON.parse(line);
            sample = {
              attribution: entry?.attribution,
              model: entry?.model,
              totalTokens: entry?.usage?.totalTokens ?? null,
            };
          } catch {
            // 跳过
          }
        }
      }
      out.steps.usage = { found: count > 0, count, sample };
    } else {
      out.steps.usage = { error: 'usage-ledger.json 不存在' };
    }
  } catch (e) {
    out.steps.usage = { error: String(e?.message ?? e) };
  }

  out.createdSessionId = createdId;
  return JSON.stringify(out, null, 2);
}
