// scripts/check-all.mjs —— 全量语法检查
// 遍历仓库全部 .js/.mjs/.cjs（index.js / lib / routes / assets / debug / scripts），
// 逐个 node --check（Node ≥22.7 对无 package.json 的 .js 自动按模块语法检测，CJS/ESM 通吃），
// 失败汇总，任一失败则退出码非 0（供 CI / compose 编排）。
// 用法：node scripts/check-all.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 扫描根：index.js 为根文件，其余为目录（scripts 含自身，一并检查）
const ROOTS = ['index.js', 'lib', 'routes', 'assets', 'debug', 'scripts'];
const EXT_RE = /\.(js|mjs|cjs)$/;

function collectFiles() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return; // 目录缺失（如 scripts 尚未创建）时跳过
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else if (st.isFile() && EXT_RE.test(rel)) {
      files.push(rel);
    }
  };
  for (const r of ROOTS) walk(r);
  return files;
}

function checkFile(rel) {
  const abs = path.join(ROOT, rel);
  // stdio 用 inherit：node --check 的报错直接透出，且规避受限环境 pipe 捕获被拒的问题
  const r = spawnSync(process.execPath, ['--check', abs], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) return { rel, ok: false, note: `spawn 失败：${r.error.message}` };
  return { rel, ok: r.status === 0, note: r.status === 0 ? '' : `exit ${r.status}` };
}

const files = collectFiles();
console.log(`=== check-all：扫描到 ${files.length} 个文件 ===`);
const results = files.map((rel) => {
  const r = checkFile(rel);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${rel}${r.note ? '  — ' + r.note : ''}`);
  return r;
});
const failed = results.filter((r) => !r.ok);
console.log(`\n---- ${results.length - failed.length}/${results.length} PASS ----`);
process.exit(failed.length ? 1 : 0);
