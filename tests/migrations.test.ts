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
    // 只落后一条：倒数第二条迁移（点名名单）的效果已在，最后一条（设备课表档案）的还没有。
    const columnsBefore = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((column) => column.name);
    expect(columnsBefore).toContain("transport");
    expect(tableExists(db, "rollcall_rosters")).toBe(true);
    expect(tableExists(db, "device_timetables")).toBe(false);
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('kept','yes',?)").run("2026-09-11T00:00:00.000Z");

    migrate(db);

    const after = migrationRows(db);
    expect(after.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
    // 既有迁移记录逐字节不变，只有缺失的那一条被追加。
    expect(after.slice(0, -1)).toEqual(before);
    expect(tableExists(db, "device_timetables")).toBe(true);
    // 升级不破坏已有业务数据。
    expect((db.prepare("SELECT value FROM system_state WHERE key='kept'").get() as { value: string }).value).toBe("yes");
    // 升级后 schema 与最后一条记录指纹一致，随后再次 migrate() 为空操作。
    expect(after.at(-1)?.checksum).toBe(schemaFingerprint(db));
    migrate(db);
    expect(migrationRows(db)).toEqual(after);
    db.close();
  });
});