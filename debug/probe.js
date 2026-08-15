// probe.js —— SideChat 开发探针
// 输出运行时环境信息：bus 能力、路径、当前会话上下文、主会话文件发现。
// 仅开发调试用，正式版可移除。

export const name = 'probe';
export const description = 'SideChat 开发探针：输出 bus 能力、路径与会话环境信息（只读，调试用）';
export const parameters = {
  type: 'object',
  properties: {},
};
export const sessionPermission = { readOnly: true };

export async function execute(input, ctx) {
  const out = {};
  out.pluginDir = ctx.pluginDir;
  out.dataDir = ctx.dataDir;
  out.sessionId = ctx.sessionId ?? null;
  out.sessionRef = ctx.sessionRef ?? null;
  out.sessionPath = ctx.sessionPath ?? null;
  out.agentId = ctx.agentId ?? null;

  // bus 能力探测（listCapabilities 返回数组或对象，兼容处理）
  try {
    const caps = typeof ctx.bus?.listCapabilities === 'function'
      ? await ctx.bus.listCapabilities()
      : null;
    if (Array.isArray(caps)) {
      out.busCapsType = 'array';
      out.busCapsSample = caps.slice(0, 30).map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          return c.type ?? c.name ?? c.capability ?? JSON.stringify(c).slice(0, 120);
        }
        return String(c);
      });
      const sessionLike = caps.filter((c) => {
        const s = typeof c === 'string' ? c : JSON.stringify(c);
        return /session|agent|model|provider/i.test(s);
      });
      out.busCapsSessionLike = sessionLike.slice(0, 40);
    } else if (caps && typeof caps === 'object') {
      out.busCapsType = 'object';
      const relevant = {};
      for (const [k, v] of Object.entries(caps)) {
        if (/session|agent|model|provider/i.test(k)) relevant[k] = v;
      }
      out.busCaps = relevant;
    } else {
      out.busCaps = caps;
    }
  } catch (e) {
    out.busCapsError = String(e?.message ?? e);
  }

  // 路径推断：pluginDir 在 <HOME>/plugins|plugins-dev/<id> 下，上两级即 HANA_HOME
  try {
    const path = await import('node:path');
    const pluginParent = path.dirname(ctx.pluginDir);
    const homeGuess = path.dirname(pluginParent);
    out.pluginParentDir = pluginParent;
    out.homeGuess = homeGuess;
    out.agentsRootGuess = path.join(homeGuess, 'agents');
    out.pluginDataRootGuess = path.join(homeGuess, 'plugin-data');
    const fs = await import('node:fs');
    out.agentsRootExists = fs.existsSync(out.agentsRootGuess);
    if (out.agentsRootExists) {
      out.agents = fs.readdirSync(out.agentsRootGuess);
      const hanakoSess = path.join(out.agentsRootGuess, 'hanako', 'sessions');
      out.hanakoSessionsExists = fs.existsSync(hanakoSess);
      if (out.hanakoSessionsExists) {
        out.hanakoSessionFiles = fs.readdirSync(hanakoSess).slice(0, 10);
      }
    }
  } catch (e) {
    out.pathError = String(e?.message ?? e);
  }

  return JSON.stringify(out, null, 2);
}
