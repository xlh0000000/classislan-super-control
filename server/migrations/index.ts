import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

// 贡献者：威廉（0015-device-timetables 设备课表档案迁移）

export type Migration = { id: string; up: (db: Database.Database) => void };

function addColumn(db: Database.Database, table: string, name: string, definition: string) {
  const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function execAll(db: Database.Database, statements: string[]) {
  for (const sql of statements) db.exec(sql);
}

const baseline: Migration = {
  id: "0000-baseline",
  up(db) {
    execAll(db, [
      `CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','auditor','viewer')),
        created_at TEXT NOT NULL,
        disabled_at TEXT
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS org_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES org_nodes(id),
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT '#526b59',
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        org_node_id TEXT REFERENCES org_nodes(id),
        public_key_jwk TEXT NOT NULL,
        key_thumbprint TEXT NOT NULL UNIQUE,
        plugin_version TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        capability_digest TEXT NOT NULL DEFAULT '',
        policy_revision INTEGER NOT NULL DEFAULT 0,
        drift_count INTEGER NOT NULL DEFAULT 0,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        last_request_hash TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        disabled_at TEXT
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS device_tags (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY(device_id, tag_id)
      ) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS enrollment_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('code','bundle')),
        org_node_id TEXT REFERENCES org_nodes(id),
        tag_ids TEXT NOT NULL DEFAULT '[]',
        max_uses INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS policy_revisions (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        document TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS policy_assignments (
        id TEXT PRIMARY KEY,
        policy_revision_id TEXT NOT NULL REFERENCES policy_revisions(id),
        scope_type TEXT NOT NULL CHECK(scope_type IN ('school','organization','tag','device')),
        scope_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        locks TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS configuration_revisions (
        id TEXT PRIMARY KEY,
        configuration_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('profile','components','automation','plugin')),
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        document TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        UNIQUE(configuration_id, revision)
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        scheduled_at TEXT,
        expires_at TEXT NOT NULL,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        capability_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        not_before TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        offered_at TEXT,
        acknowledged_at TEXT,
        result TEXT,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_commands_poll ON commands(device_id, state, not_before, expires_at)`,
      `CREATE TABLE IF NOT EXISTS capability_snapshots (
        device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        digest TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT`,
    ]);
  },
};

const taskOrchestration: Migration = {
  id: "0001-task-orchestration",
  up(db) {
    addColumn(db, "tasks", "mode", "TEXT NOT NULL DEFAULT 'all' CHECK(mode IN ('all','fixed','percent'))");
    addColumn(db, "tasks", "batch_size", "INTEGER");
    addColumn(db, "tasks", "percent", "INTEGER CHECK(percent IS NULL OR (percent BETWEEN 1 AND 100))");
    addColumn(db, "tasks", "failure_threshold", "INTEGER NOT NULL DEFAULT 0 CHECK(failure_threshold BETWEEN 0 AND 100)");
    addColumn(db, "tasks", "max_concurrency", "INTEGER NOT NULL DEFAULT 0 CHECK(max_concurrency >= 0)");
    addColumn(db, "tasks", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "tasks", "last_error", "TEXT");
    addColumn(db, "tasks", "idempotency_key", "TEXT");
    addColumn(db, "tasks", "target_snapshot", "TEXT NOT NULL DEFAULT '[]'");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL");

    addColumn(db, "commands", "lease_until", "TEXT");
    addColumn(db, "commands", "next_attempt_at", "TEXT");
    addColumn(db, "commands", "max_attempts", "INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "commands", "last_error", "TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_claim ON commands(device_id, state, not_before, expires_at, next_attempt_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_task ON commands(task_id, state)`);

    db.exec(`CREATE TABLE IF NOT EXISTS task_batches (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL,
      device_ids TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','active','succeeded','failed','cancelled','expired')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, batch_index)
    ) STRICT`);

    db.exec(`CREATE TABLE IF NOT EXISTS configurations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('profile','components','automation','plugin')),
      name TEXT NOT NULL,
      current_revision_id TEXT,
      updated_at TEXT NOT NULL
    ) STRICT`);

    db.exec(`CREATE TABLE IF NOT EXISTS config_requests (
      id TEXT PRIMARY KEY,
      configuration_id TEXT NOT NULL,
      requested_by TEXT REFERENCES users(id),
      state TEXT NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','accepted','fulfilled','expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT`);

    addColumn(db, "policy_assignments", "superseded_at", "TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_policy_assignments_active ON policy_assignments(scope_type, scope_id, priority, superseded_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_sequence ON audit_events(sequence)`);
  },
};

const enrollmentIdempotency: Migration = {
  id: "0002-enrollment-idempotency",
  up(db) {
    // 记录创建设备时使用的接入凭据，使注册重放能够安全地绑定到原始凭据。
    addColumn(db, "devices", "enrollment_token_id", "TEXT REFERENCES enrollment_tokens(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_devices_enrollment_token ON devices(enrollment_token_id)");
  },
};

const orgScopeRbac: Migration = {
  id: "0003-org-scope-rbac",
  up(db) {
    // 用户可被限定在某个组织子树内；NULL 表示全校范围（默认，owner 始终全校）。
    addColumn(db, "users", "scope_org_node_id", "TEXT REFERENCES org_nodes(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_scope ON users(scope_org_node_id)");
  },
};

const policyEpochAndCas: Migration = {
  id: "0004-policy-epoch-and-cas",
  up(db) {
    // 稳定作用域键：以空串代替 NULL，使 UNIQUE 索引也能约束 school 作用域。
    addColumn(db, "policy_assignments", "scope_key", "TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE policy_assignments SET scope_key=COALESCE(scope_id,'')");
    db.exec("CREATE INDEX IF NOT EXISTS idx_policy_assignments_active_v2 ON policy_assignments(scope_type, scope_key, priority, superseded_at)");
    // 同一作用域只保留最新一条 active assignment，其余转为历史，满足“唯一 active revision”。
    db.exec(`UPDATE policy_assignments SET superseded_at = COALESCE(superseded_at, created_at)
      WHERE superseded_at IS NULL AND EXISTS (
        SELECT 1 FROM policy_assignments newer
        WHERE newer.superseded_at IS NULL
          AND newer.scope_type = policy_assignments.scope_type
          AND newer.scope_key = policy_assignments.scope_key
          AND newer.rowid > policy_assignments.rowid)`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_assignments_one_active ON policy_assignments(scope_type, scope_key) WHERE superseded_at IS NULL");
    // 记录发布时声明的基线修订，作为 CAS 审计线索。
    addColumn(db, "policy_revisions", "base_revision", "INTEGER");

    // 单调期望状态 epoch：任何策略激活或成员关系变化都递增，使 revision 回退也能触发重同步。
    db.exec(`CREATE TABLE IF NOT EXISTS policy_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      desired_epoch INTEGER NOT NULL DEFAULT 0,
      restore_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT`);
    db.exec("INSERT OR IGNORE INTO policy_state (id,desired_epoch,restore_generation,updated_at) VALUES (1,0,0,'1970-01-01T00:00:00.000Z')");

    // 设备实际上报的 applied 状态，用于对比 desired/offered/applied。
    addColumn(db, "devices", "policy_epoch", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "devices", "applied_policy_hash", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "devices", "applied_policy_sections", "TEXT NOT NULL DEFAULT '{}'");
  },
};

const taskPauseAndCancel: Migration = {
  id: "0005-task-pause-and-cancel",
  up(db) {
    // 暂停冻结 TTL：记录暂停时刻，恢复时按暂停时长平移任务与未终态命令的截止时间。
    addColumn(db, "tasks", "paused_at", "TEXT");
    // 状态机聚合与任务详情都按 (task_id, state) 过滤，旧库在此补齐索引。
    db.exec("CREATE INDEX IF NOT EXISTS idx_commands_task_state ON commands(task_id, state)");
  },
};

const deviceResponseReplay: Migration = {
  id: "0006-device-response-replay",
  up(db) {
    // 以 (device_id, sequence) 为主键持久缓存完整已签名响应：同序列同摘要重放原响应，
    // 摘要不同拒绝，使“序列已提交但响应丢失”的客户端可用同一序列恢复，而不会永久 409。
    db.exec(`CREATE TABLE IF NOT EXISTS device_responses (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      request_hash TEXT NOT NULL,
      response_body TEXT NOT NULL,
      response_key_id TEXT NOT NULL,
      response_signature TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(device_id, sequence)
    ) STRICT`);
  },
};

const sessionsTable: Migration = {
  id: "0007-sessions-table",
  up(db) {
    // 会话表从请求期懒创建改为迁移期创建，避免未迁移的库在鉴权路径上隐式建表。
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT`);
  },
};

const enrollmentTokenTags: Migration = {
  id: "0008-enrollment-token-tags",
  up(db) {
    // 接入凭据的标签原本存于无外键的 JSON 列：删除标签后凭据会残留悬空 id，
    // 直到设备注册时才以含糊的 409 失败。规范化为关联表后，存在性由外键保证，
    // 标签删除会级联清理凭据引用，注册时不再可能拿到失效标签。
    db.exec(`CREATE TABLE IF NOT EXISTS enrollment_token_tags (
      enrollment_token_id TEXT NOT NULL REFERENCES enrollment_tokens(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY(enrollment_token_id, tag_id)
    ) WITHOUT ROWID`);
    db.exec(`INSERT OR IGNORE INTO enrollment_token_tags (enrollment_token_id, tag_id)
      SELECT token.id, tag.value FROM enrollment_tokens token, json_each(token.tag_ids) tag
      WHERE json_valid(token.tag_ids) AND tag.value IS NOT NULL
        AND EXISTS (SELECT 1 FROM tags t WHERE t.id = tag.value)`);
    const columns = (db.prepare("PRAGMA table_info(enrollment_tokens)").all() as { name: string }[]).map((column) => column.name);
    if (columns.includes("tag_ids")) db.exec("ALTER TABLE enrollment_tokens DROP COLUMN tag_ids");
  },
};

const taskIdempotencyScope: Migration = {
  id: "0009-task-idempotency-scope",
  up(db) {
    // 幂等键此前是全局唯一：不同调用者复用同一键会命中他人的任务，且同一键配不同请求会被静默去重。
    // 改为按调用者隔离，并记录请求摘要，使同键不同请求显式冲突。
    addColumn(db, "tasks", "idempotency_actor_id", "TEXT REFERENCES users(id)");
    addColumn(db, "tasks", "idempotency_request_hash", "TEXT");
    db.exec("DROP INDEX IF EXISTS idx_tasks_idempotency");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency_scoped ON tasks(idempotency_actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
    // 同一任务对同一设备只允许一条命令；历史重复先按“进度优先、尝试次数、创建时间”确定性收敛，再建立唯一约束。
    db.exec(`DELETE FROM commands WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id, device_id ORDER BY
          CASE state
            WHEN 'succeeded' THEN 0 WHEN 'failed' THEN 1 WHEN 'conflict' THEN 2 WHEN 'unsupported' THEN 3
            WHEN 'expired' THEN 4 WHEN 'cancelled' THEN 5 WHEN 'cancelling' THEN 6 WHEN 'running' THEN 7
            WHEN 'received' THEN 8 WHEN 'offered' THEN 9 WHEN 'pending' THEN 10 ELSE 11 END,
          attempt_count DESC, created_at ASC, id ASC) rn
        FROM commands
      ) ranked WHERE rn=1
    )`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_task_device ON commands(task_id, device_id)");
  },
};

const auditCheckpoints: Migration = {
  id: "0010-audit-checkpoints",
  up(db) {
    // 审计链头按周期用服务端签名私钥签名并落库，作为可离线校验的外部检查点：
    // 即使有人重写全部事件并重算哈希链，也无法伪造与已发布检查点一致的签名。
    db.exec(`CREATE TABLE IF NOT EXISTS audit_checkpoints (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      event_hash TEXT NOT NULL,
      checkpoint_hash TEXT NOT NULL,
      key_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_sequence ON audit_checkpoints(sequence DESC)");
  },
};

const buildingLayout: Migration = {
  id: "0011-building-layout",
  up(db) {
    // 楼栋 → 楼层 → 教室；room_devices 把设备绑定到唯一教室（一室多机、一机一室）。
    db.exec(`CREATE TABLE IF NOT EXISTS buildings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS building_floors (
      id TEXT PRIMARY KEY,
      building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS building_rooms (
      id TEXT PRIMARY KEY,
      floor_id TEXT NOT NULL REFERENCES building_floors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS room_devices (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES building_rooms(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    ) STRICT`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_room_devices_room ON room_devices(room_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_building_floors_building ON building_floors(building_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_building_rooms_floor ON building_rooms(floor_id)");
  },
};

const policyAppendMode: Migration = {
  id: "0012-policy-append-mode",
  up(db) {
    // 追加覆盖：记录修订的发布模式。replace 整份替换该目标此前的策略，
    // append 在其之上深合并本次给出的项，从而只改动选定的设置。
    addColumn(db, "policy_revisions", "mode", "TEXT NOT NULL DEFAULT 'replace'");
  },
};

const deviceTransport: Migration = {
  id: "0013-device-transport",
  up(db) {
    // 设备与集控端的连接模式：http 为短轮询，websocket 为常驻长连接。
    // 由管理端逐台指定，轮询/长连接响应回带期望值，设备按差值自动切换。
    addColumn(db, "devices", "transport", "TEXT NOT NULL DEFAULT 'http'");
  },
};

const rollCallRoster: Migration = {
  id: "0014-rollcall-roster",
  up(db) {
    // 点名名单：云端维护的姓名列表，按作用域下发到设备端悬浮窗。
    // 每个作用域最多一份名单；设备按 设备 > 最深的组织祖先 > 全校 解析。
    // revision 由全局单调计数器分配，设备上报已应用修订即可跳过重复下发。
    db.exec(`CREATE TABLE IF NOT EXISTS rollcall_rosters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('school','organization','device')),
      scope_id TEXT,
      names TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rollcall_rosters_scope ON rollcall_rosters(scope_type, COALESCE(scope_id,''))");
  },
};

const deviceTimetables: Migration = {
  id: "0015-device-timetables",
  up(db) {
    // 设备上传的课表档案快照：device_id 主键，digest 为 JCS+SHA-256 摘要用于幂等去重，
    // snapshot 为与 ClassIsland Profile 同构的 camelCase JSON，四类计数便于管理端概览。
    db.exec(`CREATE TABLE IF NOT EXISTS device_timetables (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      digest TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      subjects_count INTEGER NOT NULL DEFAULT 0,
      time_layouts_count INTEGER NOT NULL DEFAULT 0,
      class_plans_count INTEGER NOT NULL DEFAULT 0,
      class_plan_groups_count INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT NOT NULL
    ) STRICT`);
  },
};

const crashReports: Migration = {
  id: "0016-crash-reports",
  up(db) {
    // 设备端崩溃上报：一条记录 = 一次未处理异常（或一次非正常退出）。
    // 刻意不建 devices 外键：设备被删除后历史崩溃仍要留在统计里，org_node_id 冗余落库
    // 以便按组织范围过滤；fingerprint 由服务端按 异常类型 + 规范化栈帧 计算。
    db.exec(`CREATE TABLE IF NOT EXISTS crash_reports (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      org_node_id TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      stack_trace TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL,
      thread_name TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      plugin_version TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT ''
    ) STRICT`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_crash_reports_device ON crash_reports(device_id, occurred_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_crash_reports_fingerprint ON crash_reports(fingerprint, occurred_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_crash_reports_occurred ON crash_reports(occurred_at)");
  },
};

const autoTasks: Migration = {
  id: "0017-auto-tasks",
  up(db) {
    // 周期任务：调度定义按规则到期派生一次性任务实例；next_run_at 为 UTC 落库，
    // 规则里的时刻是本地墙钟（tz_offset_minutes），单校场景固定偏移即可无夏令时歧义。
    db.exec(`CREATE TABLE IF NOT EXISTS task_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      targets TEXT NOT NULL DEFAULT '[]',
      device_ids TEXT NOT NULL DEFAULT '[]',
      repeat TEXT NOT NULL CHECK(repeat IN ('daily','weekly','monthly','interval')),
      time_of_day TEXT,
      weekdays TEXT,
      day_of_month INTEGER,
      interval_minutes INTEGER,
      tz_offset_minutes INTEGER NOT NULL DEFAULT 480,
      start_at TEXT NOT NULL,
      end_at TEXT,
      ttl_minutes INTEGER NOT NULL DEFAULT 60,
      mode TEXT NOT NULL DEFAULT 'all' CHECK(mode IN ('all','fixed','percent')),
      batch_size INTEGER,
      percent INTEGER,
      failure_threshold INTEGER NOT NULL DEFAULT 0,
      max_concurrency INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','finished')),
      next_run_at TEXT,
      last_run_at TEXT,
      last_task_id TEXT,
      last_error TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_task_schedules_due ON task_schedules(state, next_run_at)");

    // 事件触发任务：device_offline 扫描 last_seen 超时，crash_threshold 在崩溃入库时评估。
    db.exec(`CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('device_offline','crash_threshold')),
      condition TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'school' CHECK(scope_type IN ('school','organization')),
      scope_id TEXT,
      targets TEXT NOT NULL DEFAULT '[]',
      capability_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      ttl_minutes INTEGER NOT NULL DEFAULT 60,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused')),
      last_fired_at TEXT,
      last_task_id TEXT,
      last_error TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`);
    // 触发台账：同一触发对同一设备一个故障期内只派生一次；设备恢复后被新事件重置。
    db.exec(`CREATE TABLE IF NOT EXISTS trigger_fires (
      trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      PRIMARY KEY(trigger_id, device_id)
    ) STRICT`);
  },
};

const teacherAccounts: Migration = {
  id: "0018-teacher-accounts",
  up(db) {
    // 教师角色要拓宽 users 的内联 CHECK，SQLite 只能整表重建。重建期间的
    // DROP TABLE users 会为每张引用它的子表记下一笔外键违规，这笔账即使把父表
    // 连同原样的行一起搬回来也销不掉——提交时照样报 FOREIGN KEY constraint failed。
    // 所以整表重建依赖 migrate() 在迁移事务期间关闭外键强制，提交后再统一校验孤儿行。
    db.exec(`CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','auditor','viewer','teacher')),
      created_at TEXT NOT NULL,
      disabled_at TEXT,
      scope_org_node_id TEXT REFERENCES org_nodes(id),
      must_change_password INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    db.exec(`INSERT INTO users_new (id,username,password_hash,display_name,role,created_at,disabled_at,scope_org_node_id,must_change_password)
      SELECT id,username,password_hash,display_name,role,created_at,disabled_at,scope_org_node_id,0 FROM users`);
    db.exec("DROP TABLE users");
    db.exec("ALTER TABLE users_new RENAME TO users");
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_scope ON users(scope_org_node_id)");
    // 教师与设备多对多：一台设备可绑多位教师，解绑一个账号不能牵连他人。
    db.exec(`CREATE TABLE IF NOT EXISTS device_teachers (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bound_by TEXT NOT NULL DEFAULT 'admin' CHECK(bound_by IN ('admin','qr')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(device_id, user_id)
    ) STRICT`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_device_teachers_user ON device_teachers(user_id)");
    // 屏显绑定码：设备经签名通道领取一次性码，教师端（未来手机端）扫码兑换绑定；只存哈希。
    addColumn(db, "devices", "binding_code_hash", "TEXT");
    addColumn(db, "devices", "binding_code_expires_at", "TEXT");
  },
};

/**
 * 点名设置：与名单同一套作用域，逐字段向下继承（设备 > 最近的组织祖先 > 全校）。
 * 每一列留空即“这一项不表态”，继续向上级继承，最终由设备本机的设置兜底，
 * 因此管理员可以只关掉全校的抽人，而不必先给每台机器写一遍。
 */
const rollCallSettings: Migration = {
  id: "0019-rollcall-settings",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS rollcall_settings (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('school','organization','device')),
      scope_id TEXT,
      enabled INTEGER CHECK(enabled IS NULL OR enabled IN (0,1)),
      notify INTEGER CHECK(notify IS NULL OR notify IN (0,1)),
      single_seconds INTEGER CHECK(single_seconds IS NULL OR (single_seconds BETWEEN 1 AND 120)),
      multi_seconds INTEGER CHECK(multi_seconds IS NULL OR (multi_seconds BETWEEN 2 AND 300)),
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(enabled IS NOT NULL OR notify IS NOT NULL OR single_seconds IS NOT NULL OR multi_seconds IS NOT NULL)
    ) STRICT`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rollcall_settings_scope ON rollcall_settings(scope_type, COALESCE(scope_id,''))");
  },
};

export const migrations: Migration[] = [baseline, taskOrchestration, enrollmentIdempotency, orgScopeRbac, policyEpochAndCas, taskPauseAndCancel, deviceResponseReplay, sessionsTable, enrollmentTokenTags, taskIdempotencyScope, auditCheckpoints, buildingLayout, policyAppendMode, deviceTransport, rollCallRoster, deviceTimetables, crashReports, autoTasks, teacherAccounts, rollCallSettings];

/** 对除 schema_migrations 外的全部 schema 对象做稳定指纹，用于校验迁移记录与真实 schema 是否一致。 */
export function schemaFingerprint(db: Database.Database) {
  const objects = db
    .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
      ORDER BY type,name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const canonical = objects.map((object) => `${object.type}\u0000${object.name}\u0000${object.tbl_name}\u0000${object.sql ?? ""}`).join("\u0001");
  return createHash("sha256").update(canonical).digest("hex");
}

export function migrate(db: Database.Database) {
  const known = new Set(migrations.map((migration) => migration.id));
  // 整表重建（DROP 父表）无法在开启外键强制的事务里提交，而 PRAGMA foreign_keys
  // 在事务内是空操作，只能在外层切换。迁移期间不强制外键，提交后统一用
  // foreign_key_check 验证没留下孤儿行——这也是 SQLite 官方推荐的重建步骤。
  const enforceForeignKeys = db.pragma("foreign_keys", { simple: true }) === 1;
  db.pragma("foreign_keys = OFF");
  let appliedAny = false;
  try {
    // BEGIN IMMEDIATE 从一开始就取得写锁并覆盖全部准备与迁移步骤：
    // 多进程同时启动时严格串行，且已应用集合在取得写锁之后才读取，
    // 后手不会基于过期快照重复执行迁移（那会撞上 schema_migrations 主键而崩溃）。
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL
      ) STRICT`);
      // 兼容早期只有 (id, applied_at) 的 schema_migrations。
      addColumn(db, "schema_migrations", "checksum", "TEXT NOT NULL DEFAULT ''");
      const applied = new Map(
        (db.prepare("SELECT id, checksum FROM schema_migrations").all() as { id: string; checksum: string }[])
          .map((row) => [row.id, row.checksum] as const),
      );
      // 数据库版本高于本程序能力：出现未知迁移时拒绝启动，避免旧二进制写入新 schema。
      for (const id of applied.keys()) {
        if (!known.has(id)) throw new Error(`数据库包含当前程序未知的迁移 ${id}，拒绝以旧版本启动以免损坏数据。`);
      }
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        migration.up(db);
        appliedAny = true;
        db.prepare("INSERT INTO schema_migrations (id,checksum,applied_at) VALUES (?,?,?)")
          .run(migration.id, schemaFingerprint(db), new Date().toISOString());
      }
    }).immediate();
  } finally {
    if (enforceForeignKeys) db.pragma("foreign_keys = ON");
  }
  if (appliedAny) {
    const orphans = db.prepare("PRAGMA foreign_key_check").all() as { table: string; rowid: number; parent: string }[];
    if (orphans.length) {
      const where = [...new Set(orphans.map((row) => `${row.table}→${row.parent}`))].join("、");
      throw new Error(`迁移后检出 ${orphans.length} 条悬空外键（${where}），schema 已升级但数据一致性未通过校验，拒绝启动以免继续写坏。`);
    }
  }
  // 校验最终 schema 与最后一次迁移记录的指纹一致，检测外部手工改动。
  const recorded = db.prepare("SELECT checksum FROM schema_migrations ORDER BY id DESC LIMIT 1").get() as { checksum: string } | undefined;
  if (recorded?.checksum) {
    const actual = schemaFingerprint(db);
    if (recorded.checksum !== actual) throw new Error("数据库 schema 与迁移记录不一致（可能被外部修改），拒绝启动。");
  }
}
