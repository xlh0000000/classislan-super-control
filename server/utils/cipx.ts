import { inflateRawSync } from "node:zlib";

/**
 * 只读地解析 .cipx（本质是 zip）根目录下的 manifest.yml，取回判断“这是不是我们这个插件、
 * 是哪个版本”所需的最小字段。
 *
 * 服务端依赖里没有 zip 也没有 YAML 库，为一次上传引入两个通用解析器不值得，
 * 而且这里必须拒绝的正是「看似合理但会指向别的插件目录」的包：宿主安装时会先删掉
 * `Plugins/<清单里的 id>` 再解压，id 写错等于远程删掉另一个插件。
 * 因此只认根目录的 manifest.yml、只认 stored/deflate 两种压缩、加密条目直接拒收。
 */
export type CipxManifest = { id: string; version: string; name: string | null };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class CipxError extends Error {}

function readManifestEntry(buffer: Buffer): { name: string; method: number; localOffset: number; compressedSize: number } | null {
  // 注释最长 65535，所以 EOCD 只可能在末尾 65557 字节内。
  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new CipxError("不是有效的 .cipx 文件（找不到 zip 目录结束标记）。");
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || entries === 0xffff) throw new CipxError("暂不支持 zip64 格式的 .cipx 文件。");

  for (let i = 0; i < entries; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      throw new CipxError(".cipx 文件的目录结构已损坏。");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x0001) && name.toLowerCase() === "manifest.yml")
      return { name, method, localOffset, compressedSize };
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function readEntryBytes(buffer: Buffer, entry: { method: number; localOffset: number; compressedSize: number }): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE)
    throw new CipxError(".cipx 文件的条目头已损坏。");
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new CipxError(".cipx 文件被截断。");
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      throw new CipxError(".cipx 文件里的 manifest.yml 解压失败。");
    }
  }
  throw new CipxError(`不支持的压缩方式 ${entry.method}。`);
}

/** 只取顶层 `key: value` 标量：清单是 SDK 生成的扁平结构，无需完整 YAML。 */
function parseTopLevelScalars(text: string) {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s|^#/.test(line)) continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    let value = match[2]?.trim() ?? "";
    if (value.startsWith('"') || value.startsWith("'")) {
      // 引号内允许出现 # 之类的字符，所以带引号时只看配对的引号，不做注释裁剪。
      const quote = value.charAt(0);
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    result.set(key.toLowerCase(), value);
  }
  return result;
}

export function readCipxManifest(bytes: Buffer): CipxManifest {
  const entry = readManifestEntry(bytes);
  if (!entry) throw new CipxError(".cipx 文件根目录缺少 manifest.yml。");
  const scalars = parseTopLevelScalars(readEntryBytes(bytes, entry).toString("utf8").replace(/^\uFEFF/, ""));
  const id = scalars.get("id") ?? "";
  const version = scalars.get("version") ?? "";
  if (!id || !version) throw new CipxError("manifest.yml 缺少 id 或 version。");
  return { id, version, name: scalars.get("name") || null };
}
