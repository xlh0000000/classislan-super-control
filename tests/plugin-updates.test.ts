import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import {
  assertPluginTargetScope,
  comparePluginVersions,
  deletePluginUpdateTarget,
  resolvePluginUpdateTarget,
  upsertPluginUpdateTarget,
} from "../server/utils/plugin-updates";
import { pluginReleasesWithDistribution, pluginUpdateTargetsInView } from "../server/utils/plugin-release-views";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

// 发布物是否真在磁盘上由数据目录决定，这里只关心归类逻辑，指到一个空临时目录即可。
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, databasePath: () => "/tmp/classisland-control-tests/unused/classisland-control.db" };
});

const NOW = "2026-09-21T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { id: "user-owner", role: "owner" };
const schoolWideAdmin = { id: "user-admin", role: "admin" };
const scopedAdmin = { id: "user-scoped", role: "admin", scopeOrgNodeId: uuid(92) };
const teacher = { id: "user-teacher", role: "teacher" };

/**
 * 组织树：root(90) > 年级(91) > 高一(2)班所在节点(92)。
 * 设备：dev-class 挂在最深的 92 上并带 tag-高3(5)；dev-plain 无组织无标签；dev-other 在 91。
 */
function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const org = db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)");
  org.run(uuid(90), null, "root", "/", 0, NOW);
  org.run(uuid(91), uuid(90), "grade", "/grade", 1, NOW);
  org.run(uuid(92), uuid(91), "class", "/grade/class", 2, NOW);
  const user = db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)");
  user.run(owner.id, "owner", "hash", "owner", "owner", null, NOW);
  user.run(schoolWideAdmin.id, "admin", "hash", "admin", "admin", null, NOW);
  user.run(scopedAdmin.id, "scoped", "hash", "scoped", "admin", uuid(92), NOW);
  user.run(teacher.id, "teacher", "hash", "teacher", "teacher", null, NOW);
  db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,?,?)").run(uuid(5), "高三", "#526b59", NOW);
  const device = db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,plugin_version,created_at) VALUES (?,?,?,?,?,?,?)");
  device.run(uuid(1), "高一(1)班", uuid(92), "{}", "t1", "0.1.6.0", NOW);
  device.run(uuid(2), "无归属", null, "{}", "t2", "0.1.6.0", NOW);
  device.run(uuid(3), "年级直属", uuid(91), "{}", "t3", "0.1.6.0", NOW);
  db.prepare("INSERT INTO device_tags (device_id,tag_id) VALUES (?,?)").run(uuid(1), uuid(5));
  db.prepare("INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,'admin',?)").run(uuid(1), teacher.id, NOW);
  return db;
}

function addRelease(db: Database.Database, version: string, isCurrent = false) {
  db.prepare("INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_at) VALUES (?,?,?,?,?,?)")
    .run(version, `${version}.cipx`, 1024, "a".repeat(64), isCurrent ? 1 : 0, NOW);
}

describe("插件目标版本解析", () => {
  it("按四段数字比较，脏版本号排最后", () => {
    expect(comparePluginVersions("0.1.10.0", "0.1.9.0")).toBeGreaterThan(0);
    expect(comparePluginVersions("0.1.7.1", "0.1.7.0")).toBeGreaterThan(0);
    expect(comparePluginVersions("0.1.7.0", "0.1.7.0")).toBe(0);
    // 非四段（旧插件报的 "0.1.7" 或空串）不能被当成目标：比对结果永远偏小。
    expect(comparePluginVersions("", "0.1.7.0")).toBeLessThan(0);
    expect(comparePluginVersions("0.1.7", "0.1.7.0")).toBeLessThan(0);
    expect(comparePluginVersions("0.1.7.0", "乱码")).toBeGreaterThan(0);
  });

  it("没有任何目标时跟着当前版本走", () => {
    const db = createDb();
    expect(resolvePluginUpdateTarget(db, uuid(1))).toBeNull();
    addRelease(db, "0.1.6.0");
    addRelease(db, "0.1.7.0", true);
    expect(resolvePluginUpdateTarget(db, uuid(2))).toEqual({ version: "0.1.7.0", scopeType: "school", scopeId: null, source: "latest" });
    db.close();
  });

  it("作用域就近覆盖：school < organization < tag < device，组织取最近的祖先", () => {
    const db = createDb();
    addRelease(db, "0.1.7.0", true);
    addRelease(db, "0.1.8.0");
    addRelease(db, "0.1.9.0");
    const set = (scopeType: "school" | "organization" | "tag" | "device", scopeId: string | null, version: string, at = NOW) =>
      upsertPluginUpdateTarget(db, { scopeType, scopeId, version }, owner.id, at);

    set("school", null, "0.1.8.0");
    expect(resolvePluginUpdateTarget(db, uuid(2))?.version).toBe("0.1.8.0");
    set("organization", uuid(91), "0.1.9.0");
    // 祖先节点设了目标，子树里的设备跟着走。
    expect(resolvePluginUpdateTarget(db, uuid(1))?.version).toBe("0.1.9.0");
    set("organization", uuid(92), "0.1.7.0");
    expect(resolvePluginUpdateTarget(db, uuid(1))?.version).toBe("0.1.7.0");
    expect(resolvePluginUpdateTarget(db, uuid(3))?.version).toBe("0.1.9.0");
    set("tag", uuid(5), "0.1.8.0");
    expect(resolvePluginUpdateTarget(db, uuid(1))?.version).toBe("0.1.8.0");
    set("device", uuid(1), "0.1.9.0");
    expect(resolvePluginUpdateTarget(db, uuid(1))).toEqual({ version: "0.1.9.0", scopeType: "device", scopeId: uuid(1), source: "target" });
    // 设备级目标只影响这台。
    expect(resolvePluginUpdateTarget(db, uuid(2))?.version).toBe("0.1.8.0");
    // 同层多条（两个标签各设一版）取最近写入的那条。
    db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,?,?)").run(uuid(6), "试点", "#526b59", NOW);
    db.prepare("INSERT INTO device_tags (device_id,tag_id) VALUES (?,?)").run(uuid(1), uuid(6));
    deletePluginUpdateTarget(db, "device", uuid(1));
    set("tag", uuid(6), "0.1.9.0", later(60));
    expect(resolvePluginUpdateTarget(db, uuid(1))?.version).toBe("0.1.9.0");
    db.close();
  });

  it("写入目标是覆盖而不是堆叠，取消后回落到上级", () => {
    const db = createDb();
    addRelease(db, "0.1.7.0", true);
    addRelease(db, "0.1.8.0");
    upsertPluginUpdateTarget(db, { scopeType: "organization", scopeId: uuid(91), version: "0.1.7.0" }, owner.id, NOW);
    const row = upsertPluginUpdateTarget(db, { scopeType: "organization", scopeId: uuid(91), version: "0.1.8.0" }, owner.id, later(10));
    expect(db.prepare("SELECT COUNT(*) count FROM plugin_update_targets").get()).toEqual({ count: 1 });
    expect(row.version).toBe("0.1.8.0");
    expect(resolvePluginUpdateTarget(db, uuid(3))?.version).toBe("0.1.8.0");
    expect(deletePluginUpdateTarget(db, "organization", uuid(91))).toBe(true);
    expect(deletePluginUpdateTarget(db, "organization", uuid(91))).toBe(false);
    expect(resolvePluginUpdateTarget(db, uuid(3))?.version).toBe("0.1.7.0");
    db.close();
  });

  it("撤回发布物时，指向它的目标一起消失", () => {
    const db = createDb();
    addRelease(db, "0.1.7.0");
    upsertPluginUpdateTarget(db, { scopeType: "tag", scopeId: uuid(5), version: "0.1.7.0" }, owner.id, NOW);
    db.prepare("DELETE FROM plugin_releases WHERE version='0.1.7.0'").run();
    expect(resolvePluginUpdateTarget(db, uuid(1))).toBeNull();
    db.close();
  });

  it("目标列表按账号可见范围收敛", () => {
    const db = createDb();
    addRelease(db, "0.1.7.0", true);
    const set = (scopeType: "school" | "organization" | "tag" | "device", scopeId: string | null) =>
      upsertPluginUpdateTarget(db, { scopeType, scopeId, version: "0.1.7.0" }, owner.id, NOW);
    set("school", null);
    set("tag", uuid(5));
    set("organization", uuid(91));
    set("organization", uuid(92));
    set("device", uuid(1));
    // 全校账号看全量，强作用域排前面。
    expect(pluginUpdateTargetsInView(db, schoolWideAdmin).map((row) => row.scopeType)).toEqual(["device", "tag", "organization", "organization", "school"]);
    // 只管高一(1)班子树的管理员：看不见祖先组织，也看不见全校/标签。
    expect(pluginUpdateTargetsInView(db, scopedAdmin).map((row) => row.scopeName)).toEqual(["高一(1)班", "class"]);
    // 教师按绑定设备可见，但没有任何写权限。
    expect(pluginUpdateTargetsInView(db, teacher).map((row) => row.scopeName)).toEqual(["高一(1)班"]);
    db.close();
  });

  it("版本分布同时算出已在、在途与等重启", () => {
    const db = createDb();
    addRelease(db, "0.1.6.0");
    addRelease(db, "0.1.7.0", true);
    db.prepare("UPDATE devices SET plugin_update_state='staged',plugin_update_version='0.1.7.0' WHERE id=?").run(uuid(2));
    const views = pluginReleasesWithDistribution(db, [uuid(1), uuid(2), uuid(3)].map((id) => ({ id, pluginVersion: "0.1.6.0" })));
    expect(views.map((view) => view.version)).toEqual(["0.1.7.0", "0.1.6.0"]);
    const [seven] = views;
    expect(seven).toMatchObject({ isCurrent: true, installedCount: 0, pendingCount: 3, stagedCount: 1 });
    // 磁盘上并没有真的包：界面要能看出这条记录缺文件。
    expect(seven.filePresent).toBe(false);
    db.close();
  });

  it("全校级目标只向全校范围账号开放", () => {
    const db = createDb();
    expect(() => assertPluginTargetScope(db, schoolWideAdmin, "school", null)).not.toThrow();
    expect(() => assertPluginTargetScope(db, scopedAdmin, "school", null)).toThrow(/全校范围/);
    expect(() => assertPluginTargetScope(db, scopedAdmin, "tag", uuid(5))).toThrow(/全校范围/);
    // 越权的组织与不在范围内的设备都按不存在处理。
    expect(() => assertPluginTargetScope(db, scopedAdmin, "organization", uuid(91))).toThrow(/目标组织不存在/);
    expect(() => assertPluginTargetScope(db, scopedAdmin, "organization", uuid(92))).not.toThrow();
    expect(() => assertPluginTargetScope(db, teacher, "device", uuid(3))).toThrow(/设备不存在/);
    expect(() => assertPluginTargetScope(db, teacher, "device", uuid(1))).not.toThrow();
    db.close();
  });
});
