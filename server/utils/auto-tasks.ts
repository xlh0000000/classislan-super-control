import { z } from "zod";
import type Database from "better-sqlite3";
import { nextOccurrence, type ScheduleRule } from "./schedule-rules";
import { createTaskWithin, taskSelectorSchema, type TaskActor, type TaskSelector } from "./task-create";
import { deviceScopeFilter } from "./scope";

/**
 * 周期任务推进器：调度定义到期后派生一次性任务实例。与 advanceTaskState 共用
 * 同一个 IMMEDIATE 事务，派生写入与状态收敛串行，避免调度器与 poll 竞争造成重复派生。
 */

export type ScheduleRow = {
  id: string;
  name: string;
  capability_id: string;
  payload: string;
  targets: string;
  device_ids: string;
  repeat: ScheduleRule["repeat"];
  time_of_day: string | null;
  weekdays: string | null;
  day_of_month: number | null;
  interval_minutes: number | null;
  tz_offset_minutes: number;
  start_at: string;
  end_at: string | null;
  ttl_minutes: number;
  mode: string;
  batch_size: number | null;
  percent: number | null;
  failure_threshold: number;
  max_concurrency: number;
  max_attempts: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_by: string | null;
};

export function scheduleRuleOf(row: ScheduleRow, lastRunAt?: string | null): ScheduleRule {
  return {
    repeat: row.repeat,
    timeOfDay: row.time_of_day,
    weekdays: row.weekdays ? JSON.parse(row.weekdays) as number[] : null,
    dayOfMonth: row.day_of_month,
    intervalMinutes: row.interval_minutes,
    tzOffsetMinutes: row.tz_offset_minutes,
    startAt: row.start_at,
    endAt: row.end_at,
    lastRunAt: lastRunAt ?? row.last_run_at,
  };
}

function userActor(db: Database.Database, createdById: string | null): (TaskActor & { id: string }) | null {
  if (!createdById) return null;
  const user = db.prepare("SELECT id,role,scope_org_node_id scopeOrgNodeId,disabled_at disabledAt FROM users WHERE id=?")
    .get(createdById) as { id: string; role: string; scopeOrgNodeId: string | null; disabledAt: string | null } | undefined;
  if (!user || user.disabledAt) return null;
  return { id: user.id, role: user.role, scopeOrgNodeId: user.scopeOrgNodeId };
}

/**
 * 到期调度派生任务。返回本次派生的任务数，供测试与日志观察。
 * 派生失败（如目标设备全部被禁用）不吞掉调度：记录 last_error 并照常推进下次触发。
 */
export function advanceSchedules(db: Database.Database, at?: string): number {
  const now = at ?? new Date().toISOString();
  const due = db.prepare(`SELECT * FROM task_schedules
    WHERE state='active' AND next_run_at IS NOT NULL AND next_run_at<=?`).all(now) as ScheduleRow[];
  let derived = 0;
  for (const row of due) {
    // 条件更新认领：只有把 next_run_at 从命中的旧值挪开的那次推进才允许派生，防重入双发。
    const claim = db.prepare("UPDATE task_schedules SET next_run_at=NULL,updated_at=? WHERE id=? AND next_run_at=? AND state='active'")
      .run(now, row.id, row.next_run_at);
    if (claim.changes !== 1) continue;
    const nextRunAt = nextOccurrence(scheduleRuleOf(row, now), now);

    let error: string | null = null;
    const actor = userActor(db, row.created_by);
    if (!actor) {
      db.prepare("UPDATE task_schedules SET state='paused',last_error=?,updated_at=? WHERE id=?")
        .run("创建者已失效或被禁用，无法代表其派生任务；调度已暂停。", now, row.id);
      continue;
    }
    let lastTaskId: string | null = null;
    try {
      const result = createTaskWithin(db, {
        name: row.name,
        capabilityId: row.capability_id,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        deviceIds: JSON.parse(row.device_ids) as string[],
        targets: JSON.parse(row.targets) as TaskSelector[],
        scheduledAt: null,
        ttlMinutes: row.ttl_minutes,
        mode: row.mode,
        batchSize: row.batch_size,
        percent: row.percent,
        failureThresholdPercent: row.failure_threshold,
        maxConcurrency: row.max_concurrency,
        maxAttempts: row.max_attempts,
      }, actor, { auditSource: "schedule", sourceId: row.id });
      if (result.ok) { lastTaskId = result.id; derived += 1; }
      else error = result.message;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    db.prepare(`UPDATE task_schedules
      SET state=?, next_run_at=?, last_run_at=?, last_task_id=?, last_error=?, updated_at=?
      WHERE id=?`)
      .run(nextRunAt ? "active" : "finished", nextRunAt, now, lastTaskId, error, now, row.id);
  }
  return derived;
}

/** 创建/更新共用的调度定义请求体；规则自洽性另由 validateScheduleRule 检查。 */
export const scheduleBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  capabilityId: z.string().min(3).max(100),
  payload: z.record(z.string(), z.unknown()),
  deviceIds: z.array(z.string().uuid()).max(1000).optional().transform((ids) => (ids ? [...new Set(ids)] : ids)),
  targets: z.array(taskSelectorSchema).min(1).max(1000).optional(),
  repeat: z.enum(["daily", "weekly", "monthly", "interval"]),
  timeOfDay: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  intervalMinutes: z.number().int().min(5).max(20160).optional(),
  tzOffsetMinutes: z.number().int().min(-840).max(840).default(480),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().nullable().optional(),
  ttlMinutes: z.number().int().min(1).max(10080).default(60),
  mode: z.enum(["all", "fixed", "percent"]).default("all"),
  batchSize: z.number().int().min(1).max(500).optional(),
  percent: z.number().int().min(1).max(100).optional(),
  failureThresholdPercent: z.number().int().min(0).max(100).default(0),
  maxConcurrency: z.number().int().min(0).max(1000).default(0),
  maxAttempts: z.number().int().min(1).max(5).default(1),
}).refine((value) => (value.deviceIds?.length ?? 0) > 0 || (value.targets?.length ?? 0) > 0, {
  message: "必须提供目标设备或目标选择器。",
}).refine((value) => (value.mode !== "fixed" || !!value.batchSize) && (value.mode !== "percent" || !!value.percent), {
  message: "灰度模式必须提供对应的批次大小或百分比。",
});

export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

/** 请求体 → 计算规则（创建时用 startAt 为锚、无历史执行）。 */
export function ruleFromBody(body: ScheduleBody): ScheduleRule {
  return {
    repeat: body.repeat,
    timeOfDay: body.timeOfDay ?? null,
    weekdays: body.weekdays ?? null,
    dayOfMonth: body.dayOfMonth ?? null,
    intervalMinutes: body.intervalMinutes ?? null,
    tzOffsetMinutes: body.tzOffsetMinutes,
    startAt: body.startAt,
    endAt: body.endAt ?? null,
    lastRunAt: null,
  };
}

/** 首次触发点：不早于 startAt 与当前时间中的较晚者。 */
export function firstNextRunAt(body: ScheduleBody, now: string): string | null {
  const from = Date.parse(body.startAt) > Date.parse(now) ? body.startAt : now;
  return nextOccurrence(ruleFromBody(body), from);
}

/**
 * 资源可见性（调度与触发器共用）：限定组织范围的账号只看到自己创建的定义。
 * 受众随成员关系变化，无法像任务那样按已派生命令反推可见范围，按创建者隔离最稳。
 */
export function scheduleVisibleWhere(user: { id: string; role: string; scopeOrgNodeId?: string | null }): { sql: string; params: unknown[] } {
  return user.scopeOrgNodeId && user.role !== "owner" ? { sql: "created_by=?", params: [user.id] } : { sql: "1=1", params: [] };
}

export { userActor };
