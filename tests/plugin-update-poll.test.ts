import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import { writePluginRelease } from "../server/utils/plugin-release-store";
import { upsertPluginUpdateTarget } from "../server/utils/plugin-updates";
import { sha256 } from "../server/utils/security";

// 下发要判断磁盘上的包在不在，把数据目录指到临时目录，测试自己写文件。
const hoisted = vi.hoisted(() => ({ dir: "" }));
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, databasePath: () => join(hoisted.dir, "classisland-control.db") };
});

// 每条用例一个临时目录：上一条写过的包会让「磁盘上没有包」这一条变得不成立。
let scratchDir = "";
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "cip-update-poll-"));
  hoisted.dir = scratchDir;
});
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

const NOW = "2026-09-20T00:00:00.000Z";
const DEVICE = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";
const ADMIN = "00000000-0000-4000-8000-000000000077";
const PACKAGE = Buffer.from("cipx-payload");

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,created_at)
    VALUES (?,?,?,?,?,?)`).run(ADMIN, "admin", "hash", "管理员", "admin", NOW);
  db.prepare(`INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,transport,created_at)
    VALUES (?,?,?,?,?,?)`).run(DEVICE, "讲台机", "{}", "thumb-1", "http", NOW);
  return db;
}

/** 落一条发布记录，file=false 用来模拟「备份只恢复了库、包却不在磁盘上」。 */
function publish(db: Database.Database, version: string, options: { file?: boolean; current?: boolean } = {}) {
  const withFile = options.file !== false;
  if (withFile) writePluginRelease(version, PACKAGE);
  db.prepare(`INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_at)
    VALUES (?,?,?,?,?,?)`).run(version, `${version}.cipx`, PACKAGE.length, sha256(PACKAGE), options.current ? 1 : 0, NOW);
}

function target(db: Database.Database, version: string) {
  upsertPluginUpdateTarget(db, { scopeType: "device", scopeId: DEVICE, version }, ADMIN, NOW);
}

type PollBody = {
  pluginUpdate: { version: string; sha256: string; sizeBytes: number; path: string; token: string; expiresAt: string } | null;
};

/** 走一遍真实轮询，只关心已签名响应正文里的 pluginUpdate 与库里回报的两列。 */
function poll(db: Database.Database, sequence: number, reported: { pluginVersion: string; state?: string; version?: string } = { pluginVersion: "0.1.6.0" }): PollBody {
  const input = {
    deviceId: DEVICE, sequence, timestampUtc: NOW, pluginVersion: reported.pluginVersion, appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
    driftCount: 0, acknowledgements: [], crashes: [], rollCallRevision: 0, bindingCodeRequested: false,
    pluginUpdateState: reported.state ?? "", pluginUpdateVersion: reported.version ?? "",
  } as DevicePollInput;
  const outcome = processDevicePoll(db, {
    rawBody: "{}", deviceId: DEVICE, sequence, timestampUtc: NOW, requestHash: `hash-${sequence}`, deviceLastSequence: sequence - 1,
  }, input, NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
  return JSON.parse(outcome.body) as PollBody;
}

function reported(db: Database.Database) {
  return db.prepare("SELECT plugin_update_state state,plugin_update_version version FROM devices WHERE id=?")
    .get(DEVICE) as { state: string; version: string };
}

function stateAudits(db: Database.Database) {
  return (db.prepare("SELECT summary FROM audit_events WHERE action='plugin.update.state' ORDER BY sequence").all() as { summary: string }[])
    .map((row) => row.summary);
}

describe("插件升级在轮询里的下发与回报", () => {
  it("没有目标或版本已一致时不回凭据", () => {
    const db = createDb();
    expect(poll(db, 1).pluginUpdate).toBeNull();
    publish(db, "0.1.7.0", { current: true });
    // 全校默认目标指向 0.1.7.0，但设备还没升到那儿：本轮就该拿到凭据。
    expect(poll(db, 2).pluginUpdate?.version).toBe("0.1.7.0");
    target(db, "0.1.7.0");
    const sameVersion = poll(db, 3, { pluginVersion: "0.1.7.0" });
    expect(sameVersion.pluginUpdate).toBeNull();
    db.close();
  });

  it("凭据随响应签名落进缓存，同序列重放拿回同一个 token", () => {
    const db = createDb();
    publish(db, "0.1.7.0", { current: true });
    const first = poll(db, 1).pluginUpdate!;
    expect(first).toMatchObject({ version: "0.1.7.0", sha256: sha256(PACKAGE), sizeBytes: PACKAGE.length, path: "/api/v1/agent/plugin-releases/0.1.7.0" });
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    const replay = processDevicePoll(db, {
      rawBody: "{}", deviceId: DEVICE, sequence: 1, timestampUtc: NOW, requestHash: "hash-1", deviceLastSequence: 1,
    }, {} as DevicePollInput, NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
    expect(replay.replayed).toBe(true);
    expect((JSON.parse(replay.body) as PollBody).pluginUpdate).toEqual(first);
    db.close();
  });

  it("库里没有包时宁可不发，也不给设备一个 404", () => {
    const db = createDb();
    publish(db, "0.1.7.0", { file: false, current: true });
    expect(poll(db, 1).pluginUpdate).toBeNull();
    db.close();
  });

  it("设备已回报暂存在途版本时不再让它重新下载，但目标仍随每轮回带", () => {
    const db = createDb();
    publish(db, "0.1.7.0", { current: true });
    expect(poll(db, 1).pluginUpdate?.version).toBe("0.1.7.0");
    // token 为空 = 目标没变，设备继续等空闲窗口；彻底没有 pluginUpdate 才表示取消。
    expect(poll(db, 2, { pluginVersion: "0.1.6.0", state: "staged", version: "0.1.7.0" }).pluginUpdate)
      .toMatchObject({ version: "0.1.7.0", token: "" });
    // 管理员换了目标版本，暂存中的旧包就不该继续压住新下发。
    publish(db, "0.1.8.0");
    target(db, "0.1.8.0");
    expect(poll(db, 3, { pluginVersion: "0.1.6.0", state: "staged", version: "0.1.7.0" }).pluginUpdate)
      .toMatchObject({ version: "0.1.8.0" });
    const changed = poll(db, 3, { pluginVersion: "0.1.6.0", state: "staged", version: "0.1.7.0" }).pluginUpdate!;
    expect(changed.token).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it("回报只记变化了的那一次，同状态换版本也会跟着记", () => {
    const db = createDb();
    publish(db, "0.1.7.0", { current: true });
    publish(db, "0.1.8.0");
    poll(db, 1);
    expect(reported(db)).toEqual({ state: "", version: "" });
    expect(stateAudits(db)).toEqual([]);

    poll(db, 2, { pluginVersion: "0.1.6.0", state: "staged", version: "0.1.7.0" });
    expect(reported(db)).toEqual({ state: "staged", version: "0.1.7.0" });
    poll(db, 3, { pluginVersion: "0.1.6.0", state: "staged", version: "0.1.7.0" });
    poll(db, 4, { pluginVersion: "0.1.6.0", state: "staged", version: "0.1.7.0" });
    expect(stateAudits(db)).toEqual(["插件 0.1.7.0 已就位，等待无课时重启"]);

    poll(db, 5, { pluginVersion: "0.1.7.0", state: "applied", version: "0.1.7.0" });
    expect(reported(db)).toEqual({ state: "applied", version: "0.1.7.0" });
    poll(db, 6, { pluginVersion: "0.1.7.0", state: "staged", version: "0.1.8.0" });
    expect(reported(db)).toEqual({ state: "staged", version: "0.1.8.0" });
    expect(stateAudits(db)).toEqual([
      "插件 0.1.7.0 已就位，等待无课时重启",
      "插件已升级到 0.1.7.0",
      "插件 0.1.8.0 已就位，等待无课时重启",
    ]);
    db.close();
  });

  it("失败回报留一次审计并重新给一次下载机会", () => {
    const db = createDb();
    publish(db, "0.1.7.0", { current: true });
    poll(db, 1, { pluginVersion: "0.1.6.0", state: "failed", version: "0.1.7.0" });
    expect(reported(db)).toEqual({ state: "failed", version: "0.1.7.0" });
    expect(stateAudits(db)).toEqual(["插件升级到 0.1.7.0 失败"]);
    // failed 不在免发名单里：设备下一轮仍可拿到新凭据重试。
    expect(poll(db, 2, { pluginVersion: "0.1.6.0", state: "failed", version: "0.1.7.0" }).pluginUpdate?.version).toBe("0.1.7.0");
    db.close();
  });
});
