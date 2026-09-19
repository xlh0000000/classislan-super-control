import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { verify } from "@node-rs/argon2";
import { createTeacherAccounts, generateInitialPassword, planTeacherAccounts } from "../server/utils/teacher-accounts";

const NOW = "2026-09-19T00:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedUser(db: Database.Database, id: string, username: string, role = "admin") {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,created_at)
    VALUES (?,?,?,?,?,?)`).run(id, username, "hash", `用户-${username}`, role, NOW);
}

function userRow(db: Database.Database, username: string) {
  return db.prepare("SELECT id,username,display_name displayName,role,must_change_password mustChange,password_hash passwordHash,scope_org_node_id scopeOrgNodeId,created_at createdAt FROM users WHERE username=?")
    .get(username) as { id: string; username: string; displayName: string; role: string; mustChange: number; passwordHash: string; scopeOrgNodeId: string | null; createdAt: string } | undefined;
}

function auditRow(db: Database.Database) {
  return db.prepare("SELECT action,summary,details FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as { action: string; summary: string; details: string };
}

describe("initial password format", () => {
  it("emits four hyphen-separated groups of unambiguous characters", () => {
    for (let round = 0; round < 50; round++) {
      const password = generateInitialPassword();
      expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{4}(-[A-Za-z2-9]{4}){3}$/);
      expect(password).not.toMatch(/[OoIl10]/);
      expect(password.length).toBe(19);
    }
  });

  it("does not repeat itself across calls", () => {
    const seen = new Set<string>();
    for (let round = 0; round < 200; round++) seen.add(generateInitialPassword());
    expect(seen.size).toBe(200);
  });
});

describe("teacher account planning", () => {
  it("trims input and defaults the display name to the username", () => {
    const db = createDb();
    const { valid, rejected } = planTeacherAccounts(db, [
      { username: "  zhang.san  " },
      { username: "li-si", displayName: "  李四  " },
    ]);
    expect(valid).toEqual([{ username: "zhang.san", displayName: "zhang.san" }, { username: "li-si", displayName: "李四" }]);
    expect(rejected).toEqual([]);
    db.close();
  });

  it("rejects malformed usernames, in-batch duplicates and existing accounts case-insensitively", () => {
    const db = createDb();
    seedUser(db, "u1", "WangWu");
    const { valid, rejected } = planTeacherAccounts(db, [
      { username: "ab" },
      { username: "has space" },
      { username: "赵六" },
      { username: "wangwu" },
      { username: "ok_name", displayName: "  " },
      { username: "OK_NAME" },
    ]);
    expect(valid).toEqual([{ username: "ok_name", displayName: "ok_name" }]);
    expect(rejected.map((row) => `${row.username}:${row.reason}`)).toEqual([
      "ab:用户名需为 3-32 位字母、数字或 . _ -",
      "has space:用户名需为 3-32 位字母、数字或 . _ -",
      "赵六:用户名需为 3-32 位字母、数字或 . _ -",
      "wangwu:用户名已存在",
      "OK_NAME:本次请求内重复",
    ]);
    db.close();
  });
});

describe("bulk teacher account creation", () => {
  it("creates teacher accounts that must change their password on first login", async () => {
    const db = createDb();
    const { created, rejected } = await createTeacherAccounts(db, "actor", {
      accounts: [{ username: "zhang.san", displayName: "张三" }, { username: "li-si" }],
      scopeOrgNodeId: null,
    }, NOW);
    expect(rejected).toEqual([]);
    expect(created.map((row) => row.username)).toEqual(["zhang.san", "li-si"]);
    expect(created[0]?.displayName).toBe("张三");
    expect(created[1]?.displayName).toBe("li-si");

    const row = userRow(db, "zhang.san");
    expect(row?.role).toBe("teacher");
    expect(row?.mustChange).toBe(1);
    expect(row?.createdAt).toBe(NOW);
    expect(row?.passwordHash).not.toBe(created[0]?.password);
    db.close();
  });

  it("stores an argon2 hash that actually verifies the issued password", async () => {
    const db = createDb();
    const { created } = await createTeacherAccounts(db, "actor", { accounts: [{ username: "verify.me" }], scopeOrgNodeId: null }, NOW);
    const stored = userRow(db, "verify.me");
    expect(await verify(stored!.passwordHash, created[0]!.password)).toBe(true);
    expect(await verify(stored!.passwordHash, "wrong-password")).toBe(false);
    db.close();
  });

  it("reports collisions per item and keeps the rest of the batch", async () => {
    const db = createDb();
    seedUser(db, "u1", "taken-one");
    const { created, rejected } = await createTeacherAccounts(db, "actor", {
      accounts: [{ username: "taken-one" }, { username: "taken-two" }],
      scopeOrgNodeId: null,
    }, NOW);
    expect(created.map((row) => row.username)).toEqual(["taken-two"]);
    expect(rejected).toEqual([{ username: "taken-one", reason: "用户名已存在" }]);
    expect((db.prepare("SELECT COUNT(*) count FROM users WHERE username LIKE 'taken-%'").get() as { count: number }).count).toBe(2);
    db.close();
  });

  it("writes a single aggregate audit entry for the batch", async () => {
    const db = createDb();
    await createTeacherAccounts(db, "actor", { accounts: [{ username: "audit-a" }, { username: "audit-b" }, { username: "ab" }], scopeOrgNodeId: null }, NOW);
    const event = auditRow(db);
    expect(event.action).toBe("user.bulk.create");
    expect(event.summary).toBe("批量创建 2 个教师账号");
    expect(JSON.parse(event.details)).toEqual({ role: "teacher", scopeOrgNodeId: null, usernames: ["audit-a", "audit-b"], rejected: 1 });
    db.close();
  });

  it("does nothing when every item is rejected", async () => {
    const db = createDb();
    const { created, rejected } = await createTeacherAccounts(db, "actor", { accounts: [{ username: "x" }], scopeOrgNodeId: null }, NOW);
    expect(created).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) count FROM audit_events WHERE action='user.bulk.create'").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it("carries the requested organization scope onto every account", async () => {
    const db = createDb();
    db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES ('a',null,'东校区','/a',0,?)").run(NOW);
    await createTeacherAccounts(db, "actor", { accounts: [{ username: "scoped.one" }, { username: "scoped.two" }], scopeOrgNodeId: "a" }, NOW);
    const scopes = (db.prepare("SELECT scope_org_node_id scope FROM users WHERE role='teacher'").all() as { scope: string | null }[]).map((row) => row.scope);
    expect(scopes).toEqual(["a", "a"]);
    db.close();
  });
});
