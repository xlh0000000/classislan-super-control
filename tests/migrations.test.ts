import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, migrations, schemaFingerprint } from "../server/migrations";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrationRows(db: Database.Database) {
  return db.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all() as { id: string; checksum: string }[];
}

function tableExists(db: Database.Database, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// 复现 N-1 部署：只应用前 count 个迁移并像 migrate() 一样登记指纹，用于验证增量升级。
function createDbBehindBy(count: number) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL
  ) STRICT`);
  for (const migration of migrations.slice(0, count)) {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations (id,checksum,applied_at) VALUES (?,?,?)")
      .run(migration.id, schemaFingerprint(db), "2026-09-11T00:00:00.000Z");
  }
  return db;
}

describe("schema migrations", () => {
  it("rebuilds users for the teacher role without losing rows or sessions", () => {
    const db = createDbBehindBy(migrations.length - 1);
    db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
      .run("u1", "teacher1", "x", "王老师", "viewer", "2026-09-11T00:00:00.000Z");
    db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?)")
      .run("d1", "教室机", "{}", "fp1", "2026-09-11T00:00:00.000Z");
    db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)")
      .run("s1", "u1", "h1", "2099-01-01T00:00:00.000Z", "2026-09-11T00:00:00.000Z", "2026-09-11T00:00:00.000Z");
    // 旧 CHECK 必须先拒绝 teacher，否则说明断言跑在了错误的 schema 上。
    expect(() => db.prepare("UPDATE users SET role='teacher' WHERE id='u1'").run()).toThrow(/CHECK constraint/i);

    migrate(db);

    expect((db.prepare("SELECT role FROM users WHERE id='u1'").get() as { role: string }).role).toBe("viewer");
    expect(db.prepare("SELECT 1 FROM sessions WHERE id='s1'").get()).toBeTruthy();
    db.prepare("UPDATE users SET role='teacher', must_change_password=1 WHERE id='u1'").run();
    db.prepare("INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,?,?)")
      .run("d1", "u1", "admin", "2026-09-11T00:00:00.000Z");
    expect((db.prepare("SELECT COUNT(*) n FROM device_teachers").get() as { n: number }).n).toBe(1);
    // 设备与教师都是级联：任一侧删除都不能留下悬空绑定。
    db.prepare("DELETE FROM devices WHERE id='d1'").run();
    expect((db.prepare("SELECT COUNT(*) n FROM device_teachers").get() as { n: number }).n).toBe(0);
    db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?)")
      .run("d2", "办公室机", "{}", "fp2", "2026-09-11T00:00:00.000Z");
    db.prepare("INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,?,?)")
      .run("d2", "u1", "qr", "2026-09-11T00:00:00.000Z");
    db.prepare("DELETE FROM users WHERE id='u1'").run();
    expect((db.prepare("SELECT COUNT(*) n FROM device_teachers").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("applies every migration with a non-empty checksum and creates the new tables", () => {
    const db = createDb();
    const rows = migrationRows(db);
    expect(rows.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
    expect(rows.every((row) => row.checksum.length === 64)).toBe(true);
    expect(tableExists(db, "device_responses")).toBe(true);
    expect(tableExists(db, "sessions")).toBe(true);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("is idempotent when re-run against an up-to-date database", () => {
    const db = createDb();
    const before = migrationRows(db);
    migrate(db);
    expect(migrationRows(db)).toEqual(before);
    db.close();
  });

  it("upgrades a legacy two-column schema_migrations table in place", () => {
    const db = createDb();
    db.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");
    const legacyColumns = (db.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[]).map((column) => column.name);
    expect(legacyColumns).toEqual(["id", "applied_at"]);
    migrate(db);
    const columns = (db.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[]).map((column) => column.name);
    expect(columns).toContain("checksum");
    expect(migrationRows(db).length).toBe(migrations.length);
    db.close();
  });

  it("refuses to start when the database has migrations this binary does not know", () => {
    const db = createDb();
    db.prepare("INSERT INTO schema_migrations (id,checksum,applied_at) VALUES (?,?,?)").run("9999-from-the-future", "abc", "2026-09-11T00:00:00.000Z");
    expect(() => migrate(db)).toThrow(/未知的迁移/);
    db.close();
  });

  it("refuses to start when the live schema no longer matches the recorded fingerprint", () => {
    const db = createDb();
    db.exec("ALTER TABLE devices ADD COLUMN rogue_column TEXT");
    expect(schemaFingerprint(db)).not.toBe(migrationRows(db).at(-1)?.checksum);
    expect(() => migrate(db)).toThrow(/不一致/);
    db.close();
  });

  it("upgrades an N-1 database in place, applying only the missing migration", () => {
    const db = createDbBehindBy(migrations.length - 1);
    const before = migrationRows(db);
    expect(before.map((row) => row.id)).toEqual(migrations.slice(0, -1).map((migration) => migration.id));
    // 只落后一条：倒数第二条迁移（自动任务）的效果已在，最后一条（教师账号）的还没有。
    const columnsBefore = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((column) => column.name);
    expect(columnsBefore).toContain("transport");
    expect(tableExists(db, "rollcall_rosters")).toBe(true);
    expect(tableExists(db, "device_timetables")).toBe(true);
    expect(tableExists(db, "crash_reports")).toBe(true);
    expect(tableExists(db, "task_schedules")).toBe(true);
    expect(tableExists(db, "triggers")).toBe(true);
    expect(tableExists(db, "device_teachers")).toBe(false);
    expect(columnsBefore).not.toContain("binding_code_hash");
    const userColumnsBefore = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((column) => column.name);
    expect(userColumnsBefore).not.toContain("must_change_password");
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('kept','yes',?)").run("2026-09-11T00:00:00.000Z");

    migrate(db);

    const after = migrationRows(db);
    expect(after.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
    // 既有迁移记录逐字节不变，只有缺失的那一条被追加。
    expect(after.slice(0, -1)).toEqual(before);
    expect(tableExists(db, "device_timetables")).toBe(true);
    expect(tableExists(db, "crash_reports")).toBe(true);
    expect(tableExists(db, "device_teachers")).toBe(true);
    // 升级不破坏已有业务数据。
    expect((db.prepare("SELECT value FROM system_state WHERE key='kept'").get() as { value: string }).value).toBe("yes");
    // 升级后 schema 与最后一条记录指纹一致，随后再次 migrate() 为空操作。
    expect(after.at(-1)?.checksum).toBe(schemaFingerprint(db));
    migrate(db);
    expect(migrationRows(db)).toEqual(after);
    db.close();
  });
});