// lib/patch-check.mjs —— host 补丁检测（可复用模块版）
// 从 debug/check-host-patch.js 抽取的核心逻辑，供 routes/api.js 的 /api/diagnostics 复用。
// 检测 Hana server bundle 的 jot 集合是否含 "token"（widget iframe ticket 校验补丁）。

import fs from 'node:fs';
import path from 'node:path';

export const BAK_NAME = 'index.js.bak-20260815';
const MARKER = 'new Set([';

// jot 集合特征元素：补丁目标集合的字符串字面量（Hk/nN 是变量名，不含字符串本体）。
// 用这些特征区分真正的 jot 集合与 bundle 里天然含 "token" 的其它 Set
// （如凭据字段白名单 new Set(["api_key","token",...])），避免补丁丢失时误报 PASS。
export const JOT_FEATURES = ['"agentId"', '"hana-theme"', '"hana-css"'];

// ---------- 扫描器 ----------

// 扫描源码中所有 new Set([...]) 数组字面量，返回各自完整原文（含 new Set([ ])）。
// 用方括号配对扫描，跳过字符串字面量与注释（行注释/块注释）内的括号与引号，
// 支持嵌套数组与模板字符串。
// 伪起点过滤：marker 前一字符若是标识符/引号（如 "new Set([...])" 字符串、foo.new Set(）），
// 不可能是真正的表达式起点，跳过，避免把字符串内容误判成集合。
export function scanSetLiterals(src) {
  const out = [];
  let pos = 0;
  while ((pos = src.indexOf(MARKER, pos)) !== -1) {
    const prev = pos > 0 ? src[pos - 1] : '';
    if (/[A-Za-z0-9_$"'`]/.test(prev)) {
      pos += MARKER.length; // 伪起点（字符串/标识符中间），跳过
      continue;
    }
    let depth = 0;
    let i = pos + MARKER.length - 1; // 指向 '['，深度从 0 数起
    let strCh = null;
    let lineCmt = false;
    let blockCmt = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if (strCh) {
        if (ch === '\\') { i++; continue; }
        if (ch === strCh) strCh = null;
        continue;
      }
      if (lineCmt) {
        if (ch === '\n') lineCmt = false;
        continue;
      }
      if (blockCmt) {
        if (ch === '*' && next === '/') { blockCmt = false; i++; }
        continue;
      }
      if (ch === '/' && next === '/') { lineCmt = true; i++; continue; }
      if (ch === '/' && next === '*') { blockCmt = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { strCh = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    out.push(src.slice(pos, i));
    pos = i;
  }
  return out;
}

// 判定补丁是否在：存在同时含 "token" 元素与 jot 特征元素的 new Set([...]) 字面量
export function isJotPatch(src) {
  return scanSetLiterals(src).some(
    (body) => body.includes('"token"') && JOT_FEATURES.some((f) => body.includes(f)),
  );
}

// ---------- bundle 定位 ----------

// 在 <home>/artifacts/server/ 下找最新版本的 bundle（Hana 升级会新增版本目录）
export function findLatestBundle(homeDir) {
  try {
    const serverRoot = path.join(homeDir, 'artifacts', 'server');
    if (!fs.existsSync(serverRoot)) return null;
    let best = null;
    let bestMtime = 0;
    for (const verDir of fs.readdirSync(serverRoot)) {
      const bundle = path.join(serverRoot, verDir, 'bundle', 'index.js');
      if (!fs.existsSync(bundle)) continue;
      try {
        const st = fs.statSync(bundle);
        if (st.mtimeMs > bestMtime) {
          best = bundle;
          bestMtime = st.mtimeMs;
        }
      } catch {
        // 跳过
      }
    }
    return best;
  } catch {
    return null;
  }
}

// ---------- 组合检测 ----------

// 完整检测：返回结构化结果（供 /api/diagnostics 使用）
// homeDir = dirname(dirname(pluginDir)) = HANA_HOME
export function checkHostPatch(homeDir) {
  try {
    const bundlePath = findLatestBundle(homeDir);
    if (!bundlePath) {
      return { status: 'unknown', bundlePath: null, reason: '未找到 artifacts/server 下的 bundle' };
    }
    const src = fs.readFileSync(bundlePath, 'utf8');
    const literals = scanSetLiterals(src);
    const withToken = literals.filter((b) => b.includes('"token"'));
    const jot = withToken.filter((b) => JOT_FEATURES.some((f) => b.includes(f)));
    if (jot.length) {
      return {
        status: 'pass',
        bundlePath,
        setCount: literals.length,
        detail: 'jot 集合含 "token"，ticket 校验已放行',
      };
    }
    const suspects = literals.filter(
      (b) => !b.includes('"token"') && JOT_FEATURES.some((f) => b.includes(f)),
    );
    return {
      status: 'fail',
      bundlePath,
      setCount: literals.length,
      detail: suspects.length
        ? `jot 集合存在但缺 "token"（疑似丢失）`
        : '未找到 jot 集合（bundle 结构变化或版本差异）',
      bakExists: fs.existsSync(path.join(path.dirname(bundlePath), BAK_NAME)),
    };
  } catch (e) {
    return { status: 'unknown', bundlePath: null, reason: String(e?.message ?? e) };
  }
}

// ---------- 自测（内存样本） ----------

export function runPatchSelfTest() {
  const okSample = `
const jot = new Set([Hk, nN, "agentId", "hana-theme", "hana-css", "token"]);
const creds = new Set(["api_key", "token", "authorization"]); // 天然含 token，非 jot，不应干扰
const nested = new Set([["x", "y"], [1, 2]]);
const s = "token";              // 集合外的普通字符串，不应算数
const fake = new Set(["t0ken"]); // 近似但不同，不应算数
const quoted = "new Set([\\"token\\"])"; // 字符串内的伪起点，不应算数
// 注释干扰：AuthStorage's [token] 与单引号、方括号都不得影响配对
`;
  const failSample = `
// 补丁丢失 + bundle 天然含 token 的 Set（真实误报场景：必须 FAIL）
const jot = new Set([Hk, nN, "agentId", "hana-theme", "hana-css"]);
const creds = new Set(["api_key", "token", "authorization"]);
const s = "token"; // 集合外出现，不应算数
`;
  const emptySample = '';

  const r1 = isJotPatch(okSample);
  const r2 = isJotPatch(failSample);
  const r3 = isJotPatch(emptySample);
  const ok = r1 && !r2 && !r3;
  return { r1, r2, r3, ok };
}
