import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { CipxError, readCipxManifest } from "../server/utils/cipx";

type Entry = { name: string; data: Buffer; method?: 0 | 8 };

// 手写最小 zip：服务端没有 zip 依赖，测试也就不引第三方打包库，直接按格式拼。
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14); // CRC 由外层 sha256 兜底，解析器不校验它
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const MANIFEST = Buffer.from([
  "id: tech.classisland.control",
  "name: Classisland Super Control",
  "manifestVersion: 1",
  'entranceAssembly: "ClassIsland.Control.Plugin.dll"',
  "apiVersion: 2.0.0.0",
  "version: 0.1.7.0",
  "author: Classisland Super Control",
  "",
].join("\n"), "utf8");

describe("cipx 清单解析", () => {
  it("stored 与 deflate 两种压缩都能读出 id 与版本", () => {
    expect(readCipxManifest(makeZip([{ name: "manifest.yml", data: MANIFEST }]))).toEqual({
      id: "tech.classisland.control", version: "0.1.7.0", name: "Classisland Super Control",
    });
    expect(readCipxManifest(makeZip([
      { name: "ClassIsland.Control.Plugin.dll", data: Buffer.alloc(2048, 7) },
      { name: "manifest.yml", data: MANIFEST, method: 8 },
    ]))).toEqual({ id: "tech.classisland.control", version: "0.1.7.0", name: "Classisland Super Control" });
  });

  it("缺清单、不是 zip、清单少字段都拒绝", () => {
    expect(() => readCipxManifest(makeZip([{ name: "other.dll", data: Buffer.alloc(8) }]))).toThrow(/缺少 manifest.yml/);
    expect(() => readCipxManifest(Buffer.from("not a zip at all"))).toThrow(/zip 目录结束标记/);
    expect(() => readCipxManifest(makeZip([{ name: "manifest.yml", data: Buffer.from("name: 没有标识\n") }]))).toThrow(/缺少 id 或 version/);
    // 清单里没有版本字段时不能猜：设备会拿它和自己比对。
    expect(() => readCipxManifest(makeZip([{ name: "manifest.yml", data: Buffer.from("id: tech.classisland.control\n") }]))).toThrow(/缺少 id 或 version/);
  });

  it("加密条目与不支持的压缩方式拒绝，不让宿主覆盖别的插件目录", () => {
    const zip = makeZip([{ name: "manifest.yml", data: MANIFEST }]);
    // 中央目录与本地头里的 flags 位置都置上加密位（中央 0x02014b50+8，本地 0x04034b50+6）。
    zip.writeUInt16LE(1, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(() => readCipxManifest(zip)).toThrow(/缺少 manifest.yml/);
    const unsupported = makeZip([{ name: "manifest.yml", data: MANIFEST }]);
    const centralAt = unsupported.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    unsupported.writeUInt16LE(12, centralAt + 10);
    expect(() => readCipxManifest(unsupported)).toThrow(/不支持的压缩方式/);
    expect(new CipxError("x")).toBeInstanceOf(Error);
  });

  it("带 UTF-8 BOM 与引号、行尾注释的清单照常读出", () => {
    const text = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('id: "tech.classisland.control" # 插件标识\nversion: 0.1.7.0\nname: \n', "utf8"),
    ]);
    expect(readCipxManifest(makeZip([{ name: "manifest.yml", data: text }]))).toEqual({
      id: "tech.classisland.control", version: "0.1.7.0", name: null,
    });
  });
});
