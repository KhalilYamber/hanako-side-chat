#!/usr/bin/env node
// smoke-test.cjs —— side-chat 插件 Docker 冒烟测试脚本（CLI）
// 用途：一键回归，覆盖四类检查：
//   ① 语法校验：对 routes/api.js、routes/widget.js、lib/main-context.js、lib/store.js、
//      lib/patch-check.mjs、assets/app.js、index.js 及脚本自身逐个 node --check；
//      .js 含 import 时按 CJS 解析会报错，故先试 --check，失败再以
//      `node --input-type=module --check`（stdin 喂文件内容）按 ESM 校验。
//      实测：Node ≥22.7 默认自动检测模块，--check 直接可过；fallback 供旧版本兜底。
//   ② 补丁检测自测：debug/check-host-patch.js --selftest 与
//      debug/check-renderer-patch.js --selftest，两者均须退出码 0。
//   ③ 索引完整性：读取 <HOME>/.hanako/plugin-data/side-chat/sidechat-index.json（若存在），
//      校验每条会话具备 id/sessionPath，报告会话数与未绑定（无 boundMain）数；
//      sessionPath 指向文件可能已被清理，只报信息不判失败。
//   ④ Docker 联动（可选，失败不阻断）：docker info 探测可用性，可用则实际跑一次
//      `docker run --rm -v "<项目根>:/app" -w /app side-chat-dev node --version`（超时 60 秒）。
//
// 用法：node debug/smoke-test.cjs [--json]
//   --json：stdout 仅输出 JSON 结果（供 CI / 容器编排消费），人类可读明细走 stderr。
//
// 输出：PASS（必做项全部通过）或 FAIL（存在必做项失败）；可选跳过项只警告不判失败。
// 退出码：0 = PASS，1 = FAIL（便于脚本化监控）。
//
// 说明：本脚本只读项目文件与索引，不做任何修改；不提交 git、不同步安装目录。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..'); // 项目根，供挂载与相对路径定位

// ---------- 常量 ----------

// 语法校验清单（相对项目根；末项为脚本自身，满足「node --check 校验自身」）
const SYNTAX_FILES = [
  'routes/api.js',
  'routes/widget.js',
  'lib/main-context.js',
  'lib/store.js',
  'lib/patch-check.mjs',
  'assets/app.js',
  'index.js',
  'debug/verify.js',
  'debug/smoke-test.cjs',
];

// 补丁检测自测项（与 debug/ 下两个脚本的 --selftest 约定一致）
const PATCH_CHECKERS = [
  { file: 'debug/check-host-patch.js', arg: '--selftest' },
  { file: 'debug/check-renderer-patch.js', arg: '--selftest' },
];

// 会话索引（与 debug/check-host-patch.js 的 DEFAULT_HOME 约定一致）。
// 可用 SIDECHAT_HOME 环境变量覆盖：容器内把 .hanako 只读挂载后指定，如
//   docker run -v "${HOME}\.hanako:/hana:ro" -e SIDECHAT_HOME=/hana ...
const DEFAULT_HOME = process.env.SIDECHAT_HOME || path.join(require('os').homedir(), '.hanako');
const INDEX_PATH = path.join(DEFAULT_HOME, 'plugin-data', 'side-chat', 'sidechat-index.json');

// Docker 联动常量
const DOCKER_IMAGE = 'side-chat-dev';
const DOCKER_INFO_TIMEOUT = 15000; // docker info 探测超时
const DOCKER_RUN_TIMEOUT = 60000; // docker run 容器就绪验证超时

// ---------- 小工具 ----------

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

// 运行子进程：统一编码、超时与错误归集；返回 spawnSync 结果（含 note 说明异常来源）。
// 沙箱环境（如 HanaAgent 受限会话）禁止创建子进程（EPERM），此时标记 sandboxBlocked，
// 调用方按「跳过」处理并提示在普通终端/Docker 内运行，不误报 FAIL。
function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 30000,
    windowsHide: true,
    input: opts.input,
  });
  if (res.error) {
    const msg = String(res.error.message || '');
    if (/EPERM|EACCES|spawn/i.test(msg) && /node|docker/i.test(cmd)) {
      res.sandboxBlocked = true;
      res.note = `环境限制（${msg}）：当前环境禁止创建子进程，请在普通终端或 Docker 容器内运行本脚本`;
    } else {
      res.note = `启动失败：${msg}`;
    }
  } else if (res.signal) {
    res.note = `被信号终止（${res.signal}，疑似超时 ${opts.timeout}ms）`;
  }
  return res;
}

// 单条结果：{ name, pass, detail }；pass 为 null 表示跳过（不判失败）
function item(name, pass, detail) {
  return { name, pass, detail: detail || '' };
}

// ---------- ① 语法校验 ----------

function checkSyntaxFile(rel) {
  const abs = path.join(PROJECT_DIR, rel);
  if (!fs.existsSync(abs)) return item(rel, false, '文件不存在');

  // 第一轮：常规 --check（Node ≥22.7 对含 import 的 .js 会自动按 ESM 解析）
  let r = runCmd(process.execPath, ['--check', abs], { timeout: 30000 });
  if (r.sandboxBlocked) return item(rel, null, r.note); // 环境限制：跳过不判失败
  if (r.status === 0) return item(rel, true, 'node --check 通过');

  // 第二轮：按 ESM 从 stdin 校验（--check 无文件参数时读取 stdin）
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return item(rel, false, `读取失败：${e.message}`);
  }
  r = runCmd(process.execPath, ['--input-type=module', '--check'], { timeout: 30000, input: src });
  if (r.sandboxBlocked) return item(rel, null, r.note);
  if (r.status === 0) return item(rel, true, 'node --input-type=module --check 通过（ESM 兜底）');

  return item(rel, false, truncate(r.stderr || r.note || '未知错误', 300).trim());
}

// 组级判定：有失败才算失败；全跳过返回 null（不判成败）；否则通过
function groupPass(items) {
  if (items.some((i) => i.pass === false)) return false;
  return items.every((i) => i.pass === null) ? null : true;
}

function runSyntaxChecks() {
  const items = SYNTAX_FILES.map(checkSyntaxFile);
  return {
    name: '语法校验',
    pass: groupPass(items),
    items,
  };
}

// ---------- ② 补丁检测自测 ----------

function runPatchSelftests() {
  const items = PATCH_CHECKERS.map(({ file, arg }) => {
    const abs = path.join(PROJECT_DIR, file);
    if (!fs.existsSync(abs)) return item(file, false, '脚本文件不存在');
    const r = runCmd(process.execPath, [abs, arg], { timeout: 60000 });
    if (r.sandboxBlocked) return item(file, null, r.note); // 环境限制：跳过不判失败
    if (r.status === 0) return item(file, true, '退出码 0（自测通过）');
    return item(file, false, `退出码 ${r.status ?? 'null'}：${truncate(r.stderr || r.stdout || r.note || '未知错误', 200).trim()}`);
  });
  return {
    name: '补丁检测自测',
    pass: groupPass(items),
    items,
  };
}

// ---------- ③ 索引完整性 ----------

function runIndexCheck() {
  if (!fs.existsSync(INDEX_PATH)) {
    return {
      name: '索引完整性',
      pass: null, // 首次安装可能尚无索引，跳过不判失败
      items: [item('sidechat-index.json', null, `索引不存在（${INDEX_PATH}），跳过`)],
    };
  }

  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch (e) {
    return {
      name: '索引完整性',
      pass: false,
      items: [item('sidechat-index.json', false, `JSON 解析失败：${e.message}`)],
    };
  }

  const sessions = Array.isArray(idx.sessions) ? idx.sessions : null;
  if (!sessions) {
    return {
      name: '索引完整性',
      pass: false,
      items: [item('sidechat-index.json', false, '缺少 sessions 数组')],
    };
  }

  // 每条会话必须具有非空 id / sessionPath
  const bad = [];
  sessions.forEach((s, i) => {
    if (!s || typeof s.id !== 'string' || !s.id || typeof s.sessionPath !== 'string' || !s.sessionPath) {
      bad.push(`#${i + 1}（${s && s.id ? s.id : '无 id'}）`);
    }
  });

  // 未绑定 = 无 boundMain 字段；sessionPath 指向文件可能已被清理，仅报信息
  const unbound = sessions.filter((s) => s && !s.boundMain).length;
  // 快照状态（2026-08-16 快照+增量机制）：有 mainCtx 的会话数（信息级）
  const withSnapshot = sessions.filter((s) => s && s.mainCtx && typeof s.mainCtx.text === 'string' && s.mainCtx.text.length > 0).length;
  const missingFiles = sessions.filter((s) => s && s.sessionPath && !fs.existsSync(s.sessionPath)).length;
  const detail = `会话总数 ${sessions.length}，未绑定主对话 ${unbound}，sessionPath 指向文件缺失 ${missingFiles} 个（已清理属正常，仅信息），已有上下文快照 ${withSnapshot} 个`;

  if (bad.length > 0) {
    return {
      name: '索引完整性',
      pass: false,
      items: [item('sidechat-index.json', false, `${detail}；缺 id/sessionPath 的条目：${bad.join('、')}`)],
    };
  }
  return {
    name: '索引完整性',
    pass: true,
    items: [item('sidechat-index.json', true, detail)],
  };
}

// ---------- ④ Docker 联动（可选） ----------

function runDockerCheck() {
  // 探测 Docker 可用性（引擎未启动 / 未安装 / 沙箱禁止子进程均视为不可用）
  const probe = runCmd('docker', ['info'], { timeout: DOCKER_INFO_TIMEOUT });
  if (probe.sandboxBlocked) {
    return {
      name: 'Docker 联动',
      pass: null,
      items: [item('docker info', null, probe.note)],
    };
  }
  if (probe.status !== 0) {
    return {
      name: 'Docker 联动',
      pass: null, // 可选，不判失败
      items: [item('docker info', null, `不可用（${truncate(probe.stderr || probe.note || '未知错误', 200).trim()}）—— 跳过，仅警告`)],
    };
  }

  // 实际跑一次容器就绪验证（镜像缺失会报错，提示先 build）
  const cmd = ['run', '--rm', '-v', `${PROJECT_DIR}:/app`, '-w', '/app', DOCKER_IMAGE, 'node', '--version'];
  const r = runCmd('docker', cmd, { timeout: DOCKER_RUN_TIMEOUT });
  if (r.status === 0) {
    const ver = (r.stdout || '').trim();
    return {
      name: 'Docker 联动',
      pass: true,
      items: [item(`docker run ${DOCKER_IMAGE} node --version`, true, `容器就绪（node ${ver}）`)],
    };
  }
  const hint = `docker run --rm -v "${PROJECT_DIR}:/app" -w /app ${DOCKER_IMAGE} node --version`;
  return {
    name: 'Docker 联动',
    pass: null,
    items: [item(`docker run ${DOCKER_IMAGE} node --version`, null, `失败（${truncate(r.stderr || r.note || '未知错误', 200).trim()}）—— 提示：先 docker build -t ${DOCKER_IMAGE} .，再跑：${hint}`)],
  };
}

// ---------- 输出与汇总 ----------

function icon(pass) {
  return pass === true ? '✓' : pass === false ? '✗' : '△';
}

// 文本模式：明细走 stdout；--json 模式下明细改走 stderr，stdout 只留 JSON
function printText(checks, summary, jsonMode) {
  const out = jsonMode ? console.error : console.log;
  out('=== side-chat 冒烟测试 ===');
  checks.forEach((c, i) => {
    out(`[${i + 1}/${checks.length}] ${c.name}`);
    c.items.forEach((it) => {
      out(`  ${icon(it.pass)} ${it.name}（${it.detail}）`);
    });
  });
  out('');
  if (summary.failed > 0) {
    out(`结果: FAIL（必做项失败 ${summary.failed} 项，通过 ${summary.passed} 项${summary.skipped > 0 ? `，跳过 ${summary.skipped} 项` : ''}）`);
  } else {
    out(`结果: PASS（必做项通过 ${summary.passed} 项${summary.skipped > 0 ? `，可选跳过 ${summary.skipped} 项` : ''}）`);
  }
}

function summarize(checks) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.pass === true) passed += 1;
    else if (c.pass === false) failed += 1;
    else skipped += 1;
  }
  return { passed, failed, skipped };
}

function main() {
  const jsonMode = process.argv.includes('--json');

  const checks = [runSyntaxChecks(), runPatchSelftests(), runIndexCheck(), runDockerCheck()];
  const summary = summarize(checks);
  const ok = summary.failed === 0;

  printText(checks, summary, jsonMode);

  if (jsonMode) {
    // stdout 仅输出合法 JSON，供 CI / 容器编排消费
    process.stdout.write(
      JSON.stringify({ ok, summary, checks }, null, 2) + '\n',
    );
  }

  process.exit(ok ? 0 : 1);
}

main();
