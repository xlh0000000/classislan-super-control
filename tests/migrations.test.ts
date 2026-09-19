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

// 按 id 停在某条迁移之前：用长度倒数的写法每加一条迁移就会把用例带偏。
function createDbBefore(id: string) {
  const index = migrations.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`未知迁移 ${id}`);
  return createDbBehindBy(index);
}

describe("schema migrations", () => {
  it("rebuilds users for the teacher role without losing rows or sessions", () => {
    const db = createDbBefore("0018-teacher-accounts");
    db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
      .run("u1", "teacher1", "x", "王老师", "viewer", "2026-09-11T00:00:00.000Z");
    db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)")
      .run("o1", null, "本部", "本部", 0, "2026-09-11T00:00:00.000Z");
    db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?)")
      .run("d1", "教室机", "{}", "fp1", "2026-09-11T00:00:00.000Z");
    db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)")
      .run("s1", "u1", "h1", "2099-01-01T00:00:00.000Z", "2026-09-11T00:00:00.000Z", "2026-09-11T00:00:00.000Z");
    // 无级联动作的子表（DROP 父表时只能记下一笔违规）才是真实故障现场：只留 sessions 测不出来。
    db.prepare("INSERT INTO enrollment_tokens (id,token_hash,kind,org_node_id,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("e1", "th1", "code", "o1", "2099-01-01T00:00:00.000Z", "u1", "2026-09-11T00:00:00.000Z");
    // 旧 CHECK 必须先拒绝 teacher，否则说明断言跑在了错误的 schema 上。
    expect(() => db.prepare("UPDATE users SET role='teacher' WHERE id='u1'").run()).toThrow(/CHECK constraint/i);

    migrate(db);

    expect((db.prepare("SELECT role FROM users WHERE id='u1'").get() as { role: string }).role).toBe("viewer");
    expect(db.prepare("SELECT 1 FROM sessions WHERE id='s1'").get()).toBeTruthy();
    expect((db.prepare("SELECT created_by FROM enrollment_tokens WHERE id='e1'").get() as { created_by: string }).created_by).toBe("u1");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
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
    // 重建后外键依旧把关：还有接入令牌挂在用户名下时删不掉该用户。
    expect(() => db.prepare("DELETE FROM users WHERE id='u1'").run()).toThrow(/FOREIGN KEY constraint failed/);
    db.prepare("DELETE FROM enrollment_tokens WHERE id='e1'").run();
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
    const last = migrations.at(-1)!.id;
    const db = createDbBefore(last);
    const before = migrationRows(db);
    expect(before.map((row) => row.id)).toEqual(migrations.slice(0, -1).map((migration) => migration.id));
    // 只落后最后一条：教师账号那批改动已在，缺的是新表。
    const columnsBefore = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((column) => column.name);
    expect(columnsBefore).toContain("binding_code_hash");
    expect(tableExists(db, "device_teachers")).toBe(true);
    expect(tableExists(db, "rollcall_rosters")).toBe(true);
    expect(tableExists(db, "rollcall_settings")).toBe(false);
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('kept','yes',?)").run("2026-09-11T00:00:00.000Z");

    migrate(db);

    const after = migrationRows(db);
    expect(after.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
    // 既有迁移记录逐字节不变，只有缺失的那一条被追加。
    expect(after.slice(0, -1)).toEqual(before);
    expect(tableExists(db, "device_teachers")).toBe(true);
    expect(tableExists(db, "rollcall_settings")).toBe(true);
    // 升级不破坏已有业务数据。
    expect((db.prepare("SELECT value FROM system_state WHERE key='kept'").get() as { value: string }).value).toBe("yes");
    // 升级后 schema 与最后一条记录指纹一致，随后再次 migrate() 为空操作。
    expect(after.at(-1)?.checksum).toBe(schemaFingerprint(db));
    migrate(db);
    expect(migrationRows(db)).toEqual(after);
    db.close();
  });

  it("keeps roll-call settings honest at the table level", () => {
    const db = createDb();
    const insert = db.prepare(`INSERT INTO rollcall_settings (id,scope_type,scope_id,enabled,notify,single_seconds,multi_seconds,revision,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    // 每个作用域只留一份设置，重复写入由调用方改为覆盖。
    expect(() => insert.run("r1", "device", "d1", 1, null, null, null, 1, "2026-09-11T00:00:00.000Z")).not.toThrow();
    expect(() => insert.run("r2", "device", "d1", null, 1, null, null, 2, "2026-09-11T00:00:00.000Z")).toThrow(/UNIQUE/i);
    // 全空的一行等于没表态：不该存在，清除覆盖走删除而不是写空。
    expect(() => insert.run("r3", "school", null, null, null, null, null, 3, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    expect(() => insert.run("r4", "school", null, 2, null, null, null, 4, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    // 秒数区间与插件端输入框一致，越界的脏数据在入库前就停住。
    expect(() => insert.run("r5", "school", null, null, null, 0, null, 5, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    expect(() => insert.run("r6", "school", null, null, null, null, 301, 6, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    expect(() => insert.run("r7", "elsewhere", null, 1, null, null, null, 7, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    db.close();
  });
});