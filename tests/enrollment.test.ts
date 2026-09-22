import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { migrate } from "../server/migrations";
import { sha256 } from "../server/utils/security";
import { desiredStateEpoch, materializeConfigReferences, publishPolicy, resolvePolicyForDeviceFromDb } from "../server/utils/policy";
import { EnrollmentError, enrollDevice } from "../server/utils/enrollment";

// 物化配置引用要读全局库句柄；策略模块直接导入 useDatabase，因此用模块级替身指到内存库。
const hoisted = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, useDatabase: () => hoisted.db };
});

const NOW = "2026-09-11T00:00:00.000Z";
const FUTURE = "2026-09-11T01:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  hoisted.db = db;
  return db;
}

function newJwk(): import("node:crypto").JsonWebKey {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return publicKey.export({ format: "jwk" }) as import("node:crypto").JsonWebKey;
}

function seedToken(db: Database.Database, id: string, amount = "abcdef0123456789", overrides: Partial<{ maxUses: number; useCount: number; expiresAt: string; revokedAt: string | null; tagIds: string[]; orgNodeId: string | null; policyRevisionId: string | null; createdBy: string | null }> = {}) {
  const token = `enroll-token-${id}-${amount}`;
  db.prepare(`INSERT INTO enrollment_tokens (id,token_hash,kind,org_node_id,max_uses,use_count,expires_at,created_by,created_at,revoked_at,policy_revision_id)
    VALUES (?,?,'code',?,?,?,?,?,?,?,?)`)
    .run(id, sha256(token), overrides.orgNodeId ?? null, overrides.maxUses ?? 1, overrides.useCount ?? 0, overrides.expiresAt ?? FUTURE, overrides.createdBy ?? null, NOW, overrides.revokedAt ?? null, overrides.policyRevisionId ?? null);
  const addTag = db.prepare("INSERT INTO enrollment_token_tags (enrollment_token_id,tag_id) VALUES (?,?)");
  for (const tagId of overrides.tagIds ?? []) addTag.run(id, tagId);
  return token;
}

function seedTag(db: Database.Database, id: string, name = id) {
  db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,'#526b59',?)").run(id, name, NOW);
}

function seedUser(db: Database.Database, id: string) {
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,'hash',?,'owner',?)").run(id, id, id, NOW);
}

function seedConfiguration(db: Database.Database, id: string, kind: string, document: Record<string, unknown>, name = `${kind}档案`) {
  db.prepare("INSERT INTO configurations (id,kind,name,updated_at) VALUES (?,?,?,?)").run(id, kind, name, NOW);
  db.prepare("INSERT INTO configuration_revisions (id,configuration_id,kind,name,revision,document,document_hash,created_by,created_at) VALUES (?,?,?,?,1,?,?,NULL,?)")
    .run(`${id}:1`, id, kind, name, JSON.stringify(document), "hash", NOW);
  db.prepare("UPDATE configurations SET current_revision_id=? WHERE id=?").run(`${id}:1`, id);
}

/** 设备作用域当前有效的策略修订；接入时预下发的那一份就落在这里。 */
function devicePolicy(db: Database.Database, deviceId: string) {
  return db.prepare(`SELECT pr.revision revision,pr.name name,pr.created_by createdBy,pr.document document,pa.locks locks
    FROM policy_assignments pa JOIN policy_revisions pr ON pr.id=pa.policy_revision_id
    WHERE pa.superseded_at IS NULL AND pa.scope_type='device' AND pa.scope_key=?`).get(deviceId) as
    { revision: number; name: string; createdBy: string | null; document: string; locks: string } | undefined;
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

describe("enrollment policy preset", () => {
  const owner = { id: "u1", role: "owner" };
  const BASELINE = { profile: { name: "全校基线" }, settings: { disableDevTools: true } };
  const CLASS_PROFILE = { schemaVersion: 1, name: "高一(1)班", timeLayouts: {} };

  /** 发一条全校策略当作凭据要绑定的那份底稿；返回修订行 ID。 */
  function publishBaseline(db: Database.Database, name = "全校基线", document = BASELINE, locks: string[] = []) {
    return publishPolicy(db, { name, document, scopeType: "school", scopeId: null, priority: 0, locks }, owner, NOW).id;
  }

  it("copies the bound policy into the new device's own policy", () => {
    const db = createDb();
    seedUser(db, "u1");
    const revisionId = publishBaseline(db, "机房基线", BASELINE, ["/settings"]);
    const token = seedToken(db, "t1", "abcdef0123456789", { policyRevisionId: revisionId, createdBy: "u1" });
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    const policy = devicePolicy(db, outcome.deviceId);
    expect(policy?.name).toBe("接入下发 · 机房基线");
    expect(policy?.createdBy).toBe("u1");
    expect(JSON.parse(policy!.document)).toEqual(BASELINE);
    // 锁跟着底稿过来：源策略锁住的节在新设备上同样锁住。
    expect(JSON.parse(policy!.locks)).toEqual(["/settings"]);
  });

  it("carries the bound policy's config references through to the device", () => {
    const db = createDb();
    seedUser(db, "u1");
    seedConfiguration(db, "cfg-profile", "profile", CLASS_PROFILE, "高一(1)班档案");
    // 想在接入时拿到本班课表，做法是在底稿里按节引用配置库条目，而不是让凭据自己绑配置。
    const revisionId = publishBaseline(db, "带班策略", { profile: { $config: "cfg-profile" } });
    const token = seedToken(db, "t1", "abcdef0123456789", { policyRevisionId: revisionId });
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expect(JSON.parse(devicePolicy(db, outcome.deviceId)!.document)).toEqual({ profile: { $config: "cfg-profile" } });
    const resolved = resolvePolicyForDeviceFromDb(db, outcome.deviceId);
    expect(materializeConfigReferences(resolved.document)).toEqual({ profile: CLASS_PROFILE });
  });

  it("advances the desired-state epoch so the first poll carries the preset", () => {
    const db = createDb();
    seedUser(db, "u1");
    const revisionId = publishBaseline(db);
    const token = seedToken(db, "t1", "abcdef0123456789", { policyRevisionId: revisionId });
    // 发布底稿本身占掉一次 epoch，设备注册再推进一次，预下发从这一刻起可被拉到。
    expect(desiredStateEpoch(db)).toBe(1);
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expect(outcome.presetRevision).toBe(2);
    expect(desiredStateEpoch(db)).toBe(2);
    expect(resolvePolicyForDeviceFromDb(db, outcome.deviceId).epoch).toBe(2);
  });

  it("attributes the preset to no one when the credential has no creator", () => {
    const db = createDb();
    seedUser(db, "u1");
    const revisionId = publishBaseline(db);
    // 发布者是有名字的，凭据没有创建者时预下发的设备级策略记为系统来源。
    const token = seedToken(db, "t1", "abcdef0123456789", { policyRevisionId: revisionId });
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expect(devicePolicy(db, outcome.deviceId)?.createdBy).toBeNull();
  });

  it("does not publish a second revision when the enrollment is replayed", () => {
    const db = createDb();
    seedUser(db, "u1");
    const revisionId = publishBaseline(db);
    const token = seedToken(db, "t1", "abcdef0123456789", { policyRevisionId: revisionId });
    const jwk = newJwk();
    const first = enrollDevice(db, { ...baseInput, token, publicKeyJwk: jwk }, NOW);
    const replay = enrollDevice(db, { ...baseInput, token, publicKeyJwk: jwk }, FUTURE);
    expect(replay.presetRevision).toBeNull();
    expect(replay.deviceId).toBe(first.deviceId);
    expect(devicePolicy(db, first.deviceId)?.revision).toBe(2);
  });

  it("leaves a device without a device-scope policy when the credential binds nothing", () => {
    const db = createDb();
    const token = seedToken(db, "t1");
    const outcome = enrollDevice(db, { ...baseInput, token, publicKeyJwk: newJwk() }, NOW);
    expect(outcome.presetRevision).toBeNull();
    expect(devicePolicy(db, outcome.deviceId)).toBeUndefined();
    expect(desiredStateEpoch(db)).toBe(0);
  });

  it("rejects a credential that points at a policy revision which never existed", () => {
    const db = createDb();
    // 凭据上的策略引用有外键兜底：绕过接口直接写脏 ID 也进不了库，注册时自然不会拿到半份底稿。
    expect(() => seedToken(db, "t1", "abcdef0123456789", { policyRevisionId: "00000000-0000-0000-0000-000000000000" }))
      .toThrow(/FOREIGN KEY constraint/i);
  });
});