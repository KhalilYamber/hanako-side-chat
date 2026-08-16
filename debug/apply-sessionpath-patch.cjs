// apply-sessionpath-patch.cjs —— 打「sessionPath 注入」补丁（renderer + server bundle）
// 原理：host 前端 widget 挂载组件从 store 取 currentAgentId 但没传主会话 id；
// 补丁把 currentSessionPath 注入 iframe URL，server 的 jot 集合放行该参数，
// 插件即可拿到「当前打开的主对话」真实路径（根治辅助会话串主对话）。
// 用法：node debug/apply-sessionpath-patch.cjs [--home <path>]
//   --home：.hanako 家目录（Hana 数据根）；缺省按 环境变量 HANA_HOME → SIDECHAT_HOME → 本机默认 解析。
//   renderer/server 版本目录与 renderer 产物文件名自动发现（取版本号/字典序最大者），
//   发现失败时报错退出（退出码 1），不静默降级。
// 幂等：已打补丁时跳过；先备份 .bak-20260816-2。

'use strict';
const fs = require('fs');
const path = require('path');

// 本机默认，发布场景用 env/参数覆盖
const DEFAULT_HOME = 'C:\\Users\\<USER>\\.hanako';
const BAK = '.bak-20260816-2';

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

// ---------- 补丁目标构建 ----------

function discoverTargets(home) {
  const rendererVer = latestVersionDir(home, 'renderer', false);
  const serverVer = latestVersionDir(home, 'server', true);
  const assets = path.join(home, 'artifacts', 'renderer', rendererVer, 'assets');
  const sbFile = findAssetFile(assets, 'SendButton-');
  const railFile = findAssetFile(assets, 'WorkspaceCompanionRail-');
  return {
    rendererVer,
    serverVer,
    targets: [
      {
        file: path.join(assets, sbFile),
        pairs: [
          ['function xl(t,e){', 'function xl(t,e,g){'],
          ['theme:document.documentElement.dataset.theme||Ns}),[e,n,o,f,u,t]',
           'theme:document.documentElement.dataset.theme||Ns,sessionPath:g}),[e,n,o,f,u,t,g]'],
          ['function vl({connection:t,routeUrl:e,agentId:n,ticket:o,surfaceSession:a,theme:r})',
           'function vl({connection:t,routeUrl:e,agentId:n,ticket:o,surfaceSession:a,theme:r,sessionPath:q})'],
          ['n&&m.searchParams.set("agentId",n),m.searchParams.set("hana-theme"',
           'n&&m.searchParams.set("agentId",n),q&&m.searchParams.set("sessionPath",q),m.searchParams.set("hana-theme"'],
        ],
      },
      {
        file: path.join(assets, railFile),
        pairs: [
          ['const n=m(u=>u.pluginWidgets),a=m(u=>u.currentAgentId),o=i.useMemo(()=>n.find(u=>u.pluginId===e),[n,e]),r=ms(o?.routeUrl??null,a)',
           'const n=m(u=>u.pluginWidgets),a=m(u=>u.currentAgentId),b=m(u=>u.currentSessionPath??null),o=i.useMemo(()=>n.find(u=>u.pluginId===e),[n,e]),r=ms(o?.routeUrl??null,a,b)'],
        ],
      },
      {
        file: path.join(home, 'artifacts', 'server', serverVer, 'bundle', 'index.js'),
        pairs: [
          ['"hana-theme",\n  "hana-css",\n  "token"',
           '"hana-theme",\n  "hana-css",\n  "token",\n  "sessionPath"'],
        ],
      },
    ],
  };
}

// ---------- 入口 ----------

function parseHomeArg(argv) {
  let home = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--home') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('✗ --home 需要 <path> 参数（.hanako 家目录）');
        process.exit(1);
      }
      home = v;
      i += 1;
    }
  }
  return home;
}

function main() {
  const home = resolveHome(parseHomeArg(process.argv));
  console.log(`home: ${home}`);

  let discovered;
  try {
    discovered = discoverTargets(home);
  } catch (e) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }
  console.log(`renderer 版本: ${discovered.rendererVer} / server 版本: ${discovered.serverVer}（自动发现）`);

  let failed = false;
  for (const t of discovered.targets) {
    if (!fs.existsSync(t.file)) {
      console.log(`✗ 文件不存在: ${t.file}`);
      failed = true;
      continue;
    }
    let src = fs.readFileSync(t.file, 'utf8');
    // 幂等检测：任一替换目标已存在新值 → 视为已打过，跳过
    if (t.pairs.every(([a, b]) => src.includes(b))) {
      console.log(`= 已打过补丁（跳过）: ${path.basename(t.file)}`);
      continue;
    }
    // 备份
    const bak = t.file + BAK;
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(t.file, bak);
      console.log(`备份: ${path.basename(bak)}`);
    }
    let ok = true;
    for (const [a, b] of t.pairs) {
      if (src.includes(a)) {
        src = src.split(a).join(b);
        console.log(`✓ ${path.basename(t.file)}: ${a.slice(0, 50)}…`);
      } else {
        console.log(`✗ 未命中: ${path.basename(t.file)}: ${a.slice(0, 50)}…`);
        ok = false;
      }
    }
    if (ok) {
      fs.writeFileSync(t.file, src, 'utf8');
      console.log(`已写入: ${path.basename(t.file)}`);
    } else {
      failed = true;
    }
  }
  console.log(failed ? '\n补丁失败（有未命中项），未写入失败文件' : '\n补丁全部完成');
  process.exit(failed ? 1 : 0);
}

main();
