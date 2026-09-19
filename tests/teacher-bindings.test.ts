import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { sha256 } from "../server/utils/security";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import {
  BINDING_CODE_TTL_MS,
  bindTeacher,
  issueBindingCode,
  listDeviceTeachers,
  listTeacherDevices,
  redeemBindingCode,
  unbindTeacher,
} from "../server/utils/teacher-bindings";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

const NOW = "2026-09-19T00:00:00.000Z";
const LATER = "2026-09-19T00:10:00.000Z";
const DEVICE_1 = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";
const DEVICE_2 = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedDevice(db: Database.Database, id = DEVICE_1, name = "讲台机", disabledAt: string | null = null) {
  db.prepare(`INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,transport,created_at,disabled_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, name, "{}", `thumb-${id}`, "http", NOW, disabledAt);
}

function seedUser(db: Database.Database, id: string, username: string, role = "teacher", displayName = `老师-${username}`) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,created_at)
    VALUES (?,?,?,?,?,?)`).run(id, username, "hash", displayName, role, NOW);
}

function bindingRows(db: Database.Database) {
  return db.prepare("SELECT device_id deviceId,user_id userId,bound_by boundBy FROM device_teachers ORDER BY device_id,user_id").all() as
    { deviceId: string; userId: string; boundBy: string }[];
}

function codeState(db: Database.Database, deviceId = DEVICE_1) {
  return db.prepare("SELECT binding_code_hash hash,binding_code_expires_at expiresAt FROM devices WHERE id=?").get(deviceId) as
    { hash: string | null; expiresAt: string | null };
}

function auditRows(db: Database.Database) {
  return db.prepare("SELECT action,summary FROM audit_events WHERE action LIKE 'device.teacher.%' ORDER BY sequence").all() as
    { action: string; summary: string }[];
}

function expectStatus(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected binding operation to fail");
  } catch (error) {
    expect((error as HttpError).statusCode).toBe(statusCode);
  }
}

/** 构造一次已通过签名校验的轮询，只看响应正文里的绑定码字段。 */
function poll(db: Database.Database, sequence: number, bindingCodeRequested: boolean) {
  const input: DevicePollInput = {
    deviceId: DEVICE_1, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0,
    policyHash: "", driftCount: 0, acknowledgements: [], crashes: [], rollCallRevision: 0, bindingCodeRequested,
  };
  const outcome = processDevicePoll(db, {
    rawBody: "{}", deviceId: DEVICE_1, sequence, timestampUtc: NOW,
    requestHash: `hash-${sequence}`, deviceLastSequence: sequence - 1,
  }, input, NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
  return JSON.parse(outcome.body) as { bindingCode: { code: string; expiresAt: string } | null };
}

describe("binding code issuance", () => {
  it("stores only the hash and an expiring window", () => {
    const db = createDb();
    seedDevice(db);
    const issued = issueBindingCode(db, DEVICE_1, NOW);
    expect(issued.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{10}$/);
    expect(issued.expiresAt).toBe(new Date(Date.parse(NOW) + BINDING_CODE_TTL_MS).toISOString());
    const state = codeState(db);
    expect(state.hash).toBe(sha256(issued.code));
    expect(state.hash).not.toContain(issued.code);
    expect(state.expiresAt).toBe(issued.expiresAt);
    db.close();
  });

  it("each request replaces the previous code", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san");
    const first = issueBindingCode(db, DEVICE_1, NOW);
    const second = issueBindingCode(db, DEVICE_1, NOW);
    expect(second.code).not.toBe(first.code);
    expect(codeState(db).hash).toBe(sha256(second.code));
    expectStatus(() => redeemBindingCode(db, "t1", DEVICE_1, first.code, NOW), 403);
    expect(redeemBindingCode(db, "t1", DEVICE_1, second.code, NOW).created).toBe(true);
    db.close();
  });
});

describe("binding code redemption", () => {
  it("turns a valid code into a qr-sourced binding and burns the code", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san");
    const issued = issueBindingCode(db, DEVICE_1, NOW);

    expect(redeemBindingCode(db, "t1", DEVICE_1, issued.code, NOW)).toEqual({ deviceId: DEVICE_1, userId: "t1", created: true });
    expect(bindingRows(db)).toEqual([{ deviceId: DEVICE_1, userId: "t1", boundBy: "qr" }]);
    expect(codeState(db)).toEqual({ hash: null, expiresAt: null });
    expect(auditRows(db)).toEqual([{ action: "device.teacher.bind", summary: "教师 老师-zhang.san 扫码绑定设备 讲台机" }]);
    // 同一个码二次兑换：已作废，按无效处理。
    expectStatus(() => redeemBindingCode(db, "t1", DEVICE_1, issued.code, NOW), 403);
    db.close();
  });

  it("reports one indistinguishable failure for wrong, missing and expired codes", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san");
    const issued = issueBindingCode(db, DEVICE_1, NOW);
    expectStatus(() => redeemBindingCode(db, "t1", DEVICE_1, "ZZZZZZZZZZ", NOW), 403);
    // 校验失败不作废在手的有效码。
    expect(codeState(db).hash).toBe(sha256(issued.code));
    expectStatus(() => redeemBindingCode(db, "t1", DEVICE_1, issued.code, LATER), 403);
    db.prepare("UPDATE devices SET binding_code_hash=NULL,binding_code_expires_at=NULL WHERE id=?").run(DEVICE_1);
    expectStatus(() => redeemBindingCode(db, "t1", DEVICE_1, issued.code, NOW), 403);
    expect(bindingRows(db)).toEqual([]);
    db.close();
  });

  it("rejects unknown or disabled devices without touching the caller's bindings", () => {
    const db = createDb();
    seedDevice(db, DEVICE_2, "停用机", LATER);
    seedUser(db, "t1", "zhang.san");
    expectStatus(() => redeemBindingCode(db, "t1", "missing-id", "ABCDEFGHIJ", NOW), 404);
    expectStatus(() => redeemBindingCode(db, "t1", DEVICE_2, "ABCDEFGHIJ", NOW), 404);
    db.close();
  });

  it("is idempotent for a repeat scan of the same device", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san");
    bindTeacher(db, "admin", DEVICE_1, "t1", NOW);
    const issued = issueBindingCode(db, DEVICE_1, NOW);
    expect(redeemBindingCode(db, "t1", DEVICE_1, issued.code, NOW)).toEqual({ deviceId: DEVICE_1, userId: "t1", created: false });
    expect(bindingRows(db)).toEqual([{ deviceId: DEVICE_1, userId: "t1", boundBy: "admin" }]);
    expect(auditRows(db)).toHaveLength(1);
    db.close();
  });
});

describe("administrative binding", () => {
  it("binds many teachers to one device and lists them", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san", "teacher", "张三");
    seedUser(db, "t2", "li.si", "teacher", "李四");
    expect(bindTeacher(db, "admin", DEVICE_1, "t1", NOW).created).toBe(true);
    expect(bindTeacher(db, "admin", DEVICE_1, "t2", LATER).created).toBe(true);
    expect(bindTeacher(db, "admin", DEVICE_1, "t1", LATER).created).toBe(false);
    expect(listDeviceTeachers(db, DEVICE_1).map((row) => `${row.displayName}:${row.boundBy}`)).toEqual(["张三:admin", "李四:admin"]);
    expect(bindingRows(db)).toHaveLength(2);
    expect(auditRows(db)).toHaveLength(2);
    db.close();
  });

  it("refuses a device or teacher that is not bindable", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san");
    expectStatus(() => bindTeacher(db, "admin", "missing", "t1", NOW), 404);
    expectStatus(() => bindTeacher(db, "admin", DEVICE_1, "missing", NOW), 404);
    db.prepare("UPDATE users SET disabled_at=? WHERE id='t1'").run(LATER);
    expectStatus(() => bindTeacher(db, "admin", DEVICE_1, "t1", NOW), 404);
    db.close();
  });

  it("unbinds and reports nothing-left-to-remove", () => {
    const db = createDb();
    seedDevice(db);
    seedUser(db, "t1", "zhang.san");
    seedUser(db, "t2", "li.si");
    bindTeacher(db, "admin", DEVICE_1, "t1", NOW);
    bindTeacher(db, "admin", DEVICE_1, "t2", NOW);
    expect(unbindTeacher(db, "t1", DEVICE_1, "t1", LATER)).toBe(true);
    expect(bindingRows(db)).toEqual([{ deviceId: DEVICE_1, userId: "t2", boundBy: "admin" }]);
    expect(unbindTeacher(db, "t1", DEVICE_1, "t1", LATER)).toBe(false);
    expect(auditRows(db).map((row) => row.action)).toEqual(["device.teacher.bind", "device.teacher.bind", "device.teacher.unbind"]);
    db.close();
  });

  it("drops bindings and devices along with their rows", () => {
    const db = createDb();
    seedDevice(db);
    seedDevice(db, DEVICE_2, "第二台");
    seedUser(db, "t1", "zhang.san");
    bindTeacher(db, "admin", DEVICE_1, "t1", NOW);
    bindTeacher(db, "admin", DEVICE_2, "t1", LATER);
    expect(listTeacherDevices(db, "t1").map((row) => row.deviceName)).toEqual(["第二台", "讲台机"]);
    db.prepare("DELETE FROM devices WHERE id=?").run(DEVICE_1);
    expect(bindingRows(db)).toEqual([{ deviceId: DEVICE_2, userId: "t1", boundBy: "admin" }]);
    db.prepare("DELETE FROM users WHERE id='t1'").run();
    expect(bindingRows(db)).toEqual([]);
    db.close();
  });
});

describe("binding code over the poll channel", () => {
  it("delivers the code only to the device that asked and caches it with the response", () => {
    const db = createDb();
    seedDevice(db);
    expect(poll(db, 1, false).bindingCode).toBeNull();
    expect(codeState(db).hash).toBeNull();

    const asked = poll(db, 2, true);
    expect(asked.bindingCode?.code).toMatch(/^[A-Za-z2-9]{10}$/);
    expect(codeState(db)).toEqual({ hash: sha256(asked.bindingCode!.code), expiresAt: asked.bindingCode!.expiresAt });
    // 同序列重放回到缓存字节：屏上的码不会因为一次丢包而换掉。
    const replayed = processDevicePoll(db, {
      rawBody: "{}", deviceId: DEVICE_1, sequence: 2, timestampUtc: NOW,
      requestHash: "hash-2", deviceLastSequence: 2,
    }, { ...pollInput(2, true) }, NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
    expect(JSON.parse(replayed.body).bindingCode).toEqual(asked.bindingCode);
    db.close();
  });
});

function pollInput(sequence: number, bindingCodeRequested: boolean): DevicePollInput {
  return {
    deviceId: DEVICE_1, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0,
    policyHash: "", driftCount: 0, acknowledgements: [], crashes: [], rollCallRevision: 0, bindingCodeRequested,
  };
}
