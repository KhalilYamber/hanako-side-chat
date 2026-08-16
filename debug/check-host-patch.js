#!/usr/bin/env node
// check-host-patch.js —— Hana server bundle 补丁检测脚本（CLI 薄壳）
// 核心逻辑见 ../lib/patch-check.mjs（scanSetLiterals / isJotPatch / checkHostPatch）。
//
// 用法：node check-host-patch.js [bundle 路径] [--home <path>]
//   --home：.hanako 家目录（Hana 数据根）；缺省按 环境变量 HANA_HOME → SIDECHAT_HOME → 本机默认 解析。
//   env/默认兜底仅在没有 bundle 位置参数（需要自动定位）时生效；给了 bundle 路径时只看 --home。
//   缺省路径：自动定位 <HOME>/artifacts/server/<最新>/bundle/index.js
// 附带自测：node check-host-patch.js --selftest（内存样本验证扫描与判定逻辑，不落盘）
//
// 输出：PASS（补丁在）或 FAIL（补丁丢失 / 文件不存在），FAIL 时附恢复指引。
// 退出码：0 = PASS，1 = FAIL（便于脚本化监控）。
//
// 说明：本脚本只读 bundle 文件，不做任何修改与删除。

'use strict';

const fs = require('fs');
const path = require('path');

const BAK_NAME = 'index.js.bak-20260815';
// 本机默认，发布场景用 env/参数覆盖
const DEFAULT_HOME = 'C:\\Users\\<USER>\\.hanako';

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

// ---------- 参数与 home 解析 ----------

function parseArgs(argv) {
  const args = { selftest: false, home: null, bundle: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') {
      args.selftest = true;
    } else if (a === '--home') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('✗ --home 需要 <path> 参数（.hanako 家目录）');
        process.exit(1);
      }
      args.home = v;
      i += 1;
    } else if (!a.startsWith('-')) {
      args.bundle = a; // 位置参数：bundle 路径（保持原有语义）
    }
  }
  return args;
}

// --home > 环境变量（HANA_HOME → SIDECHAT_HOME）> 本机默认
function resolveHome(cliHome) {
  if (cliHome) return cliHome;
  if (process.env.HANA_HOME) return process.env.HANA_HOME;
  if (process.env.SIDECHAT_HOME) return process.env.SIDECHAT_HOME;
  return DEFAULT_HOME;
}

async function main() {
  const mod = await import('../lib/patch-check.mjs');
  const args = parseArgs(process.argv);

  if (args.selftest) {
    console.log('=== 自测模式（内存样本） ===');
    const r = mod.runPatchSelfTest();
    console.log(`样本1（jot 含 "token" + 天然 token Set 干扰）: ${r.r1 ? 'PASS ✓' : 'FAIL ✗ 漏报'}`);
    console.log(`样本2（jot 缺 "token" + 天然 token Set 干扰）: ${r.r2 ? 'FAIL ✗ 误报' : 'PASS ✓'}`);
    console.log(`样本3（空内容）                              : ${r.r3 ? 'FAIL ✗ 误报' : 'PASS ✓'}`);
    console.log(r.ok ? '自测全部通过' : '自测未通过，请检查脚本逻辑');
    process.exit(r.ok ? 0 : 1);
  }

  console.log('=== Hana server bundle 补丁检测 ===');
  let home;
  let target = args.bundle || null;
  if (!target) {
    // 自动定位：home 的 env/默认兜底在此生效
    home = resolveHome(args.home);
    if (!fs.existsSync(home)) {
      console.log(`结果: FAIL（home 目录不存在: ${home}）`);
      process.exit(1);
    }
    target = mod.findLatestBundle(home);
    if (!target) {
      console.log(`结果: FAIL（未找到 ${path.join(home, 'artifacts', 'server', '*', 'bundle', 'index.js')}）`);
      process.exit(1);
    }
    console.log(`bundle: ${target}（自动定位最新版本）`);
  } else {
    // 显式 bundle 路径：只看 --home（env/默认兜底不参与）
    home = args.home || DEFAULT_HOME;
    console.log(`bundle: ${target}`);
  }

  const result = mod.checkHostPatch(home);
  if (result.status === 'pass') {
    console.log(`new Set([...]) 字面量: ${result.setCount} 个`);
    console.log('结果: PASS（补丁在 —— widget iframe 的 ticket 校验已放行 token）');
    process.exit(0);
  }
  if (result.status === 'fail') {
    console.log(`new Set([...]) 字面量: ${result.setCount} 个`);
    console.log(`结果: FAIL（补丁丢失或从未打过 —— ${result.detail}）`);
    printRecovery(target);
    process.exit(1);
  }
  console.log(`结果: UNKNOWN（${result.reason ?? result.detail ?? '未知'}）`);
  process.exit(1);
}

main();
