import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../server/migrations";
import { PLUGIN_UPSTREAM_DEFAULT_PROXIES, pluginProxyPrefixError, pluginUpstreamConfigSchema } from "../shared/schemas";
import { sha256 } from "../server/utils/security";
import {
  advancePluginUpstream,
  fetchPluginUpstreamRelease,
  importPluginUpstreamRelease,
  normalizeUpstreamVersion,
  pluginUpstreamCandidates,
  pluginUpstreamDue,
  pluginUpstreamView,
  readPluginUpstreamConfig,
  readPluginUpstreamState,
  writePluginUpstreamConfig,
  type UpstreamFetch,
} from "../server/utils/plugin-upstream";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

// 拉回来的包要落在数据目录旁，测试把它指到临时目录。
const hoisted = vi.hoisted(() => ({ dir: "" }));
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, databasePath: () => join(hoisted.dir, "classisland-control.db") };
});

const NOW = "2026-09-22T00:00:00.000Z";
const API_URL = "https://api.github.com/repos/xlh0000000/classisland-super-control/releases/latest";
const ASSET_URL = "https://github.com/xlh0000000/classisland-super-control/releases/download/v0.1.7/ClassIsland.Control.Plugin.cipx";
const ADMIN = { id: "user-admin", role: "admin" };

function releaseDoc(tagName: string, digest?: string) {
  return {
    tag_name: tagName,
    assets: [
      { name: "checksums.md", size: 120, browser_download_url: "https://github.com/x/y/releases/download/v0.1.7/checksums.md" },
      {
        name: "ClassIsland.Control.Plugin.cipx",
        size: 4096,
        browser_download_url: ASSET_URL,
        ...(digest ? { digest } : {}),
      },
    ],
  };
}

/** 只写 stored 条目的最小 zip：服务端解析器也只认这一种与 deflate。 */
function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
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

function cipx(id: string, version: string) {
  const manifest = Buffer.from(`id: ${id}\nname: ClassIsland 集控\nversion: ${version}\n`, "utf8");
  return storedZip([{ name: "manifest.yml", data: manifest }, { name: "ClassIsland.Control.Plugin.dll", data: Buffer.alloc(2048, 7) }]);
}

function jsonResponse(body: unknown, url = API_URL) {
  return {
    ok: true, status: 200, url, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers(),
  } as unknown as Response;
}

function bytesResponse(bytes: Buffer, url = ASSET_URL) {
  return {
    ok: true, status: 200, url, json: async () => ({}), arrayBuffer: async () => bytes,
    headers: new Headers({ "content-length": String(bytes.length) }),
  } as unknown as Response;
}

function stubFetch(respond: (url: string) => Response) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return respond(url);
  }) as UpstreamFetch;
  return { fetchImpl, urls };
}

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,'admin',?)")
    .run(ADMIN.id, "admin", "hash", "管理员", NOW);
  return db;
}

function addRelease(db: Database.Database, version: string, isCurrent = 0) {
  db.prepare(`INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_by,created_at)
    VALUES (?,?,4096,?,?,?,?)`).run(version, `${version}.cipx`, "0".repeat(64), isCurrent, ADMIN.id, NOW);
}

describe("上游版本：标签归一", () => {
  it("发布标签补齐成清单里的四段版本", () => {
    expect(normalizeUpstreamVersion("v0.1.7")).toBe("0.1.7.0");
    expect(normalizeUpstreamVersion("0.1.7")).toBe("0.1.7.0");
    expect(normalizeUpstreamVersion("v0.1.7.3")).toBe("0.1.7.3");
    expect(normalizeUpstreamVersion("v0.10.2")).toBe("0.10.2.0");
  });

  it("带后缀或不像版本的标签一律不认", () => {
    // 预发布标签对应的包不该进全校静默升级的路径，补成 0.1.7.0 等于凭空造出一个版本。
    expect(normalizeUpstreamVersion("v0.1.7-beta1")).toBeNull();
    expect(normalizeUpstreamVersion("release-2026-09")).toBeNull();
    expect(normalizeUpstreamVersion("v1.2")).toBeNull();
    expect(normalizeUpstreamVersion("")).toBeNull();
    expect(normalizeUpstreamVersion(null)).toBeNull();
  });
});

describe("上游版本：镜像地址", () => {
  it("只收留干净的 https 站点前缀", () => {
    expect(pluginProxyPrefixError("https://mirror.example.com/")).toBeNull();
    expect(pluginProxyPrefixError("https://mirror.example.com")).toBeNull();
    expect(pluginProxyPrefixError("http://mirror.example.com/")).toMatch(/https/);
    expect(pluginProxyPrefixError("mirror.example.com")).toMatch(/完整的镜像地址/);
    expect(pluginProxyPrefixError("https://mirror.example.com/?token=1")).toMatch(/查询串/);
    expect(pluginProxyPrefixError("https://user:pw@mirror.example.com/")).toMatch(/账号密码/);
  });

  it("内网与云元数据地址一律拒：填错一位就等于把服务端指向自己家", () => {
    expect(pluginProxyPrefixError("https://127.0.0.1/")).toMatch(/内网/);
    expect(pluginProxyPrefixError("https://169.254.169.254/latest")).toMatch(/内网|元数据/);
    expect(pluginProxyPrefixError("https://10.0.0.5/")).toMatch(/内网/);
    expect(pluginProxyPrefixError("https://192.168.1.1:8443/")).toMatch(/内网/);
    expect(pluginProxyPrefixError("https://[::1]/")).toMatch(/内网/);
    expect(pluginProxyPrefixError("https://localhost/")).toMatch(/内网/);
    expect(pluginProxyPrefixError("https://nas.internal/")).toMatch(/内网/);
    expect(pluginUpstreamConfigSchema.safeParse({
      enabled: true, repo: "o/r", proxies: ["https://192.168.0.1/"], intervalMinutes: 30,
    }).success).toBe(false);
  });

  it("候选地址按填写顺序依次回退，最后才是直连", () => {
    const candidates = pluginUpstreamCandidates({
      enabled: true, repo: "xlh0000000/classisland-super-control", proxies: ["https://m1.example.com", "https://m2.example.com/"], intervalMinutes: 30,
    });
    expect(candidates.map((item) => item.url)).toEqual([
      `https://m1.example.com/${API_URL}`,
      `https://m2.example.com/${API_URL}`,
      API_URL,
    ]);
    expect(candidates.map((item) => item.via)).toEqual(["proxy", "proxy", "direct"]);
  });

  it("没配过时预置镜像就在候选列表里，且都排在直连前面", () => {
    const db = createDb();
    const config = readPluginUpstreamConfig(db);
    expect(config.proxies).toEqual([...PLUGIN_UPSTREAM_DEFAULT_PROXIES]);
    const candidates = pluginUpstreamCandidates(config);
    expect(candidates[candidates.length - 1]).toEqual({ url: API_URL, via: "direct" });
    expect(candidates.slice(0, -1).map((item) => item.url))
      .toEqual(PLUGIN_UPSTREAM_DEFAULT_PROXIES.map((prefix) => `${prefix}${API_URL}`));
    db.close();
  });
});

describe("上游版本：抓取", () => {
  it("第一个镜像不通就换下一个，并记下这次是经镜像拿到的", async () => {
    const { fetchImpl, urls } = stubFetch((url) => {
      if (url.includes("m1.")) throw new Error("连接被重置");
      return jsonResponse(releaseDoc("v0.1.7", "sha256:" + "a".repeat(64)));
    });
    const state = await fetchPluginUpstreamRelease(
      { enabled: true, repo: "xlh0000000/classisland-super-control", proxies: ["https://m1.example.com/", "https://m2.example.com/"], intervalMinutes: 30 },
      { fetchImpl, now: () => NOW },
    );
    expect(urls).toEqual(["https://m1.example.com/" + API_URL, "https://m2.example.com/" + API_URL]);
    expect(state).toMatchObject({ ok: true, version: "0.1.7.0", tagName: "v0.1.7", via: "proxy", assetName: "ClassIsland.Control.Plugin.cipx", sha256: "a".repeat(64), sizeBytes: 4096, error: null });
  });

  it("镜像与直连都不通时不抛错，把原因留给界面显示", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("所有连接都失败了");
    });
    const state = await fetchPluginUpstreamRelease(
      { enabled: true, repo: "o/r", proxies: ["https://m1.example.com/"], intervalMinutes: 30 }, { fetchImpl, now: () => NOW },
    );
    expect(state).toMatchObject({ ok: false, version: null, via: null });
    expect(state.error).toMatch(/镜像.*直连|直连/);
    expect(state.error).toContain("所有连接都失败了");
  });

  it("上游标签读不懂时不再往后试别的地址", async () => {
    const { fetchImpl, urls } = stubFetch(() => jsonResponse(releaseDoc("v0.1.7-rc1")));
    const state = await fetchPluginUpstreamRelease(
      { enabled: true, repo: "o/r", proxies: ["https://m1.example.com/"], intervalMinutes: 30 }, { fetchImpl, now: () => NOW },
    );
    expect(urls).toHaveLength(1);
    expect(state).toMatchObject({ ok: false, version: null });
    expect(state.error).toMatch(/v0\.1\.7-rc1/);
  });
});

describe("上游版本：定时巡检与视图", () => {
  const configInput = { enabled: true, repo: "xlh0000000/classisland-super-control", proxies: [] as string[], intervalMinutes: 30 };
  const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it("关掉检测就不再出门，且清掉上一次的结果", () => {
    const db = createDb();
    writePluginUpstreamConfig(db, { ...configInput, enabled: false });
    expect(readPluginUpstreamConfig(db).enabled).toBe(false);
    expect(pluginUpstreamDue(db, NOW)).toBe(false);
    db.close();
  });

  it("存过的空列表保持空着：预置只服务于从没配过的安装，不替管理员把镜像填回去", () => {
    const db = createDb();
    writePluginUpstreamConfig(db, configInput);
    expect(readPluginUpstreamConfig(db).proxies).toEqual([]);
    db.close();
  });

  it("坏掉的配置不会掀翻页面：逐字段回落到默认值，非法镜像地址丢掉", () => {
    const db = createDb();
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('plugin.upstream.config',?,?)")
      .run('{"enabled":"yes","repo":"  ","proxies":["https://ok.example.com/","https://10.1.2.3/"],"intervalMinutes":1}', NOW);
    expect(readPluginUpstreamConfig(db)).toEqual({
      enabled: false, repo: "xlh0000000/classisland-super-control", proxies: ["https://ok.example.com/"], intervalMinutes: 30,
    });
    db.close();
  });

  it("检查一次就把结果存下来，间隔没到不会再来一次", async () => {
    const db = createDb();
    writePluginUpstreamConfig(db, configInput);
    expect(pluginUpstreamDue(db, NOW)).toBe(true);
    const { fetchImpl, urls } = stubFetch(() => jsonResponse(releaseDoc("v0.1.7")));
    await advancePluginUpstream(db, { fetchImpl, now: () => NOW });
    expect(urls).toHaveLength(1);
    expect(readPluginUpstreamState(db)).toMatchObject({ ok: true, version: "0.1.7.0", checkedAt: NOW });
    expect(pluginUpstreamDue(db, NOW)).toBe(false);
    expect(pluginUpstreamDue(db, later(29))).toBe(false);
    expect(pluginUpstreamDue(db, later(31))).toBe(true);
    // 界面读的就是这份缓存：库里最新 0.1.6.0 时，0.1.7.0 才算有更新可拉。
    addRelease(db, "0.1.6.0", 1);
    expect(pluginUpstreamView(db)).toMatchObject({ hasUpdate: true, imported: false, currentVersion: "0.1.6.0", newestInstalled: "0.1.6.0" });
    db.close();
  });
});

describe("上游版本：拉取入库", () => {
  const bytes = cipx("tech.classisland.control", "0.1.7.0");

  function dbWithState(digest: string | null) {
    const db = createDb();
    writePluginUpstreamConfig(db, { enabled: true, repo: "o/r", proxies: ["https://m1.example.com/"], intervalMinutes: 30 });
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('plugin.upstream.state',?,?)").run(JSON.stringify({
      checkedAt: NOW, ok: true, version: "0.1.7.0", tagName: "v0.1.7",
      assetName: "ClassIsland.Control.Plugin.cipx", assetUrl: ASSET_URL, sha256: digest, sizeBytes: bytes.length, via: "proxy", error: null,
    }), NOW);
    return db;
  }

  it("包按清单里的版本落盘，但不会顶掉当前版本", async () => {
    hoisted.dir = mkdtempSync(join(tmpdir(), "cip-import-"));
    const digest = sha256(bytes);
    const db = dbWithState(digest);
    addRelease(db, "0.1.6.0", 1);
    const { fetchImpl, urls } = stubFetch((url) => (url.endsWith(".cipx") ? bytesResponse(bytes) : jsonResponse(releaseDoc("v0.1.7", digest))));
    const result = await importPluginUpstreamRelease(db, ADMIN.id, { version: "0.1.7.0", fetchImpl });
    // 下载也走镜像在前，直连兜底。
    expect(urls[0]).toBe("https://m1.example.com/" + ASSET_URL);
    expect(result).toMatchObject({ version: "0.1.7.0", sizeBytes: bytes.length, sha256: digest, isCurrent: false });
    expect(readFileSync(join(hoisted.dir, "plugin-releases", "0.1.7.0.cipx"))).toEqual(bytes);
    const row = db.prepare("SELECT is_current isCurrent,created_by createdBy FROM plugin_releases WHERE version=?").get("0.1.7.0") as { isCurrent: number; createdBy: string };
    expect(row).toMatchObject({ isCurrent: 0, createdBy: ADMIN.id });
    expect((db.prepare("SELECT version FROM plugin_releases WHERE is_current=1").get() as { version: string }).version).toBe("0.1.6.0");
    expect((db.prepare("SELECT summary FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as { summary: string }).summary).toContain("从上游拉取插件包 0.1.7.0");
    expect(pluginUpstreamView(db)).toMatchObject({ hasUpdate: false, imported: true, newestInstalled: "0.1.7.0" });
    db.close();
  });

  it("摘要对不上就整包拒收，库里不留行", async () => {
    hoisted.dir = mkdtempSync(join(tmpdir(), "cip-import-bad-"));
    const db = dbWithState("b".repeat(64));
    const { fetchImpl } = stubFetch((url) => (url.endsWith(".cipx") ? bytesResponse(bytes) : jsonResponse(releaseDoc("v0.1.7"))));
    await expect(importPluginUpstreamRelease(db, ADMIN.id, { version: "0.1.7.0", fetchImpl })).rejects.toThrow(/摘要不一致/);
    expect(db.prepare("SELECT COUNT(*) count FROM plugin_releases").get()).toMatchObject({ count: 0 });
    db.close();
  });

  it("清单里的版本与检测到的不是同一版，或者根本不是本插件，都不入库", async () => {
    hoisted.dir = mkdtempSync(join(tmpdir(), "cip-import-id-"));
    const db = dbWithState(null);
    const wrongVersion = cipx("tech.classisland.control", "0.1.8.0");
    const { fetchImpl: v } = stubFetch((url) => (url.endsWith(".cipx") ? bytesResponse(wrongVersion) : jsonResponse(releaseDoc("v0.1.7"))));
    await expect(importPluginUpstreamRelease(db, ADMIN.id, { version: "0.1.7.0", fetchImpl: v })).rejects.toThrow(/与检测到的 0\.1\.7\.0 不一致/);

    const { fetchImpl: other } = stubFetch((url) => (url.endsWith(".cipx") ? bytesResponse(cipx("tech.other.plugin", "0.1.7.0")) : jsonResponse(releaseDoc("v0.1.7"))));
    await expect(importPluginUpstreamRelease(db, ADMIN.id, { version: "0.1.7.0", fetchImpl: other })).rejects.toThrow(/不是本集控插件/);
    expect(db.prepare("SELECT COUNT(*) count FROM plugin_releases").get()).toMatchObject({ count: 0 });
    db.close();
  });

  it("没有检测结果或版本已经变了，就不许拉取", async () => {
    hoisted.dir = mkdtempSync(join(tmpdir(), "cip-import-none-"));
    const empty = createDb();
    await expect(importPluginUpstreamRelease(empty, ADMIN.id, { version: "0.1.7.0", fetchImpl: stubFetch(() => jsonResponse({})).fetchImpl }))
      .rejects.toThrow(/先检查一次/);
    const db = dbWithState(null);
    await expect(importPluginUpstreamRelease(db, ADMIN.id, { version: "0.1.9.0", fetchImpl: stubFetch(() => jsonResponse({})).fetchImpl }))
      .rejects.toThrow(/检测结果已经变成 0\.1\.7\.0/);
    db.close();
  });
});
