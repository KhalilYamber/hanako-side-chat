// scripts/verify-zip.mjs —— Release zip 完整性校验（零依赖，纯 Node 内置：fs / zlib / crypto）
// 为什么需要它：Release 产物一旦损坏（磁盘错误 / 传输截断 / 打包器改动引入 bug），用户装进去
// 直接白屏，排查成本极高。发布前多花一秒全面体检，是最便宜的保险。CI 在「打包后、发布前」
// 强制跑（见 .github/workflows/release.yml），本地发布 SOP 同样要求跑（见 docs/RELEASE.md）。
// 校验项（逐项，全过才退出码 0；任一失败打印具体原因并退出码 1）：
//   ① 文件存在、大小 > 22 字节（EOCD 最小长度，再小连 zip 骨架都放不下）
//   ② 头部魔数 = PK\x03\x04（0x04034b50，local file header 签名）
//   ③ 尾部 EOCD 签名 = PK\x05\x06（0x06054b50）：zip 注释最长 65535 字节，
//      故从尾部 22+65535 字节窗口内倒序扫描定位（倒序取最后一次出现，防数据区偶现同签名误命中）
//   ④ EOCD 声明的中央目录条目数 / 偏移 / 大小，与逐条解析的实际结果一致
//   ⑤ 逐条读 central directory：定位 local header、按压缩方法解压（8=inflateRaw / 0=store）、
//      重算 CRC32 与记录比对、LFH 与 CD 的 crc/大小字段交叉核对、数据区越界检查
//   ⑥ 整包 sha256 与伴生 .sha256 文件（sha256sum 格式）记录值一致
// 用法：node scripts/verify-zip.mjs [zip路径]
//   缺省时自动定位 dist/side-chat-<manifest.json version>.zip（与 pack-zip.mjs 的产物命名一致）。
// 损坏检测自证：复制 zip 后翻转任意 1 字节再跑本脚本，必须报错退出码 1（发布 SOP 验收项）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- CRC32（ZIP 标准多项式 0xedb88320） ----------
// 与 pack-zip.mjs 同一算法：CRC32 是国际标准校验，打包端与校验端实现必须等价，比对才有意义。
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

// ---------- 结果收集 ----------
// 收集全部失败再统一输出（而非遇错即停）：一次运行能看到所有问题，修复不用挤牙膏。
const failures = [];
const fail = (msg) => failures.push(msg);
const hex = (n) => n.toString(16).padStart(8, '0');

// ---------- 入参解析 ----------
function resolveZipPath(arg) {
  if (arg) return path.resolve(arg);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const v = raw?.version;
  if (!v) throw new Error('manifest.json 缺少 version 字段');
  return path.join(ROOT, 'dist', `side-chat-${v}.zip`);
}

// ---------- 主流程 ----------
function main() {
  const zipPath = resolveZipPath(process.argv[2]);
  const zipName = path.basename(zipPath);

  if (!fs.existsSync(zipPath)) {
    console.error(`校验失败：文件不存在 ${zipPath}`);
    console.error('  （默认路径取自 manifest.json version；若尚未打包，请先运行 node scripts/pack-zip.mjs）');
    process.exit(1);
  }
  const buf = fs.readFileSync(zipPath);

  // ① 大小下限：22 = EOCD 结构本身的最小长度
  if (buf.length <= 22) fail(`文件仅 ${buf.length} 字节（≤22），连 EOCD 都放不下，绝非合法 zip`);

  // ② 头部魔数
  if (buf.length >= 4 && buf.readUInt32LE(0) !== 0x04034b50)
    fail(`头部魔数错误：期望 PK\\x03\\x04（0x04034b50），实际 0x${buf.readUInt32LE(0).toString(16)}`);

  // ③ EOCD 定位：尾部窗口内倒序扫描
  let eocdPos = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    fail('尾部 22+65535 字节内未找到 EOCD 签名（PK\\x05\\x06），文件可能被截断或非 zip');
  } else {
    const entryCount = buf.readUInt16LE(eocdPos + 10);
    const cdSize = buf.readUInt32LE(eocdPos + 12);
    const cdOffset = buf.readUInt32LE(eocdPos + 16);
    const commentLen = buf.readUInt16LE(eocdPos + 20);

    // 注释长度必须精确收口到文件末尾：EOCD 之后若有残余字节，说明尾部被拼接或截断
    const trailing = buf.length - eocdPos - 22;
    if (commentLen !== trailing)
      fail(`EOCD 注释长度 ${commentLen} 与实际尾部残余 ${trailing} 字节不符，文件尾部异常`);

    // ④ 中央目录范围必须落在 EOCD 之前、文件之内
    if (cdOffset + cdSize > eocdPos)
      fail(`中央目录范围越界：offset ${cdOffset} + size ${cdSize} 超出 EOCD 位置 ${eocdPos}`);

    // ④ 逐条解析中央目录，实际条目数与 EOCD 声明比对
    const entries = [];
    let p = cdOffset;
    const cdEnd = cdOffset + cdSize;
    while (p < cdEnd) {
      if (p + 46 > cdEnd) {
        fail(`中央目录在偏移 ${p} 处剩余 ${cdEnd - p} 字节，不足一条最短记录（46），目录损坏`);
        break;
      }
      if (buf.readUInt32LE(p) !== 0x02014b50) {
        fail(`中央目录偏移 ${p} 处签名错误：期望 PK\\x01\\x02（0x02014b50），实际 0x${buf.readUInt32LE(p).toString(16)}`);
        break;
      }
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen2 = buf.readUInt16LE(p + 32);
      entries.push({
        method: buf.readUInt16LE(p + 10),
        crc: buf.readUInt32LE(p + 16),
        compSize: buf.readUInt32LE(p + 20),
        uncompSize: buf.readUInt32LE(p + 24),
        lfhOffset: buf.readUInt32LE(p + 42),
        name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      });
      p += 46 + nameLen + extraLen + commentLen2;
    }
    if (p !== cdEnd)
      fail(`中央目录长度不匹配：解析终止于 ${p}，EOCD 声明终止于 ${cdEnd}`);
    if (entries.length !== entryCount)
      fail(`条目数不匹配：EOCD 声明 ${entryCount}，实际解析 ${entries.length}`);

    // ⑤ 逐条目：LFH 校验 → 解压 → 大小 → CRC
    let totalUncomp = 0;
    for (const e of entries) {
      const o = e.lfhOffset;
      if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) {
        fail(`条目 ${e.name}：local header（偏移 ${o}）签名错误或越界`);
        continue;
      }
      // 数据区起点用 LFH 自己的 name/extra 长度计算（规范如此；与 CD 的一致性不保证）
      const dataStart = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
      const dataEnd = dataStart + e.compSize;
      if (dataEnd > buf.length) {
        fail(`条目 ${e.name}：数据区越界（${dataStart}+${e.compSize} > 文件大小 ${buf.length}）`);
        continue;
      }
      // LFH 与 CD 字段交叉核对：本仓库打包器不用 bit3 流式写法，两处必一致；
      // LFH 字段为 0 视为流式占位（他处工具产出），跳过该项以保持兼容。
      const lfhCrc = buf.readUInt32LE(o + 14);
      const lfhComp = buf.readUInt32LE(o + 18);
      const lfhUncomp = buf.readUInt32LE(o + 22);
      if ((lfhCrc !== 0 && lfhCrc !== e.crc) || (lfhComp !== 0 && lfhComp !== e.compSize) || (lfhUncomp !== 0 && lfhUncomp !== e.uncompSize))
        fail(`条目 ${e.name}：LFH 与中央目录的 crc/大小字段不一致，两处记录矛盾`);

      const data = buf.subarray(dataStart, dataEnd);
      let raw;
      if (e.method === 8) {
        try {
          raw = inflateRawSync(data);
        } catch (err) {
          fail(`条目 ${e.name}：解压失败（method 8，${err.message}），数据区大概率损坏`);
          continue;
        }
      } else if (e.method === 0) {
        raw = data;
      } else {
        fail(`条目 ${e.name}：不支持的压缩方法 ${e.method}（仅支持 0=store / 8=deflate）`);
        continue;
      }
      if (raw.length !== e.uncompSize) {
        fail(`条目 ${e.name}：解压后大小 ${raw.length} 与记录 ${e.uncompSize} 不符`);
        continue;
      }
      const actual = crc32(raw);
      if (actual !== e.crc) {
        fail(`条目 ${e.name}：CRC32 不一致（记录 ${hex(e.crc)}，重算 ${hex(actual)}），内容与打包时不符`);
        continue;
      }
      totalUncomp += raw.length;
    }

    if (failures.length === 0) {
      console.log(`结构解析：${entries.length} 个条目，解压后共 ${totalUncomp} 字节`);
    }
  }

  // ⑥ sha256 与伴生 .sha256 文件比对（sha256sum 格式："<hash>  <文件名>"）
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const shaPath = `${zipPath}.sha256`;
  if (!fs.existsSync(shaPath)) {
    fail(`缺少伴生校验文件 ${path.basename(shaPath)}（pack-zip.mjs 打包时会一并生成）`);
  } else {
    const m = fs.readFileSync(shaPath, 'utf8').match(/([0-9a-fA-F]{64})\s+\*?(\S+)/);
    if (!m) {
      fail(`${path.basename(shaPath)} 内容无法解析（应为 sha256sum 格式：<hash>  <文件名>）`);
    } else {
      const recorded = m[1].toLowerCase();
      if (recorded !== hash)
        fail(`sha256 不一致：${path.basename(shaPath)} 记录 ${recorded}，实测 ${hash}`);
      if (m[2] !== zipName)
        fail(`${path.basename(shaPath)} 记录的文件名 ${m[2]} 与实际 ${zipName} 不符`);
    }
  }

  // ---------- 汇总输出 ----------
  if (failures.length > 0) {
    console.error(`校验失败：${zipPath}（${failures.length} 处问题）`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`校验通过：${zipPath}`);
  console.log(`  sha256 ${hash}（与 .sha256 一致）`);
}

try {
  main();
} catch (e) {
  console.error(`校验失败：${e.message}`);
  process.exit(1);
}
