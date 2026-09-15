import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { migrate } from "../server/migrations";
import { sha256 } from "../server/utils/security";
import { EnrollmentError, enrollDevice } from "../server/utils/enrollment";

const NOW = "2026-09-11T00:00:00.000Z";
const FUTURE = "2026-09-11T01:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function newJwk(): import("node:crypto").JsonWebKey {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return publicKey.export({ format: "jwk" }) as import("node:crypto").JsonWebKey;
}

function seedToken(db: Database.Database, id: string, amount = "abcdef0123456789", overrides: Partial<{ maxUses: number; useCount: number; expiresAt: string; revokedAt: string | null; tagIds: string[]; orgNodeId: string | null }> = {}) {
  const token = `enroll-token-${id}-${amount}`;
  db.prepare(`INSERT INTO enrollment_tokens (id,token_hash,kind,org_node_id,max_uses,use_count,expires_at,created_by,created_at,revoked_at)
    VALUES (?,?,'code',?,?,?,?,NULL,?,?)`)
    .run(id, sha256(token), overrides.orgNodeId ?? null, overrides.maxUses ?? 1, overrides.useCount ?? 0, overrides.expiresAt ?? FUTURE, NOW, overrides.revokedAt ?? null);
  const addTag = db.prepare("INSERT INTO enrollment_token_tags (enrollment_token_id,tag_id) VALUES (?,?)");
  for (const tagId of overrides.tagIds ?? []) addTag.run(id, tagId);
  return token;
}

function seedTag(db: Database.Database, id: string, name = id) {
  db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,'#526b59',?)").run(id, name, NOW);
}

function deviceTagIds(db: Database.Database, deviceId: string) {
  return (db.prepare("SELECT tag_id tagId FROM device_tags WHERE device_id=? ORDER BY tag_id").all(deviceId) as { tagId: string }[]).map((row) => row.tagId);
}

function tokenUseCount(db: Database.Database, id: string) {
  return (db.prepare("SELECT use_count useCount FROM enrollment_tokens WHERE id=?").get(id) as { useCount: number }).useCount;
}

function deviceCount(db: Database.Database) {
  return (db.prepare("SELECT COUNT(*) count FROM devices").get() as { count: number }).count;
}

const baseInput = { pluginVersion: "0.1.0", appVersion: "2.1.1.1", platform: "Windows/x64", name: "测试设备" };

function expectEnrollmentError(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected enrollment to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(EnrollmentError);
    expect((error as EnrollmentError).statusCode).toBe(statusCode);
  }
}

describe("enrollment idempotency", () => {
  it("activates a device and consumes exactly one token use", () => {
    const db = createDb();
    const token = seedToken(db, "t1");
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expect(outcome.replayed).toBe(false);
    expect(deviceCount(db)).toBe(1);
    expect(tokenUseCount(db, "t1")).toBe(1);
  });

  it("returns the existing device when the same key and credential are replayed", () => {
    const db = createDb();
    const token = seedToken(db, "t1");
    const jwk = newJwk();
    const first = enrollDevice(db, { ...baseInput, token, publicKeyJwk: jwk }, NOW);
    const replay = enrollDevice(db, { ...baseInput, token, publicKeyJwk: jwk }, FUTURE);
    expect(replay.replayed).toBe(true);
    expect(replay.deviceId).toBe(first.deviceId);
    expect(deviceCount(db)).toBe(1);
    expect(tokenUseCount(db, "t1")).toBe(1);
  });

  it("rejects a different key once the credential is exhausted", () => {
    const db = createDb();
    const token = seedToken(db, "t1");
    enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expectEnrollmentError(() => enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW), 401);
  });

  it("rejects a revoked credential even for a replay", () => {
    const db = createDb();
    const token = seedToken(db, "t1");
    const jwk = newJwk();
    enrollDevice(db, { ...baseInput, token, publicKeyJwk: jwk }, NOW);
    db.prepare("UPDATE enrollment_tokens SET revoked_at=? WHERE id='t1'").run(FUTURE);
    expectEnrollmentError(() => enrollDevice(db, { ...baseInput, token, publicKeyJwk: jwk }, NOW), 401);
  });

  it("applies the credential's organization and tags to the enrolling device", () => {
    const db = createDb();
    seedTag(db, "tag-1");
    seedTag(db, "tag-2");
    db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,created_at) VALUES ('org-1',NULL,'年级','/org-1',?)").run(NOW);
    const token = seedToken(db, "t1", "abcdef0123456789", { tagIds: ["tag-1", "tag-2"], orgNodeId: "org-1" });
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    const device = db.prepare("SELECT org_node_id orgNodeId FROM devices WHERE id=?").get(outcome.deviceId) as { orgNodeId: string | null };
    expect(device.orgNodeId).toBe("org-1");
    expect(deviceTagIds(db, outcome.deviceId)).toEqual(["tag-1", "tag-2"]);
  });

  it("drops a deleted tag from the credential instead of failing enrollment", () => {
    const db = createDb();
    seedTag(db, "tag-1");
    seedTag(db, "tag-2");
    const token = seedToken(db, "t1", "abcdef0123456789", { tagIds: ["tag-1", "tag-2"] });
    db.prepare("DELETE FROM tags WHERE id='tag-1'").run();
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expect(deviceTagIds(db, outcome.deviceId)).toEqual(["tag-2"]);
  });

  it("rejects a caller-supplied thumbprint that does not match the key", () => {
    const db = createDb();
    const token = seedToken(db, "t1");
    expectEnrollmentError(() => enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk(), keyThumbprint: "forged" }, NOW), 400);
  });
});