// scripts/pack-zip.mjs —— Release 打包（零依赖，纯 Node 手写 ZIP）
// 清单 = git ls-files（排除 .gitignore/.dockerignore），与 v0.4.0 Release zip 结构一致（30 文件）。
// 读 manifest.json version 命名产物 side-chat-<version>.zip，输出 ./dist/ + .sha256（sha256sum 格式）。
// zip 无外层目录：解压直接得 assets/、lib/ 等顶层；路径分隔符统一用 /（Windows 兼容）。
// 压缩：method 8（deflateRaw）优先，比原文更大时回落 method 0（store）；CRC32 手写。
// 用法：node scripts/pack-zip.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
// 红队 P2-16：Release 包只分发运行时文件——debug/ 调试工具（verify/probe/test-bus 等）
// 与 scripts/ 打包脚本不随包分发；docs/ 属于仓库文档，保留随包（README 惯例）。
const EXCLUDE = new Set([
  '.gitignore',
  '.dockerignore',
  'Dockerfile',
  'debug',
  'scripts',
  '.github',
]);

// ---------- CRC32（ZIP 标准多项式） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// mtime → DOS 日期/时间（ZIP 头字段）
function dosDateTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// 手写 ZIP 写入器：local file header + central directory + EOCD
export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const deflated = deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const store = method === 0 ? data : deflated;
    const crc = crc32(data);
    const dt = dosDateTime(e.mtime ?? 0);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // 签名
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0x0800, 6);     // flags：UTF-8 文件名
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dt.time, 10);
    lfh.writeUInt16LE(dt.date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(store.length, 18); // 压缩后大小
    lfh.writeUInt32LE(data.length, 22);  // 原始大小
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra len
    local.push(lfh, nameBuf, store);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // 签名
    cdh.writeUInt16LE(0x031e, 4);     // version made by（Unix 3.0）
    cdh.writeUInt16LE(20, 6);         // version needed
    cdh.writeUInt16LE(0x0800, 8);     // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dt.time, 12);
    cdh.writeUInt16LE(dt.date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(store.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);         // extra len
    cdh.writeUInt16LE(0, 32);         // comment len
    cdh.writeUInt16LE(0, 34);         // disk number
    cdh.writeUInt16LE(0, 36);         // internal attrs
    cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs：常规文件（>>>0 转无符号）
    cdh.writeUInt32LE(offset, 42);    // local header offset
    central.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + store.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // 签名
  eocd.writeUInt16LE(0, 4);           // disk
  eocd.writeUInt16LE(0, 6);           // disk with CD
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);          // comment len
  return Buffer.concat([...local, centralBuf, eocd]);
}

function readManifestVersion() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const v = raw?.version;
  if (!v || typeof v !== 'string') throw new Error('manifest.json 缺少 version 字段');
  return v;
}

function collectManifest() {
  let tracked, untracked;
  try {
    // 红队 P0/P2-16：打包清单 = 已跟踪 + 未跟踪未忽略文件（git ls-files --others
    // 排除被 .gitignore 忽略的构建产物），防止新模块忘 git add 导致发布漏包
    tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`git ls-files 失败（需在 git 仓库内运行）：${e.message}`);
  }
  const seen = new Set();
  return (tracked + '\n' + untracked)
    .split('\n')
    .map((s) => s.trim())
    // EXCLUDE 按顶层目录/文件名匹配（.github/workflows/x.yml 的顶层是 .github）
    .filter((s) => s && !EXCLUDE.has(s.split('/')[0]) && !seen.has(s) && (seen.add(s), true));
}

// 红队 P2-17：已跟踪文件存在未提交改动时以工作区内容进包，
// 导致 Release 产物与版本历史不一致（打过 tag 后改一行再打包，包内是改动后内容）。
// 发布前置校验：工作区必须干净（未跟踪未忽略文件除外——新模块场景由上面双保险覆盖）。
function assertCleanWorkingTree() {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`git diff 失败（需在 git 仓库内运行）：${e.message}`);
  }
  const dirty = diff.split('\n').map((s) => s.trim()).filter(Boolean);
  if (dirty.length) {
    throw new Error(`工作区存在未提交改动（${dirty.length} 个文件），先 commit 再打包：${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? ` 等 ${dirty.length} 个` : ''}`);
  }
}

function main() {
  assertCleanWorkingTree();
  const version = readManifestVersion();
  const names = collectManifest();
  const entries = [];
  for (const name of names) {
    const abs = path.join(ROOT, name);
    let data;
    let mtime;
    try {
      data = fs.readFileSync(abs);
      mtime = fs.statSync(abs).mtimeMs;
    } catch (e) {
      throw new Error(`读取 ${name} 失败：${e.message}`);
    }
    entries.push({ name: name.replace(/\\/g, '/'), data, mtime });
  }
  fs.mkdirSync(DIST, { recursive: true });
  const zipName = `side-chat-${version}.zip`;
  const zipBuf = buildZip(entries);
  fs.writeFileSync(path.join(DIST, zipName), zipBuf);
  const hash = crypto.createHash('sha256').update(zipBuf).digest('hex');
  fs.writeFileSync(path.join(DIST, `${zipName}.sha256`), `${hash}  ${zipName}\n`);
  console.log(`打包完成：${path.join(DIST, zipName)}`);
  console.log(`  ${entries.length} 个文件，版本 ${version}`);
  console.log(`  sha256 ${hash}`);
}

// 直接执行才跑 main；被 import（验证/单测）时不跑，便于复用 buildZip
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  main();
}
