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
    // 只落后最后一条：修订自带锁、接入只下发一份策略都已在，缺点名设置的那颗「多人」按钮开关。
    const columnsBefore = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((column) => column.name);
    const tokenColumnsBefore = (db.prepare("PRAGMA table_info(enrollment_tokens)").all() as { name: string }[]).map((column) => column.name);
    const revisionColumnsBefore = (db.prepare("PRAGMA table_info(policy_revisions)").all() as { name: string }[]).map((column) => column.name);
    const settingsColumnsBefore = (db.prepare("PRAGMA table_info(rollcall_settings)").all() as { name: string }[]).map((column) => column.name);
    expect(columnsBefore).toContain("binding_code_hash");
    expect(tableExists(db, "device_teachers")).toBe(true);
    expect(tableExists(db, "rollcall_settings")).toBe(true);
    expect(tableExists(db, "enrollment_token_configs")).toBe(false);
    expect(tableExists(db, "plugin_releases")).toBe(true);
    expect(tableExists(db, "plugin_update_targets")).toBe(true);
    expect(tableExists(db, "plugin_download_tokens")).toBe(true);
    expect(tokenColumnsBefore).toContain("policy_revision_id");
    expect(revisionColumnsBefore).toContain("scope_type");
    expect(revisionColumnsBefore).toContain("locks");
    expect(settingsColumnsBefore).not.toContain("multi_enabled");
    const NOW = "2026-09-11T00:00:00.000Z";
    // 旧表上没有新列，「只关掉多人按钮」会被旧的空行约束拒掉——正是要升级掉的行为。
    expect(() => db.prepare(`INSERT INTO rollcall_settings (id,scope_type,scope_id,enabled,notify,single_seconds,multi_seconds,revision,updated_at)
      VALUES ('legacy',?,?,?,?,?,?,?,?)`).run("school", null, null, 1, null, null, 1, NOW)).not.toThrow();
    expect(() => db.prepare(`INSERT INTO rollcall_settings (id,scope_type,scope_id,enabled,notify,single_seconds,multi_seconds,revision,updated_at)
      VALUES ('multi-only',?,?,?,?,?,?,?,?)`).run("school", null, null, null, null, null, 2, NOW)).toThrow(/CHECK constraint/i);
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('kept','yes',?)").run(NOW);

    migrate(db);

    const after = migrationRows(db);
    expect(after.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
    // 既有迁移记录逐字节不变，只有缺失的那一条被追加。
    expect(after.slice(0, -1)).toEqual(before);
    expect(tableExists(db, "device_teachers")).toBe(true);
    expect(tableExists(db, "plugin_releases")).toBe(true);
    const columnsAfter = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((column) => column.name);
    expect(columnsAfter).toContain("plugin_update_state");
    expect(columnsAfter).toContain("plugin_update_version");
    // 缺的那一条补上了：整表重建换来一列开关，旧行逐字段照搬、新列以「不表态」落地。
    const settingsColumnsAfter = (db.prepare("PRAGMA table_info(rollcall_settings)").all() as { name: string }[]).map((column) => column.name);
    expect(settingsColumnsAfter).toContain("multi_enabled");
    expect(db.prepare("SELECT scope_type scopeType,scope_id scopeId,enabled,multi_enabled multiEnabled,notify,single_seconds singleSeconds,multi_seconds multiSeconds,revision FROM rollcall_settings WHERE id='legacy'").get())
      .toEqual({ scopeType: "school", scopeId: null, enabled: null, multiEnabled: null, notify: 1, singleSeconds: null, multiSeconds: null, revision: 1 });
    // 重建后的表能存下只表态多人按钮的一行，这正是新开关的最小可用形态。
    expect(() => db.prepare(`INSERT INTO rollcall_settings (id,scope_type,scope_id,enabled,multi_enabled,notify,single_seconds,multi_seconds,revision,updated_at)
      VALUES ('multi-after',?,?,?,?,?,?,?,?,?)`).run("device", "dev-9", null, 0, null, null, null, 3, NOW)).not.toThrow();
    // 升级不伤及其它表：凭据上的策略引用列完好。
    const tokenColumnsAfter = (db.prepare("PRAGMA table_info(enrollment_tokens)").all() as { name: string }[]).map((column) => column.name);
    expect(tokenColumnsAfter).toContain("policy_revision_id");
    // 升级不破坏已有业务数据。
    expect((db.prepare("SELECT value FROM system_state WHERE key='kept'").get() as { value: string }).value).toBe("yes");
    // 升级后 schema 与最后一条记录指纹一致，随后再次 migrate() 为空操作。
    expect(after.at(-1)?.checksum).toBe(schemaFingerprint(db));
    migrate(db);
    expect(migrationRows(db)).toEqual(after);
    db.close();
  });

  it("backfills each policy revision with the locks of the assignment that published it", () => {
    // 0025 之后锁随修订存档，「沿用某一份历史修订」才答得上来当时锁了什么。
    const db = createDbBefore("0025-policy-revision-locks");
    const NOW = "2026-09-11T00:00:00.000Z";
    const insertRevision = db.prepare("INSERT INTO policy_revisions (id,revision,name,document,document_hash,created_at,mode) VALUES (?,?,?,?,?,?,?)");
    insertRevision.run("pr-active-first", 1, "在用指派排在前面", "{}", "hash-1", NOW, "replace");
    insertRevision.run("pr-history-only", 2, "只有历史指派", "{}", "hash-2", NOW, "replace");
    insertRevision.run("pr-unassigned", 3, "从没挂上去", "{}", "hash-3", NOW, "replace");
    const insertAssignment = db.prepare(`INSERT INTO policy_assignments (id,policy_revision_id,scope_type,scope_id,scope_key,priority,locks,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    // 同一作用域只能有一条在用指派，所以两种「多条历史」的形状分开摆在不同作用域上。
    insertAssignment.run("pa-active", "pr-active-first", "device", "dev-9", "dev-9", 0, '["/components"]', NOW);
    // 后写入的历史指派（rowid 更大）不能盖掉还在用的那条：生效中的才是这一版当前的锁。
    insertAssignment.run("pa-superseded-newer", "pr-active-first", "organization", "o1", "o1", 0, '["/profile"]', NOW);
    db.prepare("UPDATE policy_assignments SET superseded_at=? WHERE id='pa-superseded-newer'").run(NOW);
    // 已被顶替的修订没有在用指派：取最近那条历史，也就是这一版最后一次挂上去时的锁。
    insertAssignment.run("pa-old", "pr-history-only", "device", "dev-1", "dev-1", 0, '["/oldest"]', NOW);
    insertAssignment.run("pa-newer", "pr-history-only", "device", "dev-2", "dev-2", 0, '["/latest"]', NOW);
    db.prepare("UPDATE policy_assignments SET superseded_at=? WHERE id IN ('pa-old','pa-newer')").run(NOW);

    migrate(db);

    const locks = db.prepare("SELECT id, locks FROM policy_revisions ORDER BY id").all() as { id: string; locks: string }[];
    expect(locks).toEqual([
      { id: "pr-active-first", locks: '["/components"]' },
      { id: "pr-history-only", locks: '["/latest"]' },
      { id: "pr-unassigned", locks: "[]" },
    ]);
    db.close();
  });

  it("keeps the enrollment credential's policy reference honest", () => {
    const db = createDb();
    const NOW = "2026-09-21T00:00:00.000Z";
    const insertToken = db.prepare(`INSERT INTO enrollment_tokens (id,token_hash,kind,max_uses,expires_at,created_at,policy_revision_id)
      VALUES (?,?,'code',1,?,?,?)`);
    db.prepare("INSERT INTO policy_revisions (id,revision,name,document,document_hash,created_at,mode) VALUES (?,?,?,?,?,?,?)")
      .run("pr-1", 1, "全校基线", "{}", "hash", NOW, "replace");
    insertToken.run("t-1", "hash-1", NOW, NOW, "pr-1");
    // 绑定不存在的修订等于让新设备去下发一份读不到的策略。
    expect(() => insertToken.run("t-2", "hash-2", NOW, NOW, "pr-missing")).toThrow(/FOREIGN KEY constraint/i);
    // 不绑定策略是正常路径：列可空，预设仍可由配置绑定拼出来。
    expect(() => insertToken.run("t-3", "hash-3", NOW, NOW, null)).not.toThrow();
    db.close();
  });

  it("keeps roll-call settings honest at the table level", () => {
    const db = createDb();
    const insert = db.prepare(`INSERT INTO rollcall_settings (id,scope_type,scope_id,enabled,multi_enabled,notify,single_seconds,multi_seconds,revision,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    // 每个作用域只留一份设置，重复写入由调用方改为覆盖。
    expect(() => insert.run("r1", "device", "d1", 1, null, null, null, null, 1, "2026-09-11T00:00:00.000Z")).not.toThrow();
    expect(() => insert.run("r2", "device", "d1", null, 1, null, null, null, 2, "2026-09-11T00:00:00.000Z")).toThrow(/UNIQUE/i);
    // 全空的一行等于没表态：不该存在，清除覆盖走删除而不是写空。
    expect(() => insert.run("r3", "school", null, null, null, null, null, null, 3, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    // 只把「多人」按钮关掉也算表态，这一行必须存得下。
    expect(() => insert.run("r3b", "organization", "o1", null, 0, null, null, null, 4, "2026-09-11T00:00:00.000Z")).not.toThrow();
    expect(() => insert.run("r4", "school", null, 2, null, null, null, null, 5, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    expect(() => insert.run("r4b", "school", null, null, 2, null, null, null, 6, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    // 秒数区间与插件端输入框一致，越界的脏数据在入库前就停住。
    expect(() => insert.run("r5", "school", null, null, null, null, 0, null, 7, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    expect(() => insert.run("r6", "school", null, null, null, null, null, 301, 8, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    expect(() => insert.run("r7", "elsewhere", null, 1, null, null, null, null, 9, "2026-09-11T00:00:00.000Z")).toThrow(/CHECK constraint/i);
    db.close();
  });

  it("keeps plugin release storage honest at the table level", () => {
    const db = createDb();
    const NOW = "2026-09-21T00:00:00.000Z";
    const hash = (n: string) => n.repeat(64).slice(0, 64);
    const release = db.prepare("INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_at) VALUES (?,?,?,?,?,?)");
    release.run("0.1.7.0", "ClassIsland.Control-0.1.7.0.cipx", 4096, hash("a"), 1, NOW);
    // 「当前版本」是回滚目标，同时存在两份会让管理员按错的那份下发。
    expect(() => release.run("0.1.8.0", "b.cipx", 4096, hash("b"), 1, NOW)).toThrow(/UNIQUE/i);
    expect(() => release.run("0.1.9.0", "c.cipx", 4096, hash("c"), 0, NOW)).not.toThrow();
    // 大小与哈希的约束拦的是坏数据本身：0 字节和短哈希都意味着文件已经不可信。
    expect(() => release.run("0.2.0.0", "d.cipx", 0, hash("d"), 0, NOW)).toThrow(/CHECK constraint/i);
    expect(() => release.run("0.2.1.0", "e.cipx", 26214401, hash("e"), 0, NOW)).toThrow(/CHECK constraint/i);
    expect(() => release.run("0.2.2.0", "f.cipx", 4096, hash("f").slice(0, 63), 0, NOW)).toThrow(/CHECK constraint/i);

    const target = db.prepare("INSERT INTO plugin_update_targets (id,scope_type,scope_id,version,updated_at) VALUES (?,?,?,?,?)");
    target.run("t1", "school", null, "0.1.7.0", NOW);
    target.run("t2", "tag", "tag-1", "0.1.9.0", NOW);
    // 一个作用域只留一个目标版本，改目标走覆盖。
    expect(() => target.run("t3", "school", null, "0.1.9.0", NOW)).toThrow(/UNIQUE/i);
    // 指向没发布过的版本等于让设备去下载不存在的东西。
    expect(() => target.run("t4", "device", "dev-1", "9.9.9.9", NOW)).toThrow(/FOREIGN KEY constraint/i);

    db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?)")
      .run("dev-1", "测试设备", "{}", "thumb-1", NOW);
    db.prepare("INSERT INTO plugin_download_tokens (token_hash,device_id,version,expires_at,created_at) VALUES (?,?,?,?,?)")
      .run(hash("1"), "dev-1", "0.1.7.0", "2026-09-22T00:00:00.000Z", NOW);
    // 撤回一份发布物，指向它的目标和已发出的下载凭据一起消失，不留悬空版本。
    db.prepare("DELETE FROM plugin_releases WHERE version='0.1.7.0'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM plugin_update_targets WHERE scope_type='school'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM plugin_download_tokens").get()).toEqual({ c: 0 });
    // 设备注销后凭据也不该留着。
    target.run("t5", "device", "dev-1", "0.1.9.0", NOW);
    db.prepare("INSERT INTO plugin_download_tokens (token_hash,device_id,version,expires_at,created_at) VALUES (?,?,?,?,?)")
      .run(hash("2"), "dev-1", "0.1.9.0", "2026-09-22T00:00:00.000Z", NOW);
    db.prepare("DELETE FROM devices WHERE id='dev-1'").run();
    // scope_id 是多态作用域（组织/标签/设备共用一列），做不了外键，
    // 所以设备注销只带走凭据；对应的目标行由删除设备的接口自己清理。
    expect(db.prepare("SELECT COUNT(*) c FROM plugin_download_tokens").get()).toEqual({ c: 0 });
    db.close();
  });
});