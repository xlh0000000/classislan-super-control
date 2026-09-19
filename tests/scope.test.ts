import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import {
  assertDeviceInScope,
  assertOrgNodeInScope,
  assertSchoolWideScope,
  deviceScopeFilter,
  effectiveScopeOrgNodeId,
  hasSchoolWideScope,
  teacherBoundDeviceIds,
  visibleOrgNodeIds,
  type ScopeUser,
} from "../server/utils/scope";

const NOW = "2026-09-11T00:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedOrgNode(db: Database.Database, id: string, parentId: string | null, name: string, path: string) {
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,0,?)").run(id, parentId, name, path, NOW);
}

function seedDevice(db: Database.Database, id: string, orgNodeId: string | null) {
  db.prepare(`INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at)
    VALUES (?,?,?,?,?,?)`).run(id, `设备-${id}`, orgNodeId, "{}", `thumb-${id}`, NOW);
}

function seedUser(db: Database.Database, id: string, role: string, scopeOrgNodeId: string | null) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, `user-${id}`, "hash", `用户-${id}`, role, scopeOrgNodeId, NOW);
}

function bindDevice(db: Database.Database, deviceId: string, userId: string, boundBy = "admin") {
  db.prepare("INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,?,?)")
    .run(deviceId, userId, boundBy, NOW);
}

function seedTree(db: Database.Database) {
  seedOrgNode(db, "a", null, "东校区", "/a");
  seedOrgNode(db, "b", "a", "高一", "/a/b");
  seedOrgNode(db, "c", null, "西校区", "/c");
  seedDevice(db, "dA", "a");
  seedDevice(db, "dB", "b");
  seedDevice(db, "dC", "c");
  seedDevice(db, "dNull", null);
}

function visibleDeviceIds(db: Database.Database, user: ScopeUser) {
  const scope = deviceScopeFilter(db, user);
  return (db.prepare(`SELECT d.id FROM devices d WHERE ${scope.sql} ORDER BY d.id`).all(...scope.params) as { id: string }[]).map((row) => row.id);
}

function expectHttpStatus(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as HttpError).statusCode).toBe(statusCode);
  }
}

describe("organization scope", () => {
  it("treats the owner as school-wide regardless of an assigned node", () => {
    const db = createDb();
    const owner: ScopeUser = { id: "o", role: "owner", scopeOrgNodeId: "a" };
    expect(effectiveScopeOrgNodeId(owner)).toBeNull();
    expect(visibleOrgNodeIds(db, owner)).toBeNull();
    expect(hasSchoolWideScope(owner)).toBe(true);
  });

  it("resolves a scoped user to the subtree of the assigned node", () => {
    const db = createDb();
    seedTree(db);
    const user: ScopeUser = { id: "u", role: "admin", scopeOrgNodeId: "a" };
    expect(new Set(visibleOrgNodeIds(db, user))).toEqual(new Set(["a", "b"]));
    expect(hasSchoolWideScope(user)).toBe(false);
    expect(visibleDeviceIds(db, user)).toEqual(["dA", "dB"]);
  });

  it("returns no devices for a scope pointing at a missing node", () => {
    const db = createDb();
    seedTree(db);
    const user: ScopeUser = { id: "u", role: "operator", scopeOrgNodeId: "ghost" };
    expect(visibleOrgNodeIds(db, user)).toEqual([]);
    expect(deviceScopeFilter(db, user).sql).toBe("0=1");
    expect(visibleDeviceIds(db, user)).toEqual([]);
  });

  it("shows every device to a school-wide user", () => {
    const db = createDb();
    seedTree(db);
    const user: ScopeUser = { id: "u", role: "admin", scopeOrgNodeId: null };
    expect(visibleOrgNodeIds(db, user)).toBeNull();
    expect(deviceScopeFilter(db, user).sql).toBe("1=1");
    expect(visibleDeviceIds(db, user)).toEqual(["dA", "dB", "dC", "dNull"]);
  });

  it("rejects out-of-scope device writes with 404 to avoid leaking existence", () => {
    const db = createDb();
    seedTree(db);
    const user: ScopeUser = { id: "u", role: "admin", scopeOrgNodeId: "a" };
    expect(() => assertDeviceInScope(db, user, "dA")).not.toThrow();
    expect(() => assertDeviceInScope(db, user, "dB")).not.toThrow();
    expectHttpStatus(() => assertDeviceInScope(db, user, "dC"), 404);
    expectHttpStatus(() => assertDeviceInScope(db, user, "dNull"), 404);
    expectHttpStatus(() => assertDeviceInScope(db, user, "missing"), 404);
  });

  it("rejects out-of-scope organization targets", () => {
    const db = createDb();
    seedTree(db);
    const user: ScopeUser = { id: "u", role: "admin", scopeOrgNodeId: "a" };
    expect(() => assertOrgNodeInScope(db, user, "a")).not.toThrow();
    expect(() => assertOrgNodeInScope(db, user, "b")).not.toThrow();
    expectHttpStatus(() => assertOrgNodeInScope(db, user, "c"), 404);
    expectHttpStatus(() => assertOrgNodeInScope(db, user, null), 404);
  });

  it("gates school-level resources to school-wide accounts only", () => {
    const db = createDb();
    seedTree(db);
    const scoped: ScopeUser = { id: "u", role: "admin", scopeOrgNodeId: "a" };
    const owner: ScopeUser = { id: "o", role: "owner", scopeOrgNodeId: null };
    expectHttpStatus(() => assertSchoolWideScope(scoped, "策略"), 403);
    expect(() => assertSchoolWideScope(owner, "策略")).not.toThrow();
  });

  it("lets the owner write outside any node", () => {
    const db = createDb();
    seedTree(db);
    const owner: ScopeUser = { id: "o", role: "owner", scopeOrgNodeId: null };
    expect(() => assertDeviceInScope(db, owner, "dC")).not.toThrow();
    expect(() => assertOrgNodeInScope(db, owner, "c")).not.toThrow();
    expect(() => assertOrgNodeInScope(db, owner, null)).not.toThrow();
  });

  it("exposes scope_org_node_id on the session user query", () => {
    const db = createDb();
    seedTree(db);
    seedUser(db, "u1", "admin", "a");
    const row = db.prepare("SELECT scope_org_node_id scopeOrgNodeId FROM users WHERE id=?").get("u1") as { scopeOrgNodeId: string | null };
    expect(row.scopeOrgNodeId).toBe("a");
  });
});

describe("teacher device binding scope", () => {
  it("shows a teacher only the devices bound to them, whatever node they sit in", () => {
    const db = createDb();
    seedTree(db);
    seedUser(db, "t1", "teacher", null);
    seedUser(db, "t2", "teacher", "a");
    bindDevice(db, "dA", "t1");
    bindDevice(db, "dNull", "t1");
    bindDevice(db, "dC", "t2");

    const teacher: ScopeUser = { id: "t1", role: "teacher", scopeOrgNodeId: null };
    expect(visibleDeviceIds(db, teacher)).toEqual(["dA", "dNull"]);
    expect(teacherBoundDeviceIds(db, teacher)).toEqual(["dA", "dNull"]);
    expect(visibleDeviceIds(db, { id: "t2", role: "teacher" })).toEqual(["dC"]);
  });

  it("never reads a teacher with a null scope as school-wide", () => {
    const db = createDb();
    seedTree(db);
    seedUser(db, "t1", "teacher", null);
    const teacher: ScopeUser = { id: "t1", role: "teacher", scopeOrgNodeId: null };
    expect(hasSchoolWideScope(teacher)).toBe(false);
    expectHttpStatus(() => assertSchoolWideScope(teacher, "点名名单"), 403);
    expect(visibleOrgNodeIds(db, teacher)).toEqual([]);
    expect(teacherBoundDeviceIds(db, { id: "u", role: "admin" })).toEqual([]);
  });

  it("passes device checks only for bound devices", () => {
    const db = createDb();
    seedTree(db);
    seedUser(db, "t1", "teacher", null);
    bindDevice(db, "dB", "t1");
    const teacher: ScopeUser = { id: "t1", role: "teacher" };
    expect(() => assertDeviceInScope(db, teacher, "dB")).not.toThrow();
    expectHttpStatus(() => assertDeviceInScope(db, teacher, "dA"), 404);
    expectHttpStatus(() => assertDeviceInScope(db, teacher, "missing"), 404);
  });

  it("rejects organization targets for a teacher", () => {
    const db = createDb();
    seedTree(db);
    seedUser(db, "t1", "teacher", null);
    bindDevice(db, "dA", "t1");
    const teacher: ScopeUser = { id: "t1", role: "teacher" };
    expectHttpStatus(() => assertOrgNodeInScope(db, teacher, "a"), 404);
    expectHttpStatus(() => assertOrgNodeInScope(db, teacher, null), 404);
  });
});