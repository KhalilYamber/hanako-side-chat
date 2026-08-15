// apply-sessionpath-patch.cjs —— 打「sessionPath 注入」补丁（renderer + server bundle）
// 原理：host 前端 widget 挂载组件从 store 取 currentAgentId 但没传主会话 id；
// 补丁把 currentSessionPath 注入 iframe URL，server 的 jot 集合放行该参数，
// 插件即可拿到「当前打开的主对话」真实路径（根治辅助会话串主对话）。
// 用法：node debug/apply-sessionpath-patch.cjs
// 幂等：已打补丁时跳过；先备份 .bak-20260816-2。

'use strict';
const fs = require('fs');
const path = require('path');

const HOME = 'C:\\Users\\<USER>\\.hanako';
const R_ASSETS = path.join(HOME, 'artifacts', 'renderer', '0.446.6', 'assets');
const B_BUNDLE = path.join(HOME, 'artifacts', 'server', '0.446.6-win32-x64', 'bundle');
const BAK = '.bak-20260816-2';

const targets = [
  {
    file: path.join(R_ASSETS, 'SendButton-BHh1P3ff.js'),
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
    file: path.join(R_ASSETS, 'WorkspaceCompanionRail-_O9uAFJI.js'),
    pairs: [
      ['const n=m(u=>u.pluginWidgets),a=m(u=>u.currentAgentId),o=i.useMemo(()=>n.find(u=>u.pluginId===e),[n,e]),r=ms(o?.routeUrl??null,a)',
       'const n=m(u=>u.pluginWidgets),a=m(u=>u.currentAgentId),b=m(u=>u.currentSessionPath??null),o=i.useMemo(()=>n.find(u=>u.pluginId===e),[n,e]),r=ms(o?.routeUrl??null,a,b)'],
    ],
  },
  {
    file: path.join(B_BUNDLE, 'index.js'),
    pairs: [
      ['"hana-theme",\n  "hana-css",\n  "token"',
       '"hana-theme",\n  "hana-css",\n  "token",\n  "sessionPath"'],
    ],
  },
];

let failed = false;
for (const t of targets) {
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
