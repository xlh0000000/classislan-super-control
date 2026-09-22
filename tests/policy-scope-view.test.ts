import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import {
  policyScopeHistory,
  policyScopeOverviews,
  publishEnrollmentPreset,
  publishPolicy,
} from "../server/utils/policy";

const NOW = "2026-09-21T00:00:00.000Z";
const owner = { id: "user-owner", role: "owner" };

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(owner.id, "owner", "hash", "校长", "owner", null, NOW);
  return db;
}
function seedTag(db: Database.Database, id: string) {
  db.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,?,?)").run(id, `tag-${id}`, "#526b59", NOW);
}
function seedDevice(db: Database.Database, id: string) {
  db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, `dev-${id}`, null, "{}", `thumb-${id}`, NOW);
}
type ScopeType = "school" | "organization" | "tag" | "device";
const publish = (db: Database.Database, input: {
  name: string; scopeType: ScopeType; scopeId: string | null;
  document?: Record<string, unknown>; locks?: string[]; priority?: number;
}) =>
  publishPolicy(db, {
    name: input.name, document: input.document ?? { profile: { name: input.name } },
    priority: input.priority ?? 0, locks: input.locks ?? [],
    scopeType: input.scopeType, scopeId: input.scopeId,
  }, owner, NOW);

describe("policy scope overview cards", () => {
  it("lists one row per scope with the revisions it has been through", () => {
    const db = createDb();
    expect(policyScopeOverviews(db)).toEqual([]);

    seedTag(db, "tag-1");
    publish(db, { name: "基线", scopeType: "school", scopeId: null });
    publish(db, { name: "机房", scopeType: "tag", scopeId: "tag-1" });
    publish(db, { name: "基线 v2", scopeType: "school", scopeId: null });

    const rows = policyScopeOverviews(db);
    const school = rows.find((row) => row.scopeType === "school")!;
    const tag = rows.find((row) => row.scopeType === "tag")!;
    // 复用同一行 assignment 也数得出历史：卡片上的「历史 N 版」就是这里来的。
    expect(school.historyCount).toBe(2);
    expect(school.current?.revision).toBe(3);
    expect(school.current?.name).toBe("基线 v2");
    expect(tag.historyCount).toBe(1);
    expect(tag.current?.revision).toBe(2);
    expect(tag.scopeId).toBe("tag-1");
  });

  it("reports the sections a revision covers and how many paths it locks", () => {
    const db = createDb();
    publish(db, {
      name: "基线", scopeType: "school", scopeId: null,
      document: { profile: { name: "school" }, settings: { disableDebugMenu: true } },
      locks: ["/profile/name", "/settings/disableDebugMenu"],
    });
    const current = policyScopeOverviews(db)[0]!.current!;
    expect(current.sections).toEqual(["profile", "settings"]);
    expect(current.lockCount).toBe(2);
    expect(current.priority).toBe(0);
    expect(current.mode).toBe("replace");
    expect(current.createdAt).toBe(NOW);
  });

  it("keeps a scope on the board with no current revision once it is withdrawn", () => {
    const db = createDb();
    publish(db, { name: "基线", scopeType: "school", scopeId: null });
    db.prepare("UPDATE policy_assignments SET superseded_at=?").run(NOW);

    const [row] = policyScopeOverviews(db);
    expect(row?.current).toBeNull();
    expect(row?.historyCount).toBe(1);
  });
});

describe("policy scope history", () => {
  it("keeps each revision's own locks so a later publish cannot rewrite history", () => {
    const db = createDb();
    publish(db, { name: "基线", scopeType: "school", scopeId: null, locks: ["/profile"] });
    publish(db, { name: "基线 v2", scopeType: "school", scopeId: null, locks: ["/settings"] });
    const [first, second] = policyScopeHistory(db, "school", null);
    // 顶替者换了锁，旧那版仍答得上自己当时锁了什么——沿用来源要接的就是这份。
    expect(second?.locks).toEqual(["/profile"]);
    expect(first?.locks).toEqual(["/settings"]);
  });

  it("returns every revision of that scope only, newest first, one flagged current", () => {
    const db = createDb();
    seedTag(db, "tag-1");
    publish(db, { name: "基线", scopeType: "school", scopeId: null, document: { profile: { name: "a" } } });
    publish(db, { name: "机房", scopeType: "tag", scopeId: "tag-1" });
    publish(db, { name: "基线 v2", scopeType: "school", scopeId: null, document: { settings: { disableDebugMenu: true } } });

    const rows = policyScopeHistory(db, "school", null);
    expect(rows.map((row) => row.revision)).toEqual([3, 1]);
    expect(rows[0]).toMatchObject({ name: "基线 v2", isCurrent: true, priority: 0, sections: ["settings"] });
    // 优先级挂在会被覆盖的 assignment 上，旧版本答不上来就留空，不拿现在的值冒充。
    expect(rows[1]).toMatchObject({ name: "基线", isCurrent: false, priority: null, sections: ["profile"] });
    expect(rows[0]!.documentHash).toHaveLength(64);
    expect(rows[0]!.createdByName).toBe("校长");
  });

  it("counts the device policy written at enrollment time in that device's history", () => {
    const db = createDb();
    seedDevice(db, "dev1");
    const school = publish(db, { name: "全校基线", scopeType: "school", scopeId: null });
    const source = db.prepare("SELECT revision,name,document FROM policy_revisions WHERE id=?").get(school.id) as
      { revision: number; name: string; document: string };
    const preset = publishEnrollmentPreset(db, "dev1", {
      revision: source.revision, name: source.name,
      document: JSON.parse(source.document) as Record<string, unknown>, locks: [],
    }, null, NOW);

    const rows = policyScopeHistory(db, "device", "dev1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision: preset, name: "接入下发 · 全校基线", isCurrent: true });
  });

  it("shows an empty document as no sections instead of failing", () => {
    const db = createDb();
    publish(db, { name: "空策略", scopeType: "school", scopeId: null, document: {} });
    expect(policyScopeHistory(db, "school", null)[0]?.sections).toEqual([]);
  });
});
