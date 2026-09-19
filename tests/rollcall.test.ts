import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import { migrate } from "../server/migrations";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import { rollCallRosterSchema } from "../shared/schemas";
import {
  deleteRollCallRoster,
  listEffectiveRollCall,
  listRollCallRosters,
  normalizeRollCallNames,
  resolveRollCallForDevice,
  upsertRollCallRoster,
} from "../server/utils/rollcall";

const NOW = "2026-09-11T00:00:00.000Z";
const OWNER = { id: "owner-1", role: "owner", scopeOrgNodeId: null };
const ROOT = "11111111-1111-4111-8111-111111111111";
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
/** 只看得见 ORG_A 子树的账号。 */
const SCOPED_ADMIN = { id: "admin-1", role: "admin", scopeOrgNodeId: ORG_A };
/** 权限全部来自 device_teachers 绑定，与组织子树无关。 */
const TEACHER = { id: "teacher-1", role: "teacher", scopeOrgNodeId: null };
const DEVICE_1 = "44444444-4444-4444-8444-444444444444";
const DEVICE_2 = "55555555-5555-4555-8555-555555555555";
const DEVICE_3 = "66666666-6666-4666-8666-666666666666";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)")
    .run(ROOT, null, "全校", "/", 0, NOW);
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)")
    .run(ORG_A, ROOT, "教学楼", "/org-a", 0, NOW);
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)")
    .run(ORG_B, ORG_A, "一楼", "/org-a/org-b", 0, NOW);
  const insertUser = db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)");
  insertUser.run(OWNER.id, "owner", "hash", "管理员", "owner", null, NOW);
  insertUser.run(SCOPED_ADMIN.id, "scoped", "hash", "楼栋管理员", "admin", ORG_A, NOW);
  insertUser.run(TEACHER.id, "t1", "hash", "任课教师", "teacher", null, NOW);
  const insertDevice = db.prepare(
    "INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?,?)",
  );
  insertDevice.run(DEVICE_1, "教室机 1", ORG_B, "{}", "thumb-1", NOW);
  insertDevice.run(DEVICE_2, "教室机 2", ORG_A, "{}", "thumb-2", NOW);
  insertDevice.run(DEVICE_3, "未分组机", null, "{}", "thumb-3", NOW);
  return db;
}

function bindTeacher(db: Database.Database, deviceId: string, userId = TEACHER.id) {
  db.prepare("INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,'admin',?)").run(deviceId, userId, NOW);
}

function save(db: Database.Database, scopeType: "school" | "organization" | "device", scopeId: string | null, names: string[], user = OWNER) {
  return upsertRollCallRoster(db, user, { name: `${scopeType} 名单`, scopeType, scopeId, names });
}

describe("点名名单下发", () => {
  it("没有任何名单时设备拿到空名单与修订 0", () => {
    const db = createDb();
    expect(resolveRollCallForDevice(db, DEVICE_1)).toEqual({ revision: 0, names: [], scopeType: "none", rosterId: null });
    db.close();
  });

  it("全校名单对所有设备生效", () => {
    const db = createDb();
    const saved = save(db, "school", null, ["张三", "李四"]);
    for (const deviceId of [DEVICE_1, DEVICE_2, DEVICE_3])
      expect(resolveRollCallForDevice(db, deviceId)).toEqual({ revision: saved.revision, names: ["张三", "李四"], scopeType: "school", rosterId: saved.id });
    db.close();
  });

  it("按 设备 → 最近的组织 → 全校 的优先级解析", () => {
    const db = createDb();
    save(db, "school", null, ["全校生"]);
    save(db, "organization", ORG_A, ["教学楼生"]);
    save(db, "organization", ORG_B, ["一楼生"]);
    expect(resolveRollCallForDevice(db, DEVICE_1).names).toEqual(["一楼生"]);
    expect(resolveRollCallForDevice(db, DEVICE_2).names).toEqual(["教学楼生"]);
    expect(resolveRollCallForDevice(db, DEVICE_3).names).toEqual(["全校生"]);

    const device = save(db, "device", DEVICE_1, ["设备专属"]);
    expect(resolveRollCallForDevice(db, DEVICE_1)).toEqual({ revision: device.revision, names: ["设备专属"], scopeType: "device", rosterId: device.id });
    // 命中层级随名单一起返回：教师据此知道这份名单是不是自己改得动的。
    expect(resolveRollCallForDevice(db, DEVICE_3).scopeType).toBe("school");
    db.close();
  });

  it("同一作用域重复保存是覆盖，不会产生第二份名单", () => {
    const db = createDb();
    const first = save(db, "school", null, ["张三"]);
    const second = save(db, "school", null, ["李四"]);
    expect(listRollCallRosters(db)).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(resolveRollCallForDevice(db, DEVICE_1).names).toEqual(["李四"]);
    db.close();
  });

  it("删除名单同样推进修订号，设备会解析回上一级或空名单", () => {
    const db = createDb();
    const school = save(db, "school", null, ["全校生"]);
    const device = save(db, "device", DEVICE_1, ["设备专属"]);
    expect(deleteRollCallRoster(db, OWNER, device.id)).toBe(true);
    const afterDeviceDelete = resolveRollCallForDevice(db, DEVICE_1);
    expect(afterDeviceDelete.names).toEqual(["全校生"]);
    expect(afterDeviceDelete.revision).toBe(school.revision);
    expect(deleteRollCallRoster(db, OWNER, school.id)).toBe(true);
    // 名单全部撤下后修订回到 0：设备据此清空本地缓存。
    expect(resolveRollCallForDevice(db, DEVICE_1)).toEqual({ revision: 0, names: [], scopeType: "none", rosterId: null });
    expect(deleteRollCallRoster(db, OWNER, school.id)).toBe(false);
    db.close();
  });

  it("写入前去空白行与重复姓名", () => {
    expect(normalizeRollCallNames([" 张三 ", "", "张三", "李四", "  "])).toEqual(["张三", "李四"]);
  });

  it("作用域目标必须存在且落在写入者的可见范围内", () => {
    const db = createDb();
    const missing = "99999999-9999-4999-8999-999999999999";
    expect(() => save(db, "organization", missing, ["张三"])).toThrow(/组织不存在/);
    expect(() => save(db, "device", missing, ["张三"])).toThrow(/设备不存在/);
    // 组织范围账号不能给范围外的设备写名单。
    expect(() => save(db, "device", DEVICE_3, ["张三"], SCOPED_ADMIN)).toThrow(/设备不存在/);
    expect(() => save(db, "organization", ORG_B, ["张三"], SCOPED_ADMIN)).not.toThrow();
    db.close();
  });

  it("作用域与目标必须匹配", () => {
    expect(rollCallRosterSchema.safeParse({ name: "名单", scopeType: "school", scopeId: ROOT, names: [] }).success).toBe(false);
    expect(rollCallRosterSchema.safeParse({ name: "名单", scopeType: "device", names: [] }).success).toBe(false);
    expect(rollCallRosterSchema.safeParse({ name: "名单", scopeType: "device", scopeId: DEVICE_1, names: ["张三"] }).success).toBe(true);
  });
});

describe("教师范围内的点名名单", () => {
  it("只能给本人绑定的设备保存名单", () => {
    const db = createDb();
    bindTeacher(db, DEVICE_1);
    expect(() => save(db, "device", DEVICE_1, ["张三"], TEACHER)).not.toThrow();
    // 未绑定的设备按不存在处理，不泄露它是否存在。
    expect(() => save(db, "device", DEVICE_2, ["张三"], TEACHER)).toThrow(/设备不存在/);
    db.close();
  });

  it("碰不到全校与组织名单", () => {
    const db = createDb();
    bindTeacher(db, DEVICE_1);
    expect(() => save(db, "school", null, ["张三"], TEACHER)).toThrow(/不足以保存全校/);
    expect(() => save(db, "organization", ORG_B, ["张三"], TEACHER)).toThrow(/组织不存在/);
    db.close();
  });

  it("逐台生效名单按调用者范围收敛", () => {
    const db = createDb();
    save(db, "school", null, ["全校生"]);
    save(db, "device", DEVICE_1, ["本班生"]);
    expect(listEffectiveRollCall(db, OWNER).map((row) => row.deviceId))
      .toEqual([DEVICE_1, DEVICE_2, DEVICE_3]);
    expect(listEffectiveRollCall(db, SCOPED_ADMIN).map((row) => row.deviceId))
      .toEqual([DEVICE_1, DEVICE_2]);

    bindTeacher(db, DEVICE_1);
    const visible = listEffectiveRollCall(db, TEACHER);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ deviceId: DEVICE_1, deviceName: "教室机 1", names: ["本班生"], scopeType: "device" });
    db.close();
  });

  it("停用设备不出现在逐台名单里", () => {
    const db = createDb();
    bindTeacher(db, DEVICE_1);
    db.prepare("UPDATE devices SET disabled_at=? WHERE id=?").run(NOW, DEVICE_1);
    expect(listEffectiveRollCall(db, TEACHER)).toEqual([]);
    db.close();
  });
});

/** 构造一次已通过签名校验的轮询，只看响应正文里的点名名单字段。 */
function poll(db: Database.Database, sequence: number, rollCallRevision: number) {
  const input: DevicePollInput = {
    deviceId: DEVICE_1, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0,
    policyHash: "", driftCount: 0, acknowledgements: [], crashes: [], rollCallRevision,
  };
  const outcome = processDevicePoll(db, {
    rawBody: "{}", deviceId: DEVICE_1, sequence, timestampUtc: NOW,
    requestHash: `hash-${sequence}`, deviceLastSequence: sequence - 1,
  }, input, NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
  return JSON.parse(outcome.body) as { rollcall: { revision: number; names: string[] } | null };
}

describe("点名名单随轮询下发", () => {
  it("设备修订过期时回带整份名单，一致时不再回带", () => {
    const db = createDb();
    const saved = save(db, "school", null, ["张三", "李四"]);
    const first = poll(db, 1, 0);
    expect(first.rollcall).toEqual({ revision: saved.revision, names: ["张三", "李四"] });
    // 设备已应用同一修订：响应里不再重复携带名单本体。
    expect(poll(db, 2, saved.revision).rollcall).toBeNull();
    db.close();
  });

  it("改名后修订前进，设备下一轮就拿到新名单", () => {
    const db = createDb();
    save(db, "school", null, ["张三"]);
    const applied = poll(db, 1, 0).rollcall!;
    const updated = save(db, "school", null, ["王五"]);
    expect(updated.revision).toBeGreaterThan(applied.revision);
    expect(poll(db, 2, applied.revision).rollcall).toEqual({ revision: updated.revision, names: ["王五"] });
    db.close();
  });
});