import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import { policyPublishSchema } from "../shared/schemas";
import {
  PolicyConflictError,
  PolicyError,
  bumpDesiredStateEpoch,
  bumpRestoreGeneration,
  desiredStateEpoch,
  publishPolicy,
  resolvePolicyForDeviceFromDb,
} from "../server/utils/policy";

const NOW = "2026-09-11T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { id: "user-owner", role: "owner" };

function seedUser(db: Database.Database, id: string, role: string, scopeOrgNodeId: string | null) {
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, `user-${id}`, "hash", id, role, scopeOrgNodeId, NOW);
}
function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seedUser(db, owner.id, "owner", null);
  seedUser(db, "user-scoped", "admin", null);
  return db;
}

function seedOrg(db: Database.Database, id: string, parentId: string | null, path: string) {
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,0,?)").run(id, parentId, `org-${id}`, path, NOW);
}
function seedDevice(db: Database.Database, id: string, orgNodeId: string | null) {
  db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, `dev-${id}`, orgNodeId, "{}", `thumb-${id}`, NOW);
}
function seedTag(db: Database.Database, id: string) {
  db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,?,?)").run(id, `tag-${id}`, "#526b59", NOW);
}
function tagDevice(db: Database.Database, deviceId: string, tagId: string) {
  db.prepare("INSERT INTO device_tags (device_id,tag_id) VALUES (?,?)").run(deviceId, tagId);
}
function countRows(db: Database.Database, sql: string) {
  return (db.prepare(sql).get() as { count: number }).count;
}
function expectStatus(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as HttpError).statusCode).toBe(statusCode);
  }
}

const base = {
  name: "school policy",
  document: { profile: { name: "school" } },
  priority: 0,
  locks: [] as string[],
};

describe("policy publish scope schema", () => {
  it("forces school to carry no target", () => {
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school" }).success).toBe(true);
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school", scopeId: null }).success).toBe(true);
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school", scopeId: uuid(1) }).success).toBe(false);
  });

  it("defaults the publish mode to replace and only accepts replace/append", () => {
    expect(policyPublishSchema.parse({ ...base, scopeType: "school" }).mode).toBe("replace");
    expect(policyPublishSchema.parse({ ...base, scopeType: "school", mode: "append" }).mode).toBe("append");
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school", mode: "merge" }).success).toBe(false);
  });

  it("forces non-school scopes to carry a UUID target", () => {
    for (const scopeType of ["organization", "tag", "device"] as const) {
      expect(policyPublishSchema.safeParse({ ...base, scopeType }).success).toBe(false);
      expect(policyPublishSchema.safeParse({ ...base, scopeType, scopeId: null }).success).toBe(false);
      expect(policyPublishSchema.safeParse({ ...base, scopeType, scopeId: "not-a-uuid" }).success).toBe(false);
      expect(policyPublishSchema.safeParse({ ...base, scopeType, scopeId: uuid(2) }).success).toBe(true);
    }
  });

  it("accepts an optional CAS baseline and rejects negative revisions", () => {
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school", baseRevision: 3 }).success).toBe(true);
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school", baseRevision: null }).success).toBe(true);
    expect(policyPublishSchema.safeParse({ ...base, scopeType: "school", baseRevision: -1 }).success).toBe(false);
  });
});

describe("policy publish CAS and stable assignment", () => {
  it("publishes the first revision and bumps the desired-state epoch", () => {
    const db = createDb();
    expect(desiredStateEpoch(db)).toBe(0);
    const first = publishPolicy(db, { ...base, scopeType: "school", scopeId: null, baseRevision: 0 }, owner, NOW);
    expect(first.revision).toBe(1);
    expect(first.epoch).toBe(1);
    expect(first.documentHash).toHaveLength(64);
    expect(desiredStateEpoch(db)).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) count FROM audit_events WHERE action='policy.publish'")).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_revisions WHERE base_revision=0")).toBe(1);
  });

  it("rejects a stale baseRevision with 409 and mutates nothing", () => {
    const db = createDb();
    publishPolicy(db, { ...base, scopeType: "school", scopeId: null, baseRevision: 0 }, owner, NOW);
    const before = countRows(db, "SELECT COUNT(*) count FROM policy_revisions");
    expectStatus(() => publishPolicy(db, { ...base, name: "stale", scopeType: "school", scopeId: null, baseRevision: 0 }, owner, NOW), 409);
    try {
      publishPolicy(db, { ...base, name: "stale", scopeType: "school", scopeId: null, baseRevision: 0 }, owner, NOW);
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyConflictError);
    }
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_revisions")).toBe(before);
    expect(desiredStateEpoch(db)).toBe(1);
  });

  it("keeps a stable assignment id across revisions and exactly one active row", () => {
    const db = createDb();
    const first = publishPolicy(db, { ...base, scopeType: "school", scopeId: null, baseRevision: 0 }, owner, NOW);
    const second = publishPolicy(db, { ...base, name: "second", scopeType: "school", scopeId: null, baseRevision: 1 }, owner, NOW);
    expect(second.revision).toBe(2);
    expect(second.assignmentId).toBe(first.assignmentId);
    expect(second.epoch).toBe(2);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_assignments")).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_assignments WHERE superseded_at IS NULL")).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_revisions")).toBe(2);
  });

  it("enforces a single active revision per scope at the database level", () => {
    const db = createDb();
    publishPolicy(db, { ...base, scopeType: "school", scopeId: null }, owner, NOW);
    const active = db.prepare("SELECT id,policy_revision_id revisionId FROM policy_assignments WHERE superseded_at IS NULL").get() as { id: string; revisionId: string };
    expect(() => db.prepare(`INSERT INTO policy_assignments (id,policy_revision_id,scope_type,scope_id,scope_key,priority,locks,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run("dup", active.revisionId, "school", null, "", 0, "[]", NOW)).toThrow();
    expect(active.id).toBeTruthy();
  });

  it("rejects a policy whose target does not exist and rolls the transaction back", () => {
    const db = createDb();
    expectStatus(() => publishPolicy(db, { ...base, scopeType: "device", scopeId: "missing-device" }, owner, NOW), 400);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_revisions")).toBe(0);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_assignments")).toBe(0);
  });

  it("rejects an organization target outside the caller's scope in-transaction", () => {
    const db = createDb();
    seedOrg(db, "a", null, "/a");
    seedOrg(db, "c", null, "/c");
    db.prepare("UPDATE users SET scope_org_node_id='a' WHERE id='user-scoped'").run();
    const scoped = { id: "user-scoped", role: "admin", scopeOrgNodeId: "a" };
    expectStatus(() => publishPolicy(db, { ...base, scopeType: "organization", scopeId: "c" }, scoped, NOW), 404);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_revisions")).toBe(0);
    const inScope = publishPolicy(db, { ...base, scopeType: "organization", scopeId: "a" }, scoped, NOW);
    expect(inScope.revision).toBe(1);
  });

  it("requires a school-wide account for school and tag scopes", () => {
    const db = createDb();
    seedOrg(db, "a", null, "/a");
    seedTag(db, "tag-1");
    const scoped = { id: "user-scoped", role: "admin", scopeOrgNodeId: "a" };
    expectStatus(() => publishPolicy(db, { ...base, scopeType: "school", scopeId: null }, scoped, NOW), 403);
    expectStatus(() => publishPolicy(db, { ...base, scopeType: "tag", scopeId: "tag-1" }, scoped, NOW), 403);
    expect(countRows(db, "SELECT COUNT(*) count FROM policy_revisions")).toBe(0);
  });

  it("allocates globally monotonic revisions across scopes", () => {
    const db = createDb();
    seedTag(db, "tag-1");
    const school = publishPolicy(db, { ...base, scopeType: "school", scopeId: null }, owner, NOW);
    const tag = publishPolicy(db, { ...base, scopeType: "tag", scopeId: "tag-1" }, owner, NOW);
    expect(school.revision).toBe(1);
    expect(tag.revision).toBe(2);
    expect(tag.epoch).toBe(2);
  });
});

describe("desired-state epoch covers revision regression", () => {
  it("keeps epoch monotonic when a tag removal lowers the effective revision", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    seedTag(db, "tag-1");
    publishPolicy(db, { ...base, scopeType: "school", scopeId: null, document: { profile: { name: "school" } } }, owner, NOW);
    publishPolicy(db, { ...base, scopeType: "tag", scopeId: "tag-1", document: { profile: { name: "tag" } } }, owner, NOW);
    tagDevice(db, "dev1", "tag-1");

    const applied = resolvePolicyForDeviceFromDb(db, "dev1");
    expect(applied.document).toEqual({ profile: { name: "tag" } });
    expect(applied.revision).toBe(2);
    expect(applied.epoch).toBe(2);

    // 去标签：有效修订回退到 R1，仅靠 revision 比较会永远无法触发重同步。
    db.prepare("DELETE FROM device_tags WHERE device_id=? AND tag_id=?").run("dev1", "tag-1");
    const bumpedEpoch = bumpDesiredStateEpoch(db, NOW);
    const after = resolvePolicyForDeviceFromDb(db, "dev1");
    expect(after.document).toEqual({ profile: { name: "school" } });
    expect(after.revision).toBe(1);
    expect(after.revision).toBeLessThan(applied.revision);
    expect(after.epoch).toBeGreaterThan(applied.epoch);
    expect(bumpedEpoch).toBe(after.epoch);
    // 服务端下发条件：epoch 前进即可触发，即使 revision 变小。
    expect(after.epoch > applied.epoch).toBe(true);
  });

  it("advances both the epoch and the restore generation on dataset recovery", () => {
    const db = createDb();
    publishPolicy(db, { ...base, scopeType: "school", scopeId: null }, owner, NOW);
    const before = desiredStateEpoch(db);
    const after = bumpRestoreGeneration(db, NOW);
    expect(after).toBeGreaterThan(before);
    const row = db.prepare("SELECT restore_generation generation FROM policy_state WHERE id=1").get() as { generation: number };
    expect(row.generation).toBe(1);
  });

  it("applies layered locks and reports the lock owner", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    publishPolicy(db, { ...base, scopeType: "school", scopeId: null, document: { profile: { enabled: true } }, locks: ["/profile/enabled"] }, owner, NOW);
    publishPolicy(db, { ...base, scopeType: "device", scopeId: "dev1", document: { profile: { enabled: false } } }, owner, NOW);
    const resolved = resolvePolicyForDeviceFromDb(db, "dev1");
    expect(resolved.document).toEqual({ profile: { enabled: true } });
    expect(resolved.locks["/profile/enabled"]).toEqual({ scopeType: "school", scopeId: null });
  });
});

describe("append mode merges onto the scope's current revision", () => {
  it("keeps unspecified content, replaces arrays and unions locks", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    const first = publishPolicy(db, {
      ...base, name: "基线", scopeType: "device", scopeId: "dev1",
      document: {
        profile: { name: "school", keep: true },
        settings: { disableDebugMenu: true },
        components: { list: [1, 2, 3] },
      },
      locks: ["/profile/name"],
    }, owner, NOW);
    expect(first.mode).toBe("replace");

    const appended = publishPolicy(db, {
      ...base, name: "追加", scopeType: "device", scopeId: "dev1", mode: "append", baseRevision: first.revision,
      document: { settings: { disableEasterEggs: true }, components: { list: [9] } },
    }, owner, NOW);
    expect(appended.mode).toBe("append");
    expect(appended.documentHash).not.toBe(first.documentHash);

    const resolved = resolvePolicyForDeviceFromDb(db, "dev1");
    expect(resolved.document).toEqual({
      profile: { name: "school", keep: true },
      settings: { disableDebugMenu: true, disableEasterEggs: true },
      components: { list: [9] },
    });
    // 锁取并集：追加修订不会丢掉基线声明过的锁定路径。
    expect(resolved.locks["/profile/name"]).toEqual({ scopeType: "device", scopeId: "dev1" });
    const assignment = db.prepare("SELECT locks FROM policy_assignments WHERE scope_key='dev1' AND superseded_at IS NULL").get() as { locks: string };
    expect(JSON.parse(assignment.locks)).toEqual(["/profile/name"]);
    const stored = db.prepare("SELECT mode FROM policy_revisions WHERE revision=?").get(appended.revision) as { mode: string };
    expect(stored.mode).toBe("append");
  });

  it("appends an explicit false so a device layer can unlock a lower layer", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    publishPolicy(db, { ...base, scopeType: "school", scopeId: null, document: { settings: { disableDebugMenu: true }, profile: { name: "school" } } }, owner, NOW);
    publishPolicy(db, {
      ...base, name: "追加", scopeType: "device", scopeId: "dev1", mode: "append",
      document: { settings: { disableDebugMenu: false } },
    }, owner, NOW);
    expect(resolvePolicyForDeviceFromDb(db, "dev1").document).toEqual({
      settings: { disableDebugMenu: false },
      profile: { name: "school" },
    });
  });

  it("behaves like a plain publish when the scope has no baseline", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    const result = publishPolicy(db, {
      ...base, name: "追加", scopeType: "device", scopeId: "dev1", mode: "append",
      document: { settings: { disableDebugMenu: true } },
    }, owner, NOW);
    expect(result.mode).toBe("append");
    expect(resolvePolicyForDeviceFromDb(db, "dev1").document).toEqual({ settings: { disableDebugMenu: true } });
  });

  it("still replaces the previous revision when mode is replace", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    publishPolicy(db, { ...base, scopeType: "device", scopeId: "dev1", document: { settings: { disableDebugMenu: true } } }, owner, NOW);
    publishPolicy(db, { ...base, scopeType: "device", scopeId: "dev1", document: { settings: { disableEasterEggs: true } } }, owner, NOW);
    expect(resolvePolicyForDeviceFromDb(db, "dev1").document).toEqual({ settings: { disableEasterEggs: true } });
  });
});