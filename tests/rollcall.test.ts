import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import { migrate } from "../server/migrations";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import { rollCallRosterSchema, rollCallSettingFields, rollCallSettingsSchema } from "../shared/schemas";
import {
  deleteRollCallRoster,
  listEffectiveRollCall,
  listRollCallRosters,
  listRollCallSettings,
  normalizeRollCallNames,
  resolveRollCallForDevice,
  rollCallDeliveryRevision,
  upsertRollCallRoster,
  upsertRollCallSettings,
  type RollCallSettings,
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

function saveSettings(db: Database.Database, scopeType: "school" | "organization" | "device", scopeId: string | null, values: Partial<RollCallSettings>, user = OWNER) {
  return upsertRollCallSettings(db, user, { scopeType, scopeId, ...values });
}

/** 没有任何作用域表过态：四项全交给设备本机。 */
const NO_SETTINGS: RollCallSettings = { enabled: null, notify: null, singleSeconds: null, multiSeconds: null };
const NO_SOURCES = { enabled: "local", notify: "local", singleSeconds: "local", multiSeconds: "local" } as const;
/** 未写任何设置时，生效状态里点名设置该有的样子。 */
const NO_SETTING_STATE = { settings: NO_SETTINGS, settingSources: NO_SOURCES, deviceOverride: null } as const;

const pluginContracts = readFileSync(
  new URL("../plugin/ClassIsland.Control.Plugin/Services/ProtocolContracts.cs", import.meta.url), "utf8",
);

/** 插件侧 RemoteRollCallSettings 的字段名（C# 属性名按驼峰匹配 JSON 键）。 */
function pluginSettingsFields(): string[] {
  const declaration = /record RemoteRollCallSettings\(([^)]*)\)/.exec(pluginContracts)?.[1];
  if (!declaration) throw new Error("未能在插件协议契约里找到 RemoteRollCallSettings。");
  return declaration.split(",").map((part) => {
    const name = part.trim().split(/\s+/).at(-1)!;
    return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  });
}

describe("点名名单下发", () => {
  it("没有任何名单时设备拿到空名单与修订 0", () => {
    const db = createDb();
    expect(resolveRollCallForDevice(db, DEVICE_1)).toEqual({ revision: 0, names: [], scopeType: "none", rosterId: null, ...NO_SETTING_STATE });
    db.close();
  });

  it("全校名单对所有设备生效", () => {
    const db = createDb();
    const saved = save(db, "school", null, ["张三", "李四"]);
    for (const deviceId of [DEVICE_1, DEVICE_2, DEVICE_3])
      expect(resolveRollCallForDevice(db, deviceId)).toEqual({ revision: saved.revision, names: ["张三", "李四"], scopeType: "school", rosterId: saved.id, ...NO_SETTING_STATE });
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
    expect(resolveRollCallForDevice(db, DEVICE_1)).toEqual({ revision: device.revision, names: ["设备专属"], scopeType: "device", rosterId: device.id, ...NO_SETTING_STATE });
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
    expect(resolveRollCallForDevice(db, DEVICE_1)).toEqual({ revision: 0, names: [], scopeType: "none", rosterId: null, ...NO_SETTING_STATE });
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

  it("点名设置的作用域与目标同样要匹配，且必须至少表态一项", () => {
    expect(rollCallSettingsSchema.safeParse({ scopeType: "school", scopeId: ROOT, enabled: false }).success).toBe(false);
    expect(rollCallSettingsSchema.safeParse({ scopeType: "device", enabled: false }).success).toBe(false);
    // 全不表态的行等于“这层什么都不管”， schema 直接拒，清除覆盖走同一份入参。
    expect(rollCallSettingsSchema.safeParse({ scopeType: "school" }).success).toBe(false);
    expect(rollCallSettingsSchema.safeParse({ scopeType: "school", enabled: false }).success).toBe(true);
    expect(rollCallSettingsSchema.safeParse({ scopeType: "school", singleSeconds: 0 }).success).toBe(false);
    expect(rollCallSettingsSchema.safeParse({ scopeType: "school", multiSeconds: 1 }).success).toBe(false);
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

  it("点名设置同样只能落在本人绑定的设备上", () => {
    const db = createDb();
    bindTeacher(db, DEVICE_1);
    expect(() => saveSettings(db, "device", DEVICE_1, { enabled: false }, TEACHER)).not.toThrow();
    expect(() => saveSettings(db, "device", DEVICE_2, { enabled: false }, TEACHER)).toThrow(/设备不存在/);
    expect(() => saveSettings(db, "school", null, { enabled: false }, TEACHER)).toThrow(/不足以保存全校/);
    db.close();
  });
});

describe("点名设置的逐字段继承", () => {
  it("没有任何作用域表过态时四项都是 null，由设备本机设置兜底", () => {
    const db = createDb();
    expect(resolveRollCallForDevice(db, DEVICE_1)).toMatchObject(NO_SETTING_STATE);
    db.close();
  });

  it("每个字段各自就近取值，命中层级一并返回", () => {
    const db = createDb();
    saveSettings(db, "school", null, { singleSeconds: 3, multiSeconds: 20 });
    saveSettings(db, "organization", ORG_A, { notify: false });
    saveSettings(db, "device", DEVICE_1, { enabled: false });
    expect(resolveRollCallForDevice(db, DEVICE_1)).toMatchObject({
      settings: { enabled: false, notify: false, singleSeconds: 3, multiSeconds: 20 },
      settingSources: { enabled: "device", notify: "organization", singleSeconds: "school", multiSeconds: "school" },
      // 覆盖行只回显这台设备自己那一行：界面据此把三态控件摆回“自定义”。
      deviceOverride: { enabled: false, notify: null, singleSeconds: null, multiSeconds: null },
    });
    db.close();
  });

  it("组织级设置只影响子树内的设备，深层组织覆盖浅层", () => {
    const db = createDb();
    saveSettings(db, "organization", ORG_A, { notify: true });
    saveSettings(db, "organization", ORG_B, { notify: false });
    expect(resolveRollCallForDevice(db, DEVICE_1).settings.notify).toBe(false);
    expect(resolveRollCallForDevice(db, DEVICE_2).settings.notify).toBe(true);
    // 未分组的设备不在任何子树里，组织级设置对它不生效。
    expect(resolveRollCallForDevice(db, DEVICE_3).settings.notify).toBeNull();
    db.close();
  });

  it("再次保存是整行覆盖：没再提的字段交还给上层继承", () => {
    const db = createDb();
    saveSettings(db, "school", null, { singleSeconds: 3 });
    saveSettings(db, "device", DEVICE_1, { singleSeconds: 9 });
    expect(resolveRollCallForDevice(db, DEVICE_1).settings.singleSeconds).toBe(9);
    saveSettings(db, "device", DEVICE_1, { multiSeconds: 30 });
    const after = resolveRollCallForDevice(db, DEVICE_1);
    // 覆盖行里没有 singleSeconds，设备级那一层就重新变成“不表态”。
    expect(after.settings.singleSeconds).toBe(3);
    expect(after.settingSources.singleSeconds).toBe("school");
    expect(after.settings.multiSeconds).toBe(30);
    db.close();
  });

  it("同一作用域重复保存只有一行，四项全撤回时该行被删除", () => {
    const db = createDb();
    saveSettings(db, "school", null, { enabled: true });
    saveSettings(db, "school", null, { enabled: false });
    expect(listRollCallSettings(db)).toHaveLength(1);
    expect(saveSettings(db, "school", null, { enabled: null })).toBeNull();
    expect(listRollCallSettings(db)).toEqual([]);
    expect(resolveRollCallForDevice(db, DEVICE_1).deviceOverride).toBeNull();
    db.close();
  });

  it("作用域目标必须存在且落在写入者的可见范围内", () => {
    const db = createDb();
    const missing = "99999999-9999-4999-8999-999999999999";
    expect(() => saveSettings(db, "organization", missing, { enabled: false })).toThrow(/组织不存在/);
    expect(() => saveSettings(db, "device", missing, { enabled: false })).toThrow(/设备不存在/);
    expect(() => saveSettings(db, "device", DEVICE_3, { enabled: false }, SCOPED_ADMIN)).toThrow(/设备不存在/);
    expect(() => saveSettings(db, "school", null, { enabled: false }, SCOPED_ADMIN)).toThrow(/不足以保存全校/);
    expect(() => saveSettings(db, "organization", ORG_B, { enabled: false }, SCOPED_ADMIN)).not.toThrow();
    db.close();
  });
});

/** 构造一次已通过签名校验的轮询，只看响应正文里的点名内容。 */
function poll(db: Database.Database, sequence: number, rollCallRevision: number, deviceId = DEVICE_1) {
  const input: DevicePollInput = {
    deviceId, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0,
    policyHash: "", driftCount: 0, acknowledgements: [], crashes: [], rollCallRevision,
  };
  const outcome = processDevicePoll(db, {
    rawBody: "{}", deviceId, sequence, timestampUtc: NOW,
    requestHash: `hash-${sequence}`, deviceLastSequence: sequence - 1,
  }, input, NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
  return JSON.parse(outcome.body) as {
    rollcall: { revision: number; names: string[] | null; settings: RollCallSettings } | null;
  };
}

describe("点名名单随轮询下发", () => {
  it("设备修订过期时回带整份名单，一致时不再回带", () => {
    const db = createDb();
    save(db, "school", null, ["张三", "李四"]);
    const current = rollCallDeliveryRevision(db);
    expect(poll(db, 1, 0).rollcall).toEqual({ revision: current, names: ["张三", "李四"], settings: NO_SETTINGS });
    // 设备已应用同一修订：响应里不再重复携带名单本体。
    expect(poll(db, 2, current).rollcall).toBeNull();
    db.close();
  });

  it("改名后修订前进，设备下一轮就拿到新名单", () => {
    const db = createDb();
    save(db, "school", null, ["张三"]);
    const applied = poll(db, 1, 0).rollcall!;
    save(db, "school", null, ["王五"]);
    const current = rollCallDeliveryRevision(db);
    expect(current).toBeGreaterThan(applied.revision);
    expect(poll(db, 2, applied.revision).rollcall).toEqual({ revision: current, names: ["王五"], settings: NO_SETTINGS });
    db.close();
  });

  it("没有指派名单的设备拿到 names:null，据此回落到本机名字表", () => {
    const db = createDb();
    save(db, "organization", ORG_A, ["教学楼生"]);
    // DEVICE_3 不在任何组织下，生效链上没有名单。此时若回带 [] 就会抹掉设备本机的
    // 名字表，等于连上集控反而不能离线点名。
    expect(poll(db, 1, 0, DEVICE_3).rollcall).toMatchObject({ names: null });
    db.close();
  });

  it("只改设置不碰名单，设备下一轮也会拿到整份点名内容", () => {
    const db = createDb();
    save(db, "school", null, ["张三"]);
    const applied = poll(db, 1, 0).rollcall!;
    saveSettings(db, "school", null, { enabled: false });
    const delivered = poll(db, 2, applied.revision).rollcall!;
    expect(delivered.settings.enabled).toBe(false);
    // 名单与设置是一起应用的：设备侧存的是同一份快照，只回带半份会留下旧名单。
    expect(delivered.names).toEqual(["张三"]);
    expect(poll(db, 3, delivered.revision).rollcall).toBeNull();
    db.close();
  });

  it("下发的设置字段名与插件契约逐字对齐", () => {
    // 插件按属性名匹配 JSON 键：任何一侧改名都会变成“下发成功但设备收到 null”，
    // 因此用真实的轮询响应正文对一次字面量。
    expect(pluginSettingsFields()).toEqual(["enabled", "notify", "singleSeconds", "multiSeconds"]);
    const db = createDb();
    saveSettings(db, "school", null, { enabled: false });
    const delivered = poll(db, 1, 0).rollcall!;
    expect(Object.keys(delivered.settings).sort()).toEqual([...pluginSettingsFields()].sort());
    db.close();
  });

  it("界面字段表、入参 schema 与插件契约三方同键同上下界", () => {
    // 界面按字段表渲染，服务端按 schema 收，设备端按 record 取：
    // 三者任一处改名或改上下界，都会变成“界面能填、服务端收下、设备不认”。
    expect(rollCallSettingFields.map((field) => field.key)).toEqual(pluginSettingsFields());
    for (const field of rollCallSettingFields) {
      if (field.kind !== "number") continue;
      // 上下界写进 schema，界面越界填的值该被服务端拒掉。
      expect(rollCallSettingsSchema.safeParse({ scopeType: "school", [field.key]: field.min - 1 }).success).toBe(false);
      expect(rollCallSettingsSchema.safeParse({ scopeType: "school", [field.key]: field.max + 1 }).success).toBe(false);
      expect(rollCallSettingsSchema.safeParse({ scopeType: "school", [field.key]: field.min }).success).toBe(true);
      expect(rollCallSettingsSchema.safeParse({ scopeType: "school", [field.key]: field.max }).success).toBe(true);
    }
  });
});