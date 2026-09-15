import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { UserError, revokeUserSessions, setUserDisabled } from "../server/utils/users";

const NOW = "2026-09-11T00:00:00.000Z";
const LATER = "2026-09-11T01:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedUser(db: Database.Database, id: string, role = "operator", disabledAt: string | null = null) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,created_at,disabled_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, `user-${id}`, "hash", `用户-${id}`, role, NOW, disabledAt);
}

function seedSession(db: Database.Database, id: string, userId: string) {
  db.prepare(`INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?,?,?,?,?,?)`).run(id, userId, `token-${id}`, LATER, NOW, NOW);
}

function sessionCount(db: Database.Database, userId: string) {
  return (db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id=?").get(userId) as { count: number }).count;
}

function disabledAt(db: Database.Database, userId: string) {
  return (db.prepare("SELECT disabled_at disabledAt FROM users WHERE id=?").get(userId) as { disabledAt: string | null }).disabledAt;
}

function expectUserError(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected user operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).statusCode).toBe(statusCode);
  }
}

describe("user lifecycle", () => {
  it("disables an account, stamps the time and revokes every session", () => {
    const db = createDb();
    seedUser(db, "u1");
    seedSession(db, "s1", "u1");
    seedSession(db, "s2", "u1");
    const result = setUserDisabled(db, "actor", "u1", true, LATER);
    expect(result.disabledAt).toBe(LATER);
    expect(disabledAt(db, "u1")).toBe(LATER);
    expect(sessionCount(db, "u1")).toBe(0);
  });

  it("re-enables an account but still clears residual sessions", () => {
    const db = createDb();
    seedUser(db, "u1", "operator", NOW);
    seedSession(db, "s1", "u1");
    const result = setUserDisabled(db, "actor", "u1", false, LATER);
    expect(result.disabledAt).toBeNull();
    expect(disabledAt(db, "u1")).toBeNull();
    expect(sessionCount(db, "u1")).toBe(0);
  });

  it("refuses to disable the sole owner", () => {
    const db = createDb();
    seedUser(db, "owner", "owner");
    expectUserError(() => setUserDisabled(db, "actor", "owner", true, LATER), 400);
    expect(disabledAt(db, "owner")).toBeNull();
  });

  it("rejects redundant state transitions", () => {
    const db = createDb();
    seedUser(db, "u1");
    seedUser(db, "u2", "operator", NOW);
    expectUserError(() => setUserDisabled(db, "actor", "u2", true, LATER), 409);
    expectUserError(() => setUserDisabled(db, "actor", "u1", false, LATER), 409);
  });

  it("reports a missing account as 404", () => {
    const db = createDb();
    expectUserError(() => setUserDisabled(db, "actor", "ghost", true, LATER), 404);
  });

  it("revokes only the targeted account's sessions", () => {
    const db = createDb();
    seedUser(db, "u1");
    seedUser(db, "u2");
    seedSession(db, "s1", "u1");
    seedSession(db, "s2", "u1");
    seedSession(db, "s3", "u2");
    expect(revokeUserSessions(db, "u1")).toBe(2);
    expect(sessionCount(db, "u1")).toBe(0);
    expect(sessionCount(db, "u2")).toBe(1);
  });
});