#!/usr/bin/env node
// check-host-patch.js —— Hana server bundle 补丁检测脚本（纯 Node.js，无第三方依赖）
//
// 背景：Hana server bundle 被手动补丁过，在某个 new Set([...]) 集合字面量（jot 集合）中
// 加入了 "token" 字符串，用于修复 widget iframe 的 ticket 校验（否则插件面板显示「加载失败」）。
// Hana 升级会整体覆盖 artifacts 目录导致补丁丢失；原版备份在同目录 index.js.bak-20260815。
//
// 用法：node check-host-patch.js [bundle 路径]
//   缺省路径：C:\Users\<USER>\.hanako\artifacts\server\0.446.6-win32-x64\bundle\index.js
// 附带自测：node check-host-patch.js --selftest（内存样本验证扫描与判定逻辑，不落盘）
//
// 输出：PASS（补丁在）或 FAIL（补丁丢失 / 文件不存在），FAIL 时附恢复指引。
// 退出码：0 = PASS，1 = FAIL（便于脚本化监控）。
//
// 说明：本脚本只读 bundle 文件，不做任何修改与删除。

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BUNDLE = 'C:\\Users\\<USER>\\.hanako\\artifacts\\server\\0.446.6-win32-x64\\bundle\\index.js';
const BAK_NAME = 'index.js.bak-20260815';
const MARKER = 'new Set([';

// ---------- 扫描器 ----------

// 扫描源码中所有 new Set([...]) 数组字面量，返回各自完整原文（含 new Set([ ])）。
// 用方括号配对扫描，跳过字符串字面量与注释（行注释/块注释）内的括号与引号，
// 支持嵌套数组与模板字符串。
// 伪起点过滤：marker 前一字符若是标识符/引号（如 "new Set([...])" 字符串、foo.new Set(）），
// 不可能是真正的表达式起点，跳过，避免把字符串内容误判成集合。
// 注意：注释里的单引号（如 AuthStorage's）若不识别注释，会把后面的 ] 全吞进字符串状态，
// 导致字面量配对错乱，故注释识别是必须的（真实 bundle 已踩中）。
function scanSetLiterals(src) {
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
    let strCh = null; // 当前所处的字符串引号（null = 不在字符串内）
    let lineCmt = false; // 行注释 //
    let blockCmt = false; // 块注释 /* */
    for (; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if (strCh) {
        if (ch === '\\') { i++; continue; } // 转义字符，跳过下一个
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
        if (depth === 0) { i++; break; } // 配对闭合
      }
    }
    out.push(src.slice(pos, i));
    pos = i;
  }
  return out;
}

// jot 集合特征元素：补丁目标集合的字符串字面量（Hk/nN 是变量名，不含字符串本体）。
// 用这些特征区分真正的 jot 集合与 bundle 里天然含 "token" 的其它 Set
// （如凭据字段白名单 new Set(["api_key","token",...])），避免补丁丢失时误报 PASS。
const JOT_FEATURES = ['"agentId"', '"hana-theme"', '"hana-css"'];

// 判定补丁是否在：存在同时含 "token" 元素与 jot 特征元素的 new Set([...]) 字面量
function isJotPatch(src) {
  return scanSetLiterals(src).some(
    (body) => body.includes('"token"') && JOT_FEATURES.some((f) => body.includes(f)),
  );
}

// ---------- 输出与指引 ----------

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

function printRecovery(target) {
  const dir = path.dirname(target);
  const bak = path.join(dir, BAK_NAME);
  const bakExists = fs.existsSync(bak);
  console.log('\n--- 恢复指引 ---');
  console.log(
    '1. 备份检查：' +
      (bakExists
        ? `在（${bak}）`
        : `不在（${bak}）—— Hana 升级会整体覆盖 artifacts 目录，同目录的备份也会一起丢`),
  );
  console.log('2. 重打补丁（在当前 bundle 上操作，勿整文件回退旧版）:');
  console.log('   a. 定位上面的 jot 集合：new Set([..., "agentId", "hana-theme", "hana-css"])');
  console.log('   b. 在 "hana-css" 之后补入 "token"，形如：');
  console.log('      new Set([Hk, nN, "agentId", "hana-theme", "hana-css", "token"])');
  console.log('   c. 语法自检：node --check "<target>"');
  console.log('3. 重启 Hana（托盘完全退出后重新打开），再运行本脚本复检应输出 PASS。');
  console.log('4. 效果验证：打开侧边栏「辅助对话」，面板应正常显示而非「加载失败」。');
  if (bakExists) {
    console.log(`5. 若需确认改动范围，可对比备份：diff "${bak}" "${target}"（bundle 较大，建议用支持大文件的工具）`);
  }
}

// ---------- 主流程 ----------

function main() {
  if (process.argv[2] === '--selftest') {
    runSelfTest();
    return;
  }
  const target = process.argv[2] || DEFAULT_BUNDLE;

  console.log('=== Hana server bundle 补丁检测 ===');
  console.log(`bundle: ${target}`);

  let src;
  try {
    if (!fs.existsSync(target)) throw new Error('文件不存在');
    if (!fs.statSync(target).isFile()) throw new Error('路径不是文件');
    src = fs.readFileSync(target, 'utf8');
  } catch (e) {
    console.log(`结果: FAIL（${e.message}）`);
    printRecovery(target);
    process.exit(1);
  }

  const literals = scanSetLiterals(src);
  console.log(`文件大小: ${(Buffer.byteLength(src) / 1048576).toFixed(2)} MB`);
  console.log(`new Set([...]) 字面量: ${literals.length} 个`);

  const withToken = literals.filter((b) => b.includes('"token"'));
  const jot = withToken.filter((b) => JOT_FEATURES.some((f) => b.includes(f)));
  if (jot.length) {
    console.log('命中补丁目标（jot 集合，含 "token"）:');
    for (const b of jot.slice(0, 3)) console.log(`  ${truncate(b, 300)}`);
    console.log('结果: PASS（补丁在 —— widget iframe 的 ticket 校验已放行 token）');
    process.exit(0);
  }

  console.log('结果: FAIL（补丁丢失或从未打过 —— jot 集合中无 "token" 元素）');
  if (withToken.length) {
    console.log(
      `注意: 另有 ${withToken.length} 个含 "token" 的 Set 字面量，但均不含 jot 特征元素` +
        '（agentId/hana-theme/hana-css），属 bundle 天然内容（如凭据字段白名单），不计入判定。',
    );
  }
  const suspects = literals.filter(
    (b) => !b.includes('"token"') && JOT_FEATURES.some((f) => b.includes(f)),
  );
  if (suspects.length) {
    console.log('\n疑似补丁目标（jot 集合，当前缺 "token"）:');
    for (const b of suspects.slice(0, 3)) console.log(`  ${truncate(b, 300)}`);
  }
  printRecovery(target);
  process.exit(1);
}

// ---------- 自测（内存样本，不落盘） ----------

function runSelfTest() {
  console.log('=== 自测模式（内存样本） ===');
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
  console.log(`样本1（jot 含 "token" + 天然 token Set 干扰）: ${r1 ? 'PASS ✓' : 'FAIL ✗ 漏报'}`);
  console.log(`样本2（jot 缺 "token" + 天然 token Set 干扰）: ${r2 ? 'FAIL ✗ 误报' : 'PASS ✓'}`);
  console.log(`样本3（空内容）                              : ${r3 ? 'FAIL ✗ 误报' : 'PASS ✓'}`);
  const ok = r1 && !r2 && !r3;
  console.log(ok ? '自测全部通过' : '自测未通过，请检查脚本逻辑');
  process.exit(ok ? 0 : 1);
}

main();
