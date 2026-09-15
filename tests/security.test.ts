import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { appendAuditWithin, canonicalJson, sha256, timingSafeEqualText, verifyAuditChain } from "../server/utils/security";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("canonical JSON", () => {
  it("orders keys deterministically regardless of insertion order", () => {
    const left = canonicalJson({ b: 1, a: { d: [2, 3], c: "值" } });
    const right = canonicalJson({ a: { c: "值", d: [2, 3] }, b: 1 });
    expect(left).toBe(right);
    expect(left).toBe('{"a":{"c":"值","d":[2,3]},"b":1}');
  });

  it("keeps non-ascii text unescaped and escapes control characters only", () => {
    expect(canonicalJson({ name: "三年二班", note: "a\nb" })).toBe('{"name":"三年二班","note":"a\\nb"}');
  });
});

describe("hashing", () => {
  it("produces stable sha256 digests", () => {
    expect(sha256("plan")).toBe(sha256("plan"));
    expect(sha256("plan")).toHaveLength(64);
  });
});

describe("timingSafeEqualText", () => {
  it("matches equal strings and rejects mismatches or length differences", () => {
    expect(timingSafeEqualText("token-value", "token-value")).toBe(true);
    expect(timingSafeEqualText("token-value", "token-valuf")).toBe(false);
    expect(timingSafeEqualText("short", "longer-token")).toBe(false);
    expect(timingSafeEqualText("", "")).toBe(true);
  });
});

describe("audit chain", () => {
  it("appends monotonically sequenced, linked events", () => {
    const db = createDb();
    const first = appendAuditWithin(db, { actorType: "user", actorId: "u1", action: "user.create", targetType: "user", targetId: "u1", summary: "创建用户" });
    const second = appendAuditWithin(db, { actorType: "user", actorId: "u1", action: "policy.publish", targetType: "policy_revision", targetId: "p1", summary: "发布策略", details: { scopeType: "school" } });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.eventHash);
    expect(verifyAuditChain(db)).toEqual({ verified: true, lastSequence: 2, lastHash: second.eventHash, count: 2 });
  });

  it("reports an empty chain as valid", () => {
    expect(verifyAuditChain(createDb())).toEqual({ verified: true, lastSequence: 0, lastHash: "", count: 0 });
  });

  it("detects a tampered event whose hash no longer matches its content", () => {
    const db = createDb();
    appendAuditWithin(db, { actorType: "user", actorId: "u1", action: "device.delete", targetType: "device", targetId: "d1", summary: "删除设备" });
    appendAuditWithin(db, { actorType: "user", actorId: "u1", action: "device.delete", targetType: "device", targetId: "d2", summary: "删除设备" });
    db.prepare("UPDATE audit_events SET summary='已篡改' WHERE sequence=1").run();
    expect(() => verifyAuditChain(db)).toThrow(/哈希不符/);
  });

  it("detects a broken link between events", () => {
    const db = createDb();
    appendAuditWithin(db, { actorType: "user", actorId: "u1", action: "a", targetType: "t", summary: "one" });
    appendAuditWithin(db, { actorType: "user", actorId: "u1", action: "b", targetType: "t", summary: "two" });
    db.prepare("UPDATE audit_events SET previous_hash='deadbeef' WHERE sequence=2").run();
    expect(() => verifyAuditChain(db)).toThrow();
  });
});