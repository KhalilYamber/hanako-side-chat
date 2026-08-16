#!/usr/bin/env node
// debug/check-renderer-patch.js —— 「sessionPath 注入」补丁检测脚本（纯 Node.js CJS，无第三方依赖）
// 背景：给 Hana 打的根治补丁，让 host 的 widget iframe URL 带上当前主会话路径
// （sessionPath 参数），修复 side-chat 插件拿不到「当前打开的主对话」的问题。Hana 升级会整体
// 覆盖 artifacts 目录（renderer/server 全部文件被替换），补丁随之丢失，需要本脚本定期复检。
//
// 用法：node debug/check-renderer-patch.js [homeDir]
//   homeDir 解析：位置参数 > 环境变量（HANA_HOME → SIDECHAT_HOME）> 本机默认
//   （缺省 homeDir = <home>/.hanako，可用 HANA_HOME / SIDECHAT_HOME 环境变量覆盖）
//   renderer/server 版本目录与 renderer 产物文件名自动发现（取版本号/字典序最大者），
//   发现失败时报错退出（退出码 1），不静默降级。
// 附带自测：node debug/check-renderer-patch.js --selftest（内存样本，不落盘）
//   覆盖场景：补丁在 / 补丁丢失 / 部分丢失 / 文件缺失
//
// 输出：逐项 ✓/✗ + 所在文件 + 命中片段前 60 字符；最后 PASS（全 ✓）或 FAIL（有 ✗）+ 恢复指引。
// 退出码：0 = PASS，1 = FAIL（便于脚本化监控）。
// 说明：本脚本只读检查，不做任何修改与删除；不依赖 lib/patch-check.mjs，扫描逻辑独立实现。

'use strict';

const fs = require('fs');
const path = require('path');

// 本机默认，发布场景用 env/参数覆盖
const DEFAULT_HOME = path.join(require('os').homedir(), '.hanako');

// ---------- home 解析：CLI 参数 > 环境变量（HANA_HOME → SIDECHAT_HOME）> 本机默认 ----------

function resolveHome(cliHome) {
  if (cliHome) return cliHome;
  if (process.env.HANA_HOME) return process.env.HANA_HOME;
  if (process.env.SIDECHAT_HOME) return process.env.SIDECHAT_HOME;
  return DEFAULT_HOME;
}

// ---------- 版本目录 / 产物文件自动发现（失败抛错，调用方报错退出，不静默降级） ----------

// 列出目录条目；目录不存在或不可读时抛错
function listDirEntries(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`目录不存在: ${dir}`);
  }
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取 ${dir}（${e.message}）`);
  }
}

// 取 <home>/artifacts/<kind>/ 下字典序最大的子目录名（Hana 版本号递增，字典序语义够用）
// requireBundle 为 true 时（server）要求其下有 bundle/index.js
function latestVersionDir(home, kind, requireBundle) {
  const root = path.join(home, 'artifacts', kind);
  const names = listDirEntries(root)
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !requireBundle || fs.existsSync(path.join(root, n, 'bundle', 'index.js')))
    .sort();
  if (names.length === 0) {
    throw new Error(
      requireBundle
        ? `未找到含 bundle/index.js 的 ${kind} 版本目录: ${root}`
        : `未找到 ${kind} 版本目录: ${root}`,
    );
  }
  return names[names.length - 1];
}

// 在目录下按前缀匹配 <prefix>*.js，取字典序最大者（Hana 升级后产物文件名 hash 会变）
function findAssetFile(dir, prefix) {
  const names = listDirEntries(dir)
    .filter((d) => d.isFile() && d.name.startsWith(prefix) && d.name.endsWith('.js'))
    .map((d) => d.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`未找到 ${prefix}*.js: ${dir}`);
  }
  return names[names.length - 1];
}

// ---------- 受检文件解析（随 home 动态发现） ----------
// key: 内部代号；label: 显示用文件名；rel: 相对 <home>/artifacts 的路径
function resolveFiles(home) {
  const rendererVer = latestVersionDir(home, 'renderer', false);
  const serverVer = latestVersionDir(home, 'server', true);
  const assets = path.join(home, 'artifacts', 'renderer', rendererVer, 'assets');
  const sbName = findAssetFile(assets, 'SendButton-');
  const railName = findAssetFile(assets, 'WorkspaceCompanionRail-');
  return {
    rendererVer,
    serverVer,
    files: {
      sb: {
        label: sbName,
        rel: path.join('renderer', rendererVer, 'assets', sbName),
      },
      rail: {
        label: railName,
        rel: path.join('renderer', rendererVer, 'assets', railName),
      },
      server: {
        label: 'index.js（server bundle）',
        rel: path.join('server', serverVer, 'bundle', 'index.js'),
      },
    },
  };
}

// 自测用的文件表（仅 label 参与输出；自测不打印明细，取占位名即可）
const SELFTEST_FILES = {
  sb: { label: 'SendButton-*.js（内存样本）' },
  rail: { label: 'WorkspaceCompanionRail-*.js（内存样本）' },
  server: { label: 'index.js（server bundle 内存样本）' },
};

// ---------- 检查项定义（7 项，与 apply-sessionpath-patch.cjs 的替换目标一一对应） ----------
// needle: 命中特征字符串；kind: 'jot' 走 jot 集合专用检测（见 jotHasSessionPath）
const CHECKS = [
  { id: 'a', key: 'sb', desc: '含 function xl(t,e,g){', needle: 'function xl(t,e,g){' },
  { id: 'b', key: 'sb', desc: '含 sessionPath:g（xl 调用注入）', needle: 'sessionPath:g' },
  { id: 'c', key: 'sb', desc: '含 sessionPath:q})（vl 签名）', needle: 'sessionPath:q})' },
  { id: 'd', key: 'sb', desc: '含 q&&m.searchParams.set("sessionPath",q)', needle: 'q&&m.searchParams.set("sessionPath",q)' },
  { id: 'e', key: 'rail', desc: '含 b=m(u=>u.currentSessionPath??null)', needle: 'b=m(u=>u.currentSessionPath??null)' },
  { id: 'f', key: 'rail', desc: '含 r=ms(o?.routeUrl??null,a,b)', needle: 'r=ms(o?.routeUrl??null,a,b)' },
  {
    id: 'g',
    key: 'server',
    desc: 'jot 集合含 "sessionPath"（位于 "hana-css" 之后）',
    needle: 'new Set([... "hana-css" ... "sessionPath" ...])',
    kind: 'jot',
  },
];

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

// ---------- jot 集合检测（独立实现，参考 lib/patch-check.mjs 的思路但不 import） ----------

const SET_MARKER = 'new Set([';  // jot 集合字面量起点
const JOT_ANCHOR = '"hana-css"'; // jot 集合锚点元素（补丁加在它之后的元素列表尾部）

// 扫描源码中所有 new Set([ ... ]) 字面量，返回 { block, pos } 列表。
// 简化实现：方括号配对扫描，跳过字符串字面量（含转义）与行/块注释；
// 伪起点过滤：marker 前一字符若是标识符或引号（如字符串里的 "new Set(["、foo.new Set(），
// 不可能为真正的表达式起点，跳过。
function scanSetLiterals(src) {
  const out = [];
  let pos = 0;
  while ((pos = src.indexOf(SET_MARKER, pos)) !== -1) {
    const prev = pos > 0 ? src[pos - 1] : '';
    if (/[A-Za-z0-9_$"'`]/.test(prev)) {
      pos += SET_MARKER.length; // 伪起点，跳过
      continue;
    }
    let depth = 0;
    let i = pos + SET_MARKER.length - 1; // 指向 '['，深度从 0 数起
    let strCh = null;
    let lineCmt = false;
    let blockCmt = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if (strCh) {
        if (ch === '\\') i++;
        else if (ch === strCh) strCh = null;
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
    out.push({ block: src.slice(pos, i), pos });
    pos = i;
  }
  return out;
}

// 判定 jot 集合是否已放行 "sessionPath"：找到含锚点 "hana-css" 的 new Set([...]) 字面量，
// 检查其中 "sessionPath" 是否出现在 "hana-css" 之后（补丁加在集合元素列表尾部）。
// 返回 { ok, snippet }：snippet 为该集合块原文（命中与否都带回，便于诊断）。
function jotHasSessionPath(src) {
  for (const { block } of scanSetLiterals(src)) {
    const ia = block.indexOf(JOT_ANCHOR);
    if (ia === -1) continue; // 非 jot 集合（如凭据白名单），跳过
    const is = block.indexOf('"sessionPath"');
    return { ok: is > ia, snippet: block };
  }
  return { ok: false, snippet: null }; // 连 jot 集合都没找到（bundle 结构变化）
}

// ---------- 组合检测 ----------

// contents: { key: 文件内容字符串 | null }（null = 文件缺失）；files: resolveFiles 的 files 表
function runChecks(contents, files) {
  const results = [];
  let allOk = true;
  for (const c of CHECKS) {
    const content = contents[c.key];
    const missing = content === null;
    let ok = false;
    let snippet = null;  // 命中片段（jot 命中时从 "sessionPath" 起截取，便于展示）
    let jotBlock = null; // jot 集合块完整原文（诊断用）
    if (!missing) {
      if (c.kind === 'jot') {
        const r = jotHasSessionPath(content);
        ok = r.ok;
        jotBlock = r.snippet;
        if (ok && jotBlock) snippet = jotBlock.slice(jotBlock.indexOf('"sessionPath"'));
      } else {
        ok = content.includes(c.needle);
        snippet = ok ? content.slice(content.indexOf(c.needle)) : null;
      }
    }
    const res = { id: c.id, file: files[c.key].label, desc: c.desc, needle: c.needle, ok, snippet, missing, note: null };
    if (!ok) {
      allOk = false;
      if (c.kind === 'jot' && !missing) {
        res.note = jotBlock
          ? `jot 集合现状: ${truncate(jotBlock, 60)}（未见 "sessionPath"）`
          : '未找到含 "hana-css" 的 new Set([...])（bundle 结构变化？）';
      }
    }
    results.push(res);
  }
  return { results, allOk };
}

// ---------- 输出 ----------

function printResult(res) {
  const mark = res.ok ? '✓' : '✗';
  console.log(`${mark} ${res.id}. ${res.file}：${res.desc}`);
  if (res.ok) {
    console.log(`   命中片段: ${truncate(res.snippet, 60)}`);
  } else if (res.missing) {
    console.log('   文件缺失（Hana 版本目录可能已更换，见恢复指引）');
  } else {
    console.log(`   期望特征: ${truncate(res.needle, 60)}`);
  }
  if (res.note) console.log(`   ${res.note}`);
}

function printRecovery() {
  console.log('\n--- 恢复指引 ---');
  console.log('Hana 升级会整体覆盖 artifacts 目录（renderer/server 全部文件被替换），补丁随之丢失；');
  console.log('同目录的 .bak-20260816-2 备份也会一起丢，勿依赖备份回退。');
  console.log('重跑补丁脚本即可重打（幂等：已打好的文件自动跳过，未打好的先备份再打）：');
  console.log('  node debug/apply-sessionpath-patch.cjs');
  console.log('重打后重启 Hana（托盘完全退出后重新打开），再运行本脚本复检，应输出 PASS。');
}

// ---------- 自测（内存样本，不落盘） ----------
// 样本内容取自 apply-sessionpath-patch.cjs 的替换目标，与真实补丁形态一致。

const SB_PATCHED = `
  function xl(t,e,g){
    // ...theme:document.documentElement.dataset.theme||Ns,sessionPath:g}),[e,n,o,f,u,t,g]
  }
  function vl({connection:t,routeUrl:e,agentId:n,ticket:o,surfaceSession:a,theme:r,sessionPath:q}){
    n&&m.searchParams.set("agentId",n),q&&m.searchParams.set("sessionPath",q),m.searchParams.set("hana-theme",r)
  }
`;

const SB_ORIG = `
  function xl(t,e){
    // ...theme:document.documentElement.dataset.theme||Ns}),[e,n,o,f,u,t]
  }
  function vl({connection:t,routeUrl:e,agentId:n,ticket:o,surfaceSession:a,theme:r}){
    n&&m.searchParams.set("agentId",n),m.searchParams.set("hana-theme",r)
  }
`;

const RAIL_PATCHED = `
  const n=m(u=>u.pluginWidgets),a=m(u=>u.currentAgentId),b=m(u=>u.currentSessionPath??null),o=i.useMemo(()=>n.find(u=>u.pluginId===e),[n,e]),r=ms(o?.routeUrl??null,a,b)
`;

const RAIL_ORIG = `
  const n=m(u=>u.pluginWidgets),a=m(u=>u.currentAgentId),o=i.useMemo(()=>n.find(u=>u.pluginId===e),[n,e]),r=ms(o?.routeUrl??null,a)
`;

const SERVER_PATCHED = `
  const jot = new Set([Hk, nN, "agentId", "hana-theme", "hana-css", "token", "sessionPath"]);
  const creds = new Set(["api_key", "token", "authorization"]);  // 天然含 token 的其它集合，不应干扰
  const creds2 = new Set(["sessionPath", "x"]);                  // 非 jot 集合里的 sessionPath，不应算数
  const quoted = "new Set([\\"sessionPath\\"])";                   // 字符串内的伪起点，不应算数
`;

const SERVER_ORIG = `
  const jot = new Set([Hk, nN, "agentId", "hana-theme", "hana-css", "token"]);
  const creds = new Set(["api_key", "token", "authorization", "sessionPath"]); // 天然含 sessionPath 的其它集合，不得误报
`;

function runSelfTest() {
  // 场景1：补丁齐全 → 期望 PASS（7/7 命中）
  const s1 = runChecks({ sb: SB_PATCHED, rail: RAIL_PATCHED, server: SERVER_PATCHED }, SELFTEST_FILES);
  // 场景2：补丁全部丢失 → 期望 FAIL（7/7 未命中，无误报）
  const s2 = runChecks({ sb: SB_ORIG, rail: RAIL_ORIG, server: SERVER_ORIG }, SELFTEST_FILES);
  // 场景3：部分丢失（SendButton 在、其余丢失）→ 期望 FAIL（4 命中 + 3 未命中）
  const s3 = runChecks({ sb: SB_PATCHED, rail: RAIL_ORIG, server: SERVER_ORIG }, SELFTEST_FILES);
  // 场景4：文件缺失 → 期望 FAIL（缺失文件归为未命中）
  const s4 = runChecks({ sb: null, rail: RAIL_PATCHED, server: SERVER_PATCHED }, SELFTEST_FILES);

  const t1 = s1.allOk === true;
  const t2 = !s2.allOk && s2.results.every((r) => !r.ok);
  const t3 = !s3.allOk && s3.results.filter((r) => r.ok).length === 4 && s3.results.filter((r) => !r.ok).length === 3;
  const t4 = !s4.allOk && s4.results.slice(0, 4).every((r) => !r.ok) && s4.results.slice(4).every((r) => r.ok);

  const line = (name, pass, detail) => console.log(`${name}: ${pass ? 'PASS ✓' : 'FAIL ✗'}（${detail}）`);
  line('样本1（补丁齐全）', t1, '期望 PASS，7/7 命中');
  line('样本2（补丁丢失）', t2, '期望 FAIL，7/7 未命中、无误报');
  line('样本3（部分丢失）', t3, '期望 FAIL，4 命中 + 3 未命中');
  line('样本4（文件缺失）', t4, '期望 FAIL，缺失文件归为未命中');
  return t1 && t2 && t3 && t4;
}

// ---------- 入口 ----------

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--selftest')) {
    console.log('=== 自测模式（内存样本） ===');
    if (runSelfTest()) {
      console.log('自测全部通过');
      process.exit(0);
    }
    console.log('自测未通过（期望与结果不符，请检查脚本逻辑）');
    process.exit(1);
  }

  // home：位置参数 > 环境变量（HANA_HOME → SIDECHAT_HOME）> 本机默认
  const positional = argv.find((a) => !a.startsWith('-')) || null;
  const home = resolveHome(positional);
  console.log('=== 「sessionPath 注入」补丁检测 ===');
  console.log(`受检目录: ${path.join(home, 'artifacts')}`);

  // 版本目录与产物文件名自动发现（失败即报错退出，不静默降级）
  let resolved;
  try {
    resolved = resolveFiles(home);
  } catch (e) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }
  console.log(`版本目录: renderer=${resolved.rendererVer} / server=${resolved.serverVer}（自动发现）`);
  const FILES = resolved.files;

  // 读取三个受检文件（缺失 / 读取失败记为 null）
  const contents = {};
  for (const key of Object.keys(FILES)) {
    const abs = path.join(home, 'artifacts', FILES[key].rel);
    if (!fs.existsSync(abs)) {
      console.log(`! 文件缺失: ${abs}`);
      contents[key] = null;
      continue;
    }
    try {
      contents[key] = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      console.log(`! 读取失败: ${abs}（${e.message}）`);
      contents[key] = null;
    }
  }

  const r = runChecks(contents, FILES);
  for (const res of r.results) printResult(res);

  if (r.allOk) {
    console.log('\n结果: PASS（补丁在 —— renderer/server 三文件共 7 项特征全部命中）');
    process.exit(0);
  }
  console.log('\n结果: FAIL（存在未命中项 —— 补丁丢失或从未打过）');
  printRecovery();
  process.exit(1);
}

main();
