import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { sha256 } from "../server/utils/security";

// 下载凭据要兑换成磁盘上的真包，所以把数据目录指到临时目录，测试自己写文件。
const hoisted = vi.hoisted(() => ({ dir: "" }));
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, databasePath: () => join(hoisted.dir, "classisland-control.db") };
});

const { consumePluginDownloadToken, planPluginUpdateOffer } = await import("../server/utils/plugin-release-delivery");
const { upsertPluginUpdateTarget } = await import("../server/utils/plugin-updates");
const { writePluginRelease } = await import("../server/utils/plugin-release-store");

const NOW = "2026-09-21T00:00:00.000Z";
const ACTOR = "00000000-0000-4000-8000-000000000099";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PACKAGE = Buffer.alloc(4096, 0x5a);

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), "cip-delivery-"));
  hoisted.dir = dir;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
    .run(ACTOR, "admin", "hash", "管理员", "admin", NOW);
  db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,plugin_version,created_at) VALUES (?,?,?,?,?,?)")
    .run(uuid(1), "测试设备", "{}", "t1", "0.1.6.0", NOW);
  return { db, dir };
}

/** 记一条发布：可只记不发（缺文件），可标成当前版本（没人设目标时设备跟着它）。 */
function publish(db: Database.Database, version: string, options: { file?: boolean; current?: boolean } = {}) {
  const withFile = options.file !== false;
  if (withFile) writePluginRelease(version, PACKAGE);
  db.prepare("INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_at) VALUES (?,?,?,?,?,?)")
    .run(version, `${version}.cipx`, PACKAGE.length, sha256(PACKAGE), options.current ? 1 : 0, NOW);
}

const offer = (db: Database.Database, reported = { state: "", version: "" }) =>
  planPluginUpdateOffer(db, uuid(1), "0.1.6.0", reported, NOW);

describe("插件升级下发", () => {
  it("目标与本机版本一致时不发凭据", () => {
    const { db, dir } = createDb();
    try {
      publish(db, "0.1.6.0", { current: true });
      upsertPluginUpdateTarget(db, { scopeType: "device", scopeId: uuid(1), version: "0.1.6.0" }, ACTOR, NOW);
      expect(offer(db)).toBeNull();
      // 回滚也算不一致：目标比本机旧照样下发，否则管理员调回旧版时设备不会动。
      publish(db, "0.1.5.0");
      upsertPluginUpdateTarget(db, { scopeType: "device", scopeId: uuid(1), version: "0.1.5.0" }, ACTOR, NOW);
      expect(offer(db)?.version).toBe("0.1.5.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("发的是凭据哈希，路径是相对路径", () => {
    const { db, dir } = createDb();
    try {
      publish(db, "0.1.7.0", { current: true });
      const result = offer(db);
      expect(result).toMatchObject({ version: "0.1.7.0", sha256: sha256(PACKAGE), sizeBytes: PACKAGE.length, path: "/api/v1/agent/plugin-releases/0.1.7.0" });
      expect(result?.token).toMatch(/^[0-9a-f]{64}$/);
      const row = db.prepare("SELECT token_hash tokenHash,device_id deviceId,version,max_uses maxUses FROM plugin_download_tokens").get() as
        { tokenHash: string; deviceId: string; version: string; maxUses: number };
      expect(row).toEqual({ tokenHash: sha256(result!.token), deviceId: uuid(1), version: "0.1.7.0", maxUses: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("记录在而文件不在时不发，等管理员补传", () => {
    const { db, dir } = createDb();
    try {
      publish(db, "0.1.7.0", { file: false, current: true });
      expect(offer(db)).toBeNull();
      writePluginRelease("0.1.7.0", PACKAGE);
      expect(offer(db)?.version).toBe("0.1.7.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("设备已暂存同一版本时只回「目标没变」，目标换了才再发凭据", () => {
    const { db, dir } = createDb();
    try {
      publish(db, "0.1.7.0", { current: true });
      expect(offer(db)?.version).toBe("0.1.7.0");
      // token 留空 = 不必重新下载；同时不该再多发一条凭据记录。
      expect(offer(db, { state: "staged", version: "0.1.7.0" })).toEqual({
        version: "0.1.7.0", sha256: sha256(PACKAGE), sizeBytes: PACKAGE.length,
        path: "/api/v1/agent/plugin-releases/0.1.7.0", token: "", expiresAt: "",
      });
      expect(db.prepare("SELECT COUNT(*) count FROM plugin_download_tokens").get()).toEqual({ count: 1 });
      // 暂存的是旧目标时，新目标仍要发出去，否则会永远卡在等重启的那一版。
      publish(db, "0.1.8.0");
      upsertPluginUpdateTarget(db, { scopeType: "device", scopeId: uuid(1), version: "0.1.8.0" }, ACTOR, NOW);
      expect(offer(db, { state: "staged", version: "0.1.7.0" })?.version).toBe("0.1.8.0");
      // 失败后设备报空状态，下一轮照样能拿到新凭据重试。
      expect(offer(db, { state: "failed", version: "0.1.8.0" })?.version).toBe("0.1.8.0");
      // 目标取消（等于本机版本）时彻底不回：设备据此丢掉暂存的包。
      publish(db, "0.1.6.0");
      upsertPluginUpdateTarget(db, { scopeType: "device", scopeId: uuid(1), version: "0.1.6.0" }, ACTOR, NOW);
      expect(offer(db, { state: "staged", version: "0.1.8.0" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("凭据按次数消费：两次可用、第三次与串用都拒绝", () => {
    const { db, dir } = createDb();
    try {
      publish(db, "0.1.7.0", { current: true });
      const result = offer(db)!;
      const consume = (token: string, version = "0.1.7.0", at = NOW) => consumePluginDownloadToken(db, version, token, at);
      expect(consume(result.token)?.bytes).toEqual(PACKAGE);
      expect(consume(result.token)?.deviceId).toBe(uuid(1));
      expect(consume(result.token)).toBeNull();
      // 拿 A 版本的凭据去换 B 版本：兑换条件不满足，一条记录也不会多。
      const again = offer(db)!;
      expect(consume(again.token, "0.1.8.0")).toBeNull();
      // 过期后即使还有名额也不给。
      const fresh = offer(db)!;
      expect(consume(fresh.token, "0.1.7.0", "2026-09-22T00:00:00.000Z")).toBeNull();
      expect(db.prepare("SELECT COUNT(*) count FROM plugin_download_tokens WHERE token_hash=?").get(sha256(fresh.token))).toEqual({ count: 1 });
      // 非十六进制的 token 连哈希都不必算。
      expect(consume("../etc/passwd")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("每轮发放顺手清掉本机已过期或用尽的凭据", () => {
    const { db, dir } = createDb();
    try {
      publish(db, "0.1.7.0", { current: true });
      const first = offer(db)!;
      consumePluginDownloadToken(db, "0.1.7.0", first.token, NOW);
      consumePluginDownloadToken(db, "0.1.7.0", first.token, NOW);
      expect(db.prepare("SELECT COUNT(*) count FROM plugin_download_tokens").get()).toEqual({ count: 1 });
      // 下一轮（一小时后）先回收再发放，表里始终只留着还在用的那条。
      const second = planPluginUpdateOffer(db, uuid(1), "0.1.6.0", { state: "", version: "" }, "2026-09-21T01:00:00.000Z")!;
      expect(db.prepare("SELECT token_hash tokenHash FROM plugin_download_tokens").all()).toEqual([{ tokenHash: sha256(second.token) }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });
});
