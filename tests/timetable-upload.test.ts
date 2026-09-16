import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

type HttpError = Error & { statusCode?: number; data?: unknown };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string; data?: unknown }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data });

import { migrate } from "../server/migrations";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import { adoptTimetableAsConfiguration, computeTimetableDigest, readDeviceTimetable } from "../server/utils/device-timetable";
import type { AuthenticatedDeviceRequest } from "../server/utils/device-auth";

// 贡献者：威廉（课表上传：存档 / 幂等 / 防篡改 / 要求重传 / 采纳为配置）

const NOW = "2026-09-11T00:00:00.000Z";
const DEVICE_ID = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";
const OWNER = { id: "user-owner" };

/** 与 ClassIsland 官方 Profile 同构的快照，结构对齐 ProtocolVectors 中的课表向量。 */
const TIMETABLE = {
  name: "高一（3）班",
  timeLayouts: {
    "b3f4c5d6-4a5b-4c6d-8e7f-0a1b2c3d4e5f": { name: "夏秋季作息", layouts: [{ startTime: "08:00", endTime: "08:45" }] },
  },
  classPlans: {
    "a1b2c3d4-1a2b-3c4d-8e6f-7a8b9c0d1e2f": {
      name: "周一",
      timeLayoutId: "b3f4c5d6-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
      classes: [{ subjectId: "11111111-2222-3333-8444-555555555555" }],
    },
  },
  subjects: {
    "11111111-2222-3333-8444-555555555555": { name: "语文" },
  },
  classPlanGroups: {
    "9a8b7c6d-5e4f-4a3b-8c2d-1e0f1a2b3c4d": { name: "默认", isGlobal: false },
  },
  selectedClassPlanGroupId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f1a2b3c4d",
};

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
    .run(OWNER.id, "owner", "hash", "owner", "owner", NOW);
  return db;
}

function seedDevice(db: Database.Database, lastSequence = 0, lastRequestHash: string | null = null) {
  db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,last_sequence,last_request_hash,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(DEVICE_ID, "设备", "{}", "thumb-1", lastSequence, lastRequestHash, NOW);
}

function auth(sequence: number, requestHash: string, lastSequence: number): AuthenticatedDeviceRequest {
  return { rawBody: "{}", deviceId: DEVICE_ID, sequence, timestampUtc: NOW, requestHash, deviceLastSequence: lastSequence };
}

function input(sequence: number, extra: Partial<DevicePollInput> = {}): DevicePollInput {
  return {
    deviceId: DEVICE_ID, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
    driftCount: 0, acknowledgements: [], ...extra,
  };
}

function countingSigner() {
  let calls = 0;
  return {
    signer: (body: string) => ({ keyId: "test-key", signature: `sig-${++calls}-${body.length}` }),
    calls: () => calls,
  };
}

function expectStatus(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected to throw");
  } catch (error) {
    expect((error as HttpError).statusCode).toBe(statusCode);
  }
}

function pollBody(result: { body: string }) {
  return JSON.parse(result.body) as { timetableRequired?: boolean };
}

function timetableAuditActions(db: Database.Database) {
  return (db.prepare("SELECT action FROM audit_events WHERE action LIKE 'timetable.%' OR action='configuration.adopt-from-device' ORDER BY sequence").all() as { action: string }[]).map((row) => row.action);
}

describe("device timetable upload through poll", () => {
  it("stores the full snapshot on poll and reports the accepted digest", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    const digest = computeTimetableDigest(TIMETABLE);
    const result = processDevicePoll(db, auth(1, "hash-1", 0), input(1, { timetableDigest: digest, timetable: TIMETABLE }), NOW, signer);
    expect(pollBody(result).timetableRequired).toBe(false);
    const stored = readDeviceTimetable(db, DEVICE_ID)!;
    expect(stored.digest).toBe(digest);
    expect(stored.subjectsCount).toBe(1);
    expect(stored.timeLayoutsCount).toBe(1);
    expect(stored.classPlansCount).toBe(1);
    expect(stored.classPlanGroupsCount).toBe(1);
    expect(JSON.parse(stored.snapshot)).toEqual(TIMETABLE);
    expect(timetableAuditActions(db)).toEqual(["timetable.upload"]);
    db.close();
  });

  it("does not demand a retransmit or re-audit when the stored digest already matches", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    const digest = computeTimetableDigest(TIMETABLE);
    processDevicePoll(db, auth(1, "hash-1", 0), input(1, { timetableDigest: digest, timetable: TIMETABLE }), NOW, signer);
    // 下一轮只报摘要：与服务端存档一致 → 无需全量重传，且不产生新的审计事件。
    const result = processDevicePoll(db, auth(2, "hash-2", 1), input(2, { timetableDigest: digest }), NOW, signer);
    expect(pollBody(result).timetableRequired).toBe(false);
    expect(timetableAuditActions(db)).toEqual(["timetable.upload"]);
    db.close();
  });

  it("rejects a snapshot whose digest does not match its content and keeps no archive", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    expectStatus(
      () => processDevicePoll(db, auth(1, "hash-1", 0), input(1, { timetableDigest: "0".repeat(64), timetable: TIMETABLE }), NOW, signer),
      409,
    );
    expect(readDeviceTimetable(db, DEVICE_ID)).toBeUndefined();
    expect(timetableAuditActions(db)).toEqual([]);
    db.close();
  });

  it("demands a retransmit when only a stale digest is reported", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    processDevicePoll(db, auth(1, "hash-1", 0), input(1, { timetableDigest: computeTimetableDigest(TIMETABLE), timetable: TIMETABLE }), NOW, signer);
    // 设备本地改动后仅先报新摘要，服务端存档仍是旧版 → 要求带全量重传。
    const nextDigest = computeTimetableDigest({ ...TIMETABLE, name: "高一（3）班·更新" });
    const result = processDevicePoll(db, auth(2, "hash-2", 1), input(2, { timetableDigest: nextDigest }), NOW, signer);
    expect(pollBody(result).timetableRequired).toBe(true);
    db.close();
  });

  it("adopts the stored timetable as a profile configuration, appending revisions on re-adopt", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    const digest = computeTimetableDigest(TIMETABLE);
    processDevicePoll(db, auth(1, "hash-1", 0), input(1, { timetableDigest: digest, timetable: TIMETABLE }), NOW, signer);

    const adopted = adoptTimetableAsConfiguration(db, OWNER, DEVICE_ID, {});
    expect(adopted.revision).toBe(1);
    expect(adopted.digest).toBe(digest);
    expect(adopted.name).toBe("设备 的课表档案");
    const config = db.prepare("SELECT kind,name FROM configurations WHERE id=?").get(adopted.configurationId) as { kind: string; name: string };
    expect(config.kind).toBe("profile");
    expect(config.name).toBe(adopted.name);
    // 配置文档 = { profile: 快照, schemaVersion: 1 }，可被策略引用 { "$config": id } 下发。
    const revisionRow = db.prepare("SELECT document FROM configuration_revisions WHERE id=?").get(adopted.id) as { document: string };
    expect(JSON.parse(revisionRow.document)).toEqual({ profile: TIMETABLE, schemaVersion: 1 });

    // 同一配置再次采纳 → 追加修订 R2。
    const again = adoptTimetableAsConfiguration(db, OWNER, DEVICE_ID, { configurationId: adopted.configurationId, name: "重采纳" });
    expect(again.revision).toBe(2);
    expect(again.name).toBe("重采纳");
    expect(timetableAuditActions(db)).toEqual(["timetable.upload", "configuration.adopt-from-device", "configuration.adopt-from-device"]);
    db.close();
  });

  it("refuses to adopt when the device has not uploaded a timetable", () => {
    const db = createDb();
    seedDevice(db);
    expectStatus(() => adoptTimetableAsConfiguration(db, OWNER, DEVICE_ID, {}), 409);
    db.close();
  });
});
