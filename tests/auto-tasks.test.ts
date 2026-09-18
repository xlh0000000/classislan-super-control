import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { nextOccurrence, validateScheduleRule, type ScheduleRule } from "../server/utils/schedule-rules";
import { advanceSchedules } from "../server/utils/auto-tasks";
import { advanceTriggers, evaluateCrashTriggers } from "../server/utils/auto-triggers";

const NOW = "2026-09-11T00:00:00.000Z";
const TZ = 480; // UTC+8
const OWNER_ID = "owner-1";
const DEVICE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CAPABILITY = "notification.own-provider.send.v1";

describe("周期规则下次触发", () => {
  const daily: ScheduleRule = {
    repeat: "daily", timeOfDay: "07:30", tzOffsetMinutes: TZ, startAt: "2026-09-01T00:00:00.000Z",
  };

  it("daily：本地时刻未过取当天，已过取次日", () => {
    // 本地 2026-09-02 04:00（UTC 09-01 20:00）→ 当天 07:30 本地 = UTC 23:30。
    expect(nextOccurrence(daily, "2026-09-01T20:00:00.000Z")).toBe("2026-09-01T23:30:00.000Z");
    // 本地 2026-09-02 08:00（UTC 00:00）→ 已过 07:30，落到次日 09-03 本地。
    expect(nextOccurrence(daily, "2026-09-02T00:00:00.000Z")).toBe("2026-09-02T23:30:00.000Z");
  });

  it("weekly：只在选定的星期触发", () => {
    const rule: ScheduleRule = { ...daily, repeat: "weekly", weekdays: [1, 4] };
    // 2026-09-02 是周三，本地 10:00 → 下一个命中日是周四 09-03 的 08:00（UTC 00:00）。
    expect(nextOccurrence({ ...rule, timeOfDay: "08:00" }, "2026-09-02T02:00:00.000Z")).toBe("2026-09-03T00:00:00.000Z");
  });

  it("monthly：当月没有该日则整月跳过而不是折算到月末", () => {
    const rule: ScheduleRule = { ...daily, startAt: "2026-01-01T00:00:00.000Z", repeat: "monthly", dayOfMonth: 31, timeOfDay: "00:00" };
    // 2026 年 2 月只有 28 天 → 从 2 月中直接跳到 3 月 31 日（本地 00:00 = UTC 前一天 16:00）。
    expect(nextOccurrence(rule, "2026-02-10T02:00:00.000Z")).toBe("2026-03-30T16:00:00.000Z");
    // 1 月评估时则正常落在 1 月 31 日。
    expect(nextOccurrence(rule, "2026-01-15T02:00:00.000Z")).toBe("2026-01-30T16:00:00.000Z");
  });

  it("interval：以 startAt 或上次执行为锚点滚动，长期停机只补一次", () => {
    const rule: ScheduleRule = { repeat: "interval", intervalMinutes: 30, tzOffsetMinutes: TZ, startAt: "2026-09-01T00:00:00.000Z" };
    // 距锚点 97 分钟 → 取模快进后落 02:00。
    expect(nextOccurrence(rule, "2026-09-01T01:37:00.000Z")).toBe("2026-09-01T02:00:00.000Z");
    // 上次执行 10 分钟前 → 下次 20 分钟后。
    expect(nextOccurrence({ ...rule, lastRunAt: "2026-09-01T01:27:00.000Z" }, "2026-09-01T01:37:00.000Z")).toBe("2026-09-01T01:57:00.000Z");
  });

  it("endAt 之后没有触发点", () => {
    const rule: ScheduleRule = { ...daily, endAt: "2026-09-01T23:00:00.000Z" };
    expect(nextOccurrence(rule, "2026-09-01T20:00:00.000Z")).toBeNull();
  });

  it("validateScheduleRule 守住每种重复方式的必填项", () => {
    expect(validateScheduleRule(daily)).toBeNull();
    expect(validateScheduleRule({ ...daily, repeat: "weekly", weekdays: null })).toContain("weekdays");
    expect(validateScheduleRule({ ...daily, repeat: "monthly", dayOfMonth: 32 })).toContain("day_of_month");
    expect(validateScheduleRule({ repeat: "interval", intervalMinutes: 1, tzOffsetMinutes: TZ, startAt: daily.startAt })).toContain("5..20160");
    expect(validateScheduleRule({ ...daily, endAt: "2025-01-01T00:00:00.000Z" })).toContain("end_at");
  });
});

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
    .run(OWNER_ID, "owner", "x", "校长", "owner", NOW);
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)")
    .run("root-1", null, "全校", "/", 0, NOW);
  return db;
}

function seedDevice(db: Database.Database, id: string, lastSeenAt: string | null = NOW) {
  db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, `设备 ${id.slice(0, 4)}`, "root-1", "{}", `thumb-${id}`, lastSeenAt, NOW);
  db.prepare("INSERT INTO capability_snapshots (device_id,digest,capabilities,updated_at) VALUES (?,?,?,?)")
    .run(id, "dig", JSON.stringify([{ id: CAPABILITY, schemaVersion: 1 }]), NOW);
}

function insertSchedule(db: Database.Database, overrides: Partial<Record<string, unknown>> = {}) {
  const values: Record<string, unknown> = {
    id: "sch-1", name: "早间提醒", capability_id: CAPABILITY, payload: JSON.stringify({ title: "t", content: "c" }),
    targets: "[]", device_ids: JSON.stringify([DEVICE_A]),
    repeat: "daily", time_of_day: "07:30", weekdays: null, day_of_month: null, interval_minutes: null,
    tz_offset_minutes: TZ, start_at: "2026-09-01T00:00:00.000Z", end_at: null,
    ttl_minutes: 60, mode: "all", batch_size: null, percent: null,
    failure_threshold: 0, max_concurrency: 0, max_attempts: 1,
    state: "active", next_run_at: NOW, last_run_at: null, last_task_id: null, last_error: null,
    created_by: OWNER_ID, created_at: NOW, updated_at: NOW,
  };
  const row = { ...values, ...overrides };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO task_schedules (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((column) => row[column]));
  return String(row.id);
}

function insertTrigger(db: Database.Database, overrides: Partial<Record<string, unknown>> = {}) {
  const values: Record<string, unknown> = {
    id: "trg-1", name: "离线告警", kind: "device_offline", condition: JSON.stringify({ offlineMinutes: 30 }),
    scope_type: "school", scope_id: null, targets: "[]",
    capability_id: CAPABILITY, payload: JSON.stringify({ title: "t", content: "c" }),
    ttl_minutes: 60, cooldown_minutes: 60, state: "active",
    last_fired_at: null, last_task_id: null, last_error: null,
    created_by: OWNER_ID, created_at: NOW, updated_at: NOW,
  };
  const row = { ...values, ...overrides };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO triggers (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((column) => row[column]));
  return String(row.id);
}

function taskCount(db: Database.Database) {
  return (db.prepare("SELECT COUNT(*) count FROM tasks").get() as { count: number }).count;
}

describe("周期调度到期派生", () => {
  it("到期调度派生任务与命令，并推进下次触发", () => {
    const db = createDb();
    seedDevice(db, DEVICE_A);
    insertSchedule(db);
    expect(advanceSchedules(db, NOW)).toBe(1);
    const task = db.prepare("SELECT state,capability_id,created_by,target_snapshot FROM tasks").get() as { state: string; capability_id: string; created_by: string; target_snapshot: string };
    expect(task.state).toBe("running");
    expect(task.capability_id).toBe(CAPABILITY);
    expect(task.created_by).toBe(OWNER_ID);
    expect(JSON.parse(task.target_snapshot)).toEqual([{ id: DEVICE_A, orgNodeId: "root-1" }]);
    expect((db.prepare("SELECT COUNT(*) count FROM commands").get() as { count: number }).count).toBe(1);
    const schedule = db.prepare("SELECT state,next_run_at,last_run_at,last_task_id FROM task_schedules").get() as { state: string; next_run_at: string; last_run_at: string; last_task_id: string | null };
    expect(schedule.state).toBe("active");
    // 本地 08:00 触发之后 → 次日 07:30 本地 = 当日 UTC 23:30。
    expect(schedule.next_run_at).toBe("2026-09-11T23:30:00.000Z");
    expect(schedule.last_task_id).toBeTruthy();
    db.close();
  });

  it("未到期的调度不动", () => {
    const db = createDb();
    seedDevice(db, DEVICE_A);
    insertSchedule(db, { next_run_at: "2027-01-01T00:00:00.000Z" });
    expect(advanceSchedules(db, NOW)).toBe(0);
    expect(taskCount(db)).toBe(0);
    db.close();
  });

  it("最后一次触发之后调度自动结束", () => {
    const db = createDb();
    seedDevice(db, DEVICE_A);
    insertSchedule(db, { end_at: "2026-09-11T01:00:00.000Z" });
    expect(advanceSchedules(db, NOW)).toBe(1);
    const schedule = db.prepare("SELECT state,next_run_at FROM task_schedules").get() as { state: string; next_run_at: string | null };
    expect(schedule.state).toBe("finished");
    expect(schedule.next_run_at).toBeNull();
    db.close();
  });

  it("目标能力不受支持时记录错误但照常推进", () => {
    const db = createDb();
    seedDevice(db, DEVICE_A);
    insertSchedule(db);
    db.prepare("UPDATE capability_snapshots SET capabilities=?").run("[]");
    expect(advanceSchedules(db, NOW)).toBe(0);
    const schedule = db.prepare("SELECT state,next_run_at,last_error FROM task_schedules").get() as { state: string; next_run_at: string; last_error: string | null };
    expect(schedule.last_error).toContain(CAPABILITY);
    expect(schedule.next_run_at).toBe("2026-09-11T23:30:00.000Z");
    db.close();
  });

  it("创建者被禁用后调度暂停而不是越权派生", () => {
    const db = createDb();
    seedDevice(db, DEVICE_A);
    insertSchedule(db);
    db.prepare("UPDATE users SET disabled_at=? WHERE id=?").run(NOW, OWNER_ID);
    expect(advanceSchedules(db, NOW)).toBe(0);
    const schedule = db.prepare("SELECT state,last_error FROM task_schedules").get() as { state: string; last_error: string };
    expect(schedule.state).toBe("paused");
    expect(schedule.last_error).toContain("创建者");
    expect(taskCount(db)).toBe(0);
    db.close();
  });
});

describe("设备离线触发器", () => {
  function seedOffline(db: Database.Database, lastSeenAt: string | null = "2026-09-10T22:00:00.000Z") {
    seedDevice(db, DEVICE_A, lastSeenAt);
    insertTrigger(db, { payload: JSON.stringify({ title: "离线", content: "{{deviceName}} 离线 {{offlineMinutes}} 分钟" }) });
  }

  it("离线超过阈值时派生一次任务并写台账", () => {
    const db = createDb();
    seedOffline(db);
    expect(advanceTriggers(db, NOW)).toBe(1);
    const task = db.prepare("SELECT name,payload FROM tasks").get() as { name: string; payload: string };
    expect(task.payload).toContain("离线 30 分钟");
    expect((db.prepare("SELECT COUNT(*) count FROM commands WHERE device_id=?").get(DEVICE_A) as { count: number }).count).toBe(1);
    db.close();
  });

  it("同一故障期（未重连）不重复派生", () => {
    const db = createDb();
    seedOffline(db);
    expect(advanceTriggers(db, NOW)).toBe(1);
    expect(advanceTriggers(db, "2026-09-11T01:00:00.000Z")).toBe(0);
    expect(taskCount(db)).toBe(1);
    db.close();
  });

  it("重连后再次超时且过了冷却期才重新派生", () => {
    const db = createDb();
    seedOffline(db);
    expect(advanceTriggers(db, NOW)).toBe(1);
    const seen = db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?");
    // 重连 35 分钟后又掉线：00:45 时已满足离线 30 分钟，但距上次派生（00:00）未满 60 分钟冷却。
    seen.run("2026-09-11T00:10:00.000Z", DEVICE_A);
    expect(advanceTriggers(db, "2026-09-11T00:45:00.000Z")).toBe(0);
    // 冷却期过且设备处于新的故障期（00:10 重连晚于 fired_at）→ 再次派生。
    expect(advanceTriggers(db, "2026-09-11T01:30:00.000Z")).toBe(1);
    expect(taskCount(db)).toBe(2);
    db.close();
  });

  it("在线设备与刚注册未上报的设备都不触发", () => {
    const db = createDb();
    seedOffline(db, "2026-09-10T23:45:00.000Z"); // 离线 15 分钟，未超阈值
    seedDevice(db, "bbbbbbbb-0000-4000-8000-000000000002", null); // 从未上报
    expect(advanceTriggers(db, NOW)).toBe(0);
    expect(taskCount(db)).toBe(0);
    db.close();
  });
});

describe("崩溃阈值触发器", () => {
  function seedCrash(db: Database.Database, occurredAt: string, index: number) {
    db.prepare(`INSERT INTO crash_reports
      (id,device_id,org_node_id,occurred_at,received_at,kind,exception_type,message,stack_trace,fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`crash-${index}`, DEVICE_A, "root-1", occurredAt, occurredAt, "unhandled", "System.Exception", "m", "s", `fp-${index}`);
  }

  function seed(db: Database.Database) {
    seedDevice(db, DEVICE_A);
    insertTrigger(db, {
      kind: "crash_threshold", condition: JSON.stringify({ count: 2, windowMinutes: 60 }), cooldown_minutes: 30,
      payload: JSON.stringify({ title: "崩溃", content: "{{deviceName}} 窗口内 {{crashCount}} 次" }),
    });
  }

  it("窗口内达到阈值才派生，payload 占位符被渲染", () => {
    const db = createDb();
    seed(db);
    seedCrash(db, "2026-09-10T23:50:00.000Z", 1);
    seedCrash(db, "2026-09-10T23:55:00.000Z", 2);
    seedCrash(db, "2026-09-10T20:00:00.000Z", 3); // 窗口外
    expect(evaluateCrashTriggers(db, DEVICE_A, NOW)).toBe(1);
    const task = db.prepare("SELECT payload FROM tasks").get() as { payload: string };
    expect(task.payload).toContain("窗口内 2 次");
    db.close();
  });

  it("冷却期内不再触发，冷却过后可再次触发", () => {
    const db = createDb();
    seed(db);
    seedCrash(db, "2026-09-10T23:50:00.000Z", 1);
    seedCrash(db, "2026-09-10T23:55:00.000Z", 2);
    expect(evaluateCrashTriggers(db, DEVICE_A, NOW)).toBe(1);
    expect(evaluateCrashTriggers(db, DEVICE_A, "2026-09-11T00:10:00.000Z")).toBe(0);
    // 冷却 30 分钟后窗口内仍有 2 条 → 再次派生。
    expect(evaluateCrashTriggers(db, DEVICE_A, "2026-09-11T00:45:00.000Z")).toBe(1);
    expect(taskCount(db)).toBe(2);
    db.close();
  });

  it("只监控触发器组织范围内的设备", () => {
    const db = createDb();
    db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,?,?)")
      .run("other-org", null, "其他片区", "/other", 1, NOW);
    seedDevice(db, DEVICE_A);
    insertTrigger(db, {
      kind: "crash_threshold", condition: JSON.stringify({ count: 1, windowMinutes: 60 }),
      scope_type: "organization", scope_id: "other-org",
    });
    db.prepare(`INSERT INTO crash_reports
      (id,device_id,org_node_id,occurred_at,received_at,kind,exception_type,message,stack_trace,fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run("c1", DEVICE_A, "root-1", "2026-09-10T23:59:00.000Z", "2026-09-10T23:59:00.000Z", "unhandled", "E", "m", "s", "f1");
    expect(evaluateCrashTriggers(db, DEVICE_A, NOW)).toBe(0);
    db.close();
  });
});
