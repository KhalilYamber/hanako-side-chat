// test-bus.js —— bus 能力实测工具（只读为主）
// 验证：agent:config / agent:profile / session:history 的真实返回结构。

export const name = 'test_bus';
export const description = 'SideChat 开发调试：实测 bus API 返回结构（只读）';
export const parameters = {
  type: 'object',
  properties: {
    which: { type: 'string', enum: ['config', 'profile', 'history'], default: 'config' },
  },
};
export const sessionPermission = { readOnly: true };

export async function execute(input, ctx) {
  const out = {};
  const which = input.which ?? 'config';
  try {
    if (which === 'config') {
      const res = await ctx.bus.request('agent:config', { agentId: 'hanako' });
      out.agentConfig = res;
    } else if (which === 'profile') {
      const res = await ctx.bus.request('agent:profile', { agentId: 'hanako' });
      out.agentProfile = res;
    } else if (which === 'history') {
      const res = await ctx.bus.request('session:history', {
        sessionPath: ctx.sessionPath,
        limit: 3,
      });
      out.historyKeys = typeof res === 'object' && res ? Object.keys(res) : typeof res;
      out.historySample = JSON.stringify(res).slice(0, 2500);
    }
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  return JSON.stringify(out, null, 2).slice(0, 6000);
}
