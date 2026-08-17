// scripts/run-tests.mjs —— 测试编排入口（白名单）
// 必跑 4 项（按序）：md-render-test / smoke-test / check-host-patch / check-renderer-patch；
// 可选 1 项：dsh-adapter-demo（依赖宿主 DSH 服务，默认不跑，--only dsh-adapter-demo 显式触发）。
// 失败不中断（继续跑后续），最后输出汇总表，任一失败退出码非 0。
// 用法：
//   node scripts/run-tests.mjs                  # 跑 4 项必跑
//   node scripts/run-tests.mjs --only <name>    # 只跑指定项（含可选 dsh-adapter-demo）
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// dsh-adapter-demo 的 DSH 服务地址：容器内默认经 host.docker.internal 连宿主，可用 DSH_BASE_URL 覆盖
const DSH_BASE_URL = process.env.DSH_BASE_URL || 'http://host.docker.internal:3080';

const TESTS = [
  { name: 'ui-sim-test', file: 'debug/ui-sim-test.mjs', args: [], required: true, desc: 'UI 模拟回归（DOM 状态机，53+ 场景）' },
  { name: 'md-render-test', file: 'debug/md-render-test.mjs', args: [], required: true, desc: 'markdown 渲染管线单测（含 XSS/URL 括号/高亮）' },
  { name: 'model-adapter-test', file: 'debug/model-adapter-test.mjs', args: [], required: true, desc: 'ModelAdapter 单测（SSE/URL 规整/错误分类）' },
  { name: 'provider-store-test', file: 'debug/provider-store-test.mjs', args: [], required: true, desc: 'ProviderStore 单测（模板/脱敏/默认解析）' },
  { name: 'profile-provider-test', file: 'debug/profile-provider-test.mjs', args: [], required: true, desc: 'ProfileProvider 单测（bus/文件降级）' },
  { name: 'chat-pipeline-test', file: 'debug/chat-pipeline-test.mjs', args: [], required: true, desc: 'ChatPipeline 单测（三层组装/历史转换/JSONL 回环）' },
  { name: 'smoke-test', file: 'debug/smoke-test.cjs', args: [], required: true, desc: '语法/补丁自测/索引/容器联动冒烟' },
  { name: 'check-host-patch', file: 'debug/check-host-patch.js', args: ['--selftest'], required: true, desc: 'host 补丁检测逻辑自测（内存样本）' },
  { name: 'check-renderer-patch', file: 'debug/check-renderer-patch.js', args: ['--selftest'], required: true, desc: 'renderer 补丁检测逻辑自测（内存样本）' },
  { name: 'dsh-adapter-demo', file: 'debug/dsh-adapter-demo.mjs', args: [DSH_BASE_URL], required: false, desc: 'DSH 适配数据流验证（需宿主 DSH 服务 3080）' },
];

function printHelp() {
  console.log('用法：node scripts/run-tests.mjs [--only <name>]');
  console.log('必跑项：' + TESTS.filter((t) => t.required).map((t) => t.name).join(' / '));
  console.log('可选项：' + TESTS.filter((t) => !t.required).map((t) => t.name).join(' / '));
  console.log('--only <name>：只跑指定测试（可重复传入），含可选 dsh-adapter-demo');
}

function parseArgs(argv) {
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('✗ --only 需要 <name> 参数');
        process.exit(2);
      }
      only.push(v);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`✗ 未知参数：${a}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return { only };
}

const { only } = parseArgs(process.argv.slice(2));
const selected = only.length
  ? TESTS.filter((t) => only.includes(t.name))
  : TESTS.filter((t) => t.required);

if (!selected.length) {
  console.error(`✗ 未匹配到测试：${only.join(', ')}`);
  console.error(`可用：${TESTS.map((t) => t.name).join(' / ')}`);
  process.exit(2);
}

const results = [];
for (const t of selected) {
  const tag = t.required ? '' : ' [可选]';
  console.log(`\n========== ${t.name}${tag} ==========`);
  console.log(`  ${t.desc}`);
  // stdio 用 inherit：测试输出直接透出，且规避受限环境 pipe 捕获被拒的问题
  const r = spawnSync(process.execPath, [path.join(ROOT, t.file), ...t.args], { cwd: ROOT, stdio: 'inherit' });
  let ok = false;
  let note = '';
  if (r.error) {
    ok = false;
    note = `spawn 失败：${r.error.message}`;
  } else if (r.status === 0) {
    ok = true;
  } else {
    ok = false;
    note = `exit ${r.status}`;
  }
  results.push({ name: t.name, required: t.required, ok, note });
}

console.log('\n========== run-tests 汇总 ==========');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.required ? '' : ' (可选)'}${r.note ? '  — ' + r.note : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n---- ${results.length - failed}/${results.length} PASS ----`);
process.exit(failed ? 1 : 0);
