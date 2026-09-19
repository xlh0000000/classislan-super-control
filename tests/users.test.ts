import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import { assertNoPendingPasswordChange } from "../server/utils/auth";
import { UserError, applyPasswordChange, revokeUserSessions, setUserDisabled } from "../server/utils/users";

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

function expectHttpStatus(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected request to be refused");
  } catch (error) {
    expect((error as HttpError).statusCode).toBe(statusCode);
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

describe("self-service password change", () => {
  function passwordHash(db: Database.Database, userId: string) {
    return (db.prepare("SELECT password_hash passwordHash FROM users WHERE id=?").get(userId) as { passwordHash: string }).passwordHash;
  }

  function mustChange(db: Database.Database, userId: string) {
    return (db.prepare("SELECT must_change_password mustChange FROM users WHERE id=?").get(userId) as { mustChange: number }).mustChange;
  }

  function auditActions(db: Database.Database) {
    return (db.prepare("SELECT action FROM audit_events ORDER BY sequence").all() as { action: string }[]).map((row) => row.action);
  }

  it("swaps the hash, clears the forced-change flag and keeps only the acting session", () => {
    const db = createDb();
    seedUser(db, "u1");
    db.prepare("UPDATE users SET must_change_password=1 WHERE id='u1'").run();
    seedSession(db, "s1", "u1");
    seedSession(db, "s2", "u1");
    expect(mustChange(db, "u1")).toBe(1);

    applyPasswordChange(db, { userId: "u1", sessionId: "s1", passwordHash: "new-hash" }, LATER);

    expect(passwordHash(db, "u1")).toBe("new-hash");
    expect(mustChange(db, "u1")).toBe(0);
    expect(sessionCount(db, "u1")).toBe(1);
    expect((db.prepare("SELECT id FROM sessions").get() as { id: string }).id).toBe("s1");
    expect(auditActions(db)).toContain("user.password.change");
  });

  it("leaves other accounts' sessions intact", () => {
    const db = createDb();
    seedUser(db, "u1");
    seedUser(db, "u2");
    seedSession(db, "s1", "u1");
    seedSession(db, "s2", "u1");
    seedSession(db, "s3", "u2");
    applyPasswordChange(db, { userId: "u1", sessionId: "s1", passwordHash: "new-hash" });
    expect(sessionCount(db, "u2")).toBe(1);
    expect(passwordHash(db, "u2")).toBe("hash");
  });

  it("reports a missing account as 404", () => {
    const db = createDb();
    expectUserError(() => applyPasswordChange(db, { userId: "ghost", sessionId: "s1", passwordHash: "new-hash" }), 404);
  });

  it("refuses admin operations until the initial password has been changed", () => {
    expectHttpStatus(() => assertNoPendingPasswordChange({ mustChangePassword: true }), 403);
    expect(() => assertNoPendingPasswordChange({ mustChangePassword: false })).not.toThrow();
  });
});