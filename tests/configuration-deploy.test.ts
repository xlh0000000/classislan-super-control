import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { deployConfiguration } from "../server/utils/deploy";
import { materializeConfigReferences, publishPolicy, resolvePolicyForDeviceFromDb } from "../server/utils/policy";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

// 物化配置引用需要数据库句柄；策略模块直接导入 useDatabase，因此用模块级替身指到内存库。
const hoisted = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, useDatabase: () => hoisted.db };
});

const NOW = "2026-09-12T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { id: "user-owner", role: "owner" };
const scoped = { id: "user-scoped", role: "admin", scopeOrgNodeId: uuid(90) };
/** 教师权限只来自 device_teachers 绑定。 */
const teacher = { id: "user-teacher", role: "teacher" };

/** 课表页保存的 profile 配置文档就是 ClassIsland 原始档案结构。 */
const PROFILE_DOCUMENT = { schemaVersion: 1, name: "高一(1)班", timeLayouts: { [uuid(60)]: { name: "默认", layouts: [] } } };

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const org = db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,0,?)");
  org.run(uuid(90), null, "root", "/", NOW);
  org.run(uuid(91), uuid(90), "child", "/child", NOW);
  const user = db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)");
  user.run(owner.id, "owner", "hash", "owner", "owner", null, NOW);
  user.run(scoped.id, "scoped", "hash", "scoped", "admin", uuid(90), NOW);
  user.run(teacher.id, "teacher", "hash", "teacher", "teacher", null, NOW);
  const device = db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?,?)");
  device.run(uuid(1), "高一(1)班", uuid(91), "{}", "thumb-1", NOW);
  device.run(uuid(2), "高一(2)班", null, "{}", "thumb-2", NOW);
  device.run(uuid(3), "高二(1)班", null, "{}", "thumb-3", NOW);
  db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,?,?)").run(uuid(5), "高三", "#526b59", NOW);
  db.prepare("INSERT INTO device_tags (device_id,tag_id) VALUES (?,?)").run(uuid(2), uuid(5));
  hoisted.db = db;
  return db;
}

function seedConfiguration(db: Database.Database, id: string, kind: string, document: Record<string, unknown>, name = "高一(1)班档案") {
  db.prepare("INSERT INTO configurations (id,kind,name,updated_at) VALUES (?,?,?,?)").run(id, kind, name, NOW);
  const revisionId = `${id}:1`;
  db.prepare("INSERT INTO configuration_revisions (id,configuration_id,kind,name,revision,document,document_hash,created_by,created_at) VALUES (?,?,?,?,1,?,?,?,?)")
    .run(revisionId, id, kind, name, JSON.stringify(document), "hash", owner.id, NOW);
  db.prepare("UPDATE configurations SET current_revision_id=? WHERE id=?").run(revisionId, id);
}

/** 教师对设备的下发权限完全来自绑定行。 */
function bindTeacher(db: Database.Database, deviceId: string) {
  db.prepare("INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,'admin',?)").run(deviceId, teacher.id, NOW);
}

function activeAssignment(db: Database.Database, scopeType: string, scopeId: string | null) {
  return db.prepare(`SELECT pr.revision revision,pr.document document,pa.locks locks,pa.priority priority
    FROM policy_assignments pa JOIN policy_revisions pr ON pr.id=pa.policy_revision_id
    WHERE pa.superseded_at IS NULL AND pa.scope_type=? AND pa.scope_key=?`).get(scopeType, scopeId ?? "") as
    { revision: number; document: string; locks: string; priority: number } | undefined;
}

/** 越权目标由 scope 断言抛 H3 错误，业务冲突抛 PolicyError：两者都只校验状态码。 */
function expectPolicyError(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as HttpError).statusCode).toBe(statusCode);
  }
}

describe("configuration deploy", () => {
  it("targets only the selected device", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    const result = deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "device", id: uuid(1) }] }, owner);
    expect(result.section).toBe("profile");
    expect(result.deviceCount).toBe(1);
    expect(result.targets).toEqual([{ scopeType: "device", scopeId: uuid(1), revision: 1, deviceCount: 1, replacedSection: false }]);
    expect(resolvePolicyForDeviceFromDb(db, uuid(1)).document).toEqual({ profile: { $config: uuid(10) } });
    expect(resolvePolicyForDeviceFromDb(db, uuid(2)).document).toEqual({});
    expect(activeAssignment(db, "device", uuid(2))).toBeUndefined();
  });

  it("resolves the deployed reference into the configuration document", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "device", id: uuid(1) }] }, owner);
    const resolved = resolvePolicyForDeviceFromDb(db, uuid(1));
    expect(materializeConfigReferences(resolved.document)).toEqual({ profile: PROFILE_DOCUMENT });
  });

  it("merges into the target scope without dropping other sections or locks", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    publishPolicy(db, {
      name: "学校基线", document: { settings: { theme: 2 } }, scopeType: "school", scopeId: null,
      priority: 5, locks: ["/settings"], baseRevision: 0,
    }, owner, NOW);
    deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "school" }] }, owner);
    const assignment = activeAssignment(db, "school", null)!;
    expect(JSON.parse(assignment.document)).toEqual({ settings: { theme: 2 }, profile: { $config: uuid(10) } });
    expect(assignment.locks).toBe("[\"/settings\"]");
    expect(assignment.priority).toBe(5);
    expect(assignment.revision).toBe(2);
  });

  it("reports replaced sections and bumps the revision on re-deploy", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    seedConfiguration(db, uuid(11), "profile", { schemaVersion: 1, name: "高一(2)班" });
    const first = deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "device", id: uuid(1) }] }, owner);
    expect(first.targets[0]!.replacedSection).toBe(false);
    const second = deployConfiguration(db, { configurationId: uuid(11), targets: [{ type: "device", id: uuid(1) }] }, owner);
    expect(second.targets[0]).toMatchObject({ revision: 2, replacedSection: true });
    expect(resolvePolicyForDeviceFromDb(db, uuid(1)).document).toEqual({ profile: { $config: uuid(11) } });
  });

  it("counts distinct devices across organization, tag and explicit targets", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    const result = deployConfiguration(db, {
      configurationId: uuid(10),
      targets: [{ type: "organization", id: uuid(90) }, { type: "tag", id: uuid(5) }, { type: "device", id: uuid(1) }, { type: "device", id: uuid(3) }],
    }, owner);
    expect(result.targets.map((target) => target.deviceCount)).toEqual([1, 1, 1, 1]);
    // 设备 A 同时命中组织与显式目标，只计一次。
    expect(result.deviceCount).toBe(3);
    expect(result.targets).toHaveLength(4);
  });

  it("deduplicates repeated targets", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    const result = deployConfiguration(db, {
      configurationId: uuid(10),
      targets: [{ type: "device", id: uuid(1) }, { type: "device", id: uuid(1) }, { type: "device", id: uuid(1) }],
    }, owner);
    expect(result.targets).toHaveLength(1);
    expect(result.deviceCount).toBe(1);
    expect(activeAssignment(db, "device", uuid(1))!.revision).toBe(1);
  });

  it("rejects unknown configurations and out-of-scope targets", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(99), targets: [{ type: "device", id: uuid(1) }] }, owner), 404);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "school" }] }, scoped), 403);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "device", id: uuid(2) }] }, scoped), 404);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "organization", id: uuid(99) }] }, owner), 404);
  });

  it("rolls back every target when one of them fails", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    expectPolicyError(() => deployConfiguration(db, {
      configurationId: uuid(10),
      targets: [{ type: "device", id: uuid(1) }, { type: "device", id: uuid(99) }],
    }, owner), 404);
    expect(activeAssignment(db, "device", uuid(1))).toBeUndefined();
  });
});

describe("教师下发课表", () => {
  it("可以把课表套到自己绑定的设备上", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    bindTeacher(db, uuid(1));
    const result = deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "device", id: uuid(1) }] }, teacher);
    expect(result.section).toBe("profile");
    expect(resolvePolicyForDeviceFromDb(db, uuid(1)).document).toEqual({ profile: { $config: uuid(10) } });
    expect((db.prepare("SELECT actor_id actorId FROM audit_events WHERE action='configuration.deploy'").get() as { actorId: string }).actorId).toBe(teacher.id);
  });

  it("碰不到别人的设备与全校、标签、组织范围", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    bindTeacher(db, uuid(1));
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "device", id: uuid(2) }] }, teacher), 404);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "school" }] }, teacher), 403);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "tag", id: uuid(5) }] }, teacher), 403);
    expectPolicyError(() => deployConfiguration(db, { configurationId: uuid(10), targets: [{ type: "organization", id: uuid(91) }] }, teacher), 404);
    expect(activeAssignment(db, "device", uuid(1))).toBeUndefined();
  });

  it("掺进一个越权目标时整批回滚", () => {
    const db = createDb();
    seedConfiguration(db, uuid(10), "profile", PROFILE_DOCUMENT);
    bindTeacher(db, uuid(1));
    expectPolicyError(() => deployConfiguration(db, {
      configurationId: uuid(10),
      targets: [{ type: "device", id: uuid(1) }, { type: "device", id: uuid(3) }],
    }, teacher), 404);
    expect(activeAssignment(db, "device", uuid(1))).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) count FROM audit_events WHERE action='configuration.deploy'").get()).toMatchObject({ count: 0 });
  });
});