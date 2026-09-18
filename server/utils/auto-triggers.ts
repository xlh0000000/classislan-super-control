import type Database from "better-sqlite3";
import { z } from "zod";
import { createTaskWithin, taskSelectorSchema, type TaskSelector } from "./task-create";
import { deviceScopeFilter, visibleOrgNodeIds } from "./scope";
import { userActor } from "./auto-tasks";

/**
 * 事件触发任务引擎。两类触发共用同一张 triggers 表与同一派生路径：
 * - device_offline：调度器每 tick 扫描 last_seen 超时且处于本故障期（未重连）的设备；
 * - crash_threshold：设备上报崩溃入库后当场评估滑动窗口计数。
 * trigger_fires 记录“同一触发对同一设备”的最近派生时刻，实现故障期去重 + 冷却抑制抖动。
 */

export type TriggerRow = {
  id: string;
  name: string;
  kind: "device_offline" | "crash_threshold";
  condition: string;
  scope_type: "school" | "organization";
  scope_id: string | null;
  targets: string;
  capability_id: string;
  payload: string;
  ttl_minutes: number;
  cooldown_minutes: number;
  created_by: string | null;
};

export type OfflineCondition = { offlineMinutes: number };
export type CrashCondition = { count: number; windowMinutes: number };

const triggerCommon = {
  name: z.string().trim().min(1).max(100),
  scopeType: z.enum(["school", "organization"]).default("school"),
  scopeId: z.string().uuid().nullish(),
  // 留空表示动作发给出事设备本身；填写选择器则发给告警目标（如办公室看板）。
  targets: z.array(taskSelectorSchema).max(1000).optional(),
  capabilityId: z.string().min(3).max(100),
  // payload 字符串里可用 {{deviceName}}、{{deviceId}} 及类型专属占位符。
  payload: z.record(z.string(), z.unknown()),
  ttlMinutes: z.number().int().min(1).max(10080).default(60),
  cooldownMinutes: z.number().int().min(1).max(10080).default(60),
};

export const triggerBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device_offline"), offlineMinutes: z.number().int().min(1).max(10080), ...triggerCommon }),
  z.object({ kind: z.literal("crash_threshold"), crashCount: z.number().int().min(1).max(1000), windowMinutes: z.number().int().min(1).max(10080), ...triggerCommon }),
]).refine((value) => value.scopeType !== "organization" || !!value.scopeId, {
  message: "组织范围触发器必须提供 scopeId。",
});

export type TriggerBody = z.infer<typeof triggerBodySchema>;

export function conditionFromBody(body: TriggerBody): OfflineCondition | CrashCondition {
  return body.kind === "device_offline"
    ? { offlineMinutes: body.offlineMinutes }
    : { count: body.crashCount, windowMinutes: body.windowMinutes };
}

/** payload 里允许 {{deviceName}} / {{deviceId}} 及附加变量的占位符替换。 */
function renderPayload(raw: string, vars: Record<string, string | number>): Record<string, unknown> {
  let text = raw;
  for (const [key, value] of Object.entries(vars)) {
    // 字符串值按 JSON 规则转义后再注入，避免设备名里的引号破坏文档结构。
    const encoded = typeof value === "string" ? JSON.stringify(value).slice(1, -1) : String(value);
    text = text.split(`{{${key}}}`).join(encoded);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** 触发器作用域：全校，或指定组织子树（与任务选择器相同的 path 前缀语义）。 */
function scopeClause(trigger: TriggerRow): { sql: string; params: unknown[] } {
  if (trigger.scope_type === "organization" && trigger.scope_id) {
    return {
      sql: `EXISTS (SELECT 1 FROM org_nodes dev JOIN org_nodes root ON root.id=?
        WHERE dev.id=d.org_node_id AND (dev.id=root.id OR dev.path LIKE CASE WHEN root.path='/' THEN '/%' ELSE root.path || '/%' END))`,
      params: [trigger.scope_id],
    };
  }
  return { sql: "1=1", params: [] };
}

/**
 * 派生一次触发任务。trigger_fires 先落账再建任务：派生失败（如设备不支持能力）
 * 也消耗冷却，避免坏配置每 tick 重复报错刷 last_error。
 */
function fireTrigger(
  db: Database.Database,
  trigger: TriggerRow,
  affected: { id: string; name: string }[],
  extraVars: Record<string, string | number>,
  now: string,
): string | null {
  const actor = userActor(db, trigger.created_by);
  if (!actor) {
    db.prepare("UPDATE triggers SET state='paused',last_error=?,updated_at=? WHERE id=?")
      .run("创建者已失效或被禁用，无法代表其派生任务；触发器已暂停。", now, trigger.id);
    return null;
  }
  const insertFire = db.prepare(`INSERT INTO trigger_fires (trigger_id,device_id,fired_at) VALUES (?,?,?)
    ON CONFLICT(trigger_id,device_id) DO UPDATE SET fired_at=excluded.fired_at`);
  for (const device of affected) insertFire.run(trigger.id, device.id, now);
  const vars: Record<string, string | number> = {
    deviceName: affected.map((device) => device.name).join("、"),
    deviceId: affected.map((device) => device.id).join(","),
    ...extraVars,
  };
  const selectors = JSON.parse(trigger.targets) as TaskSelector[];
  const result = createTaskWithin(db, {
    name: `${trigger.name} · ${vars.deviceName}`.slice(0, 100),
    capabilityId: trigger.capability_id,
    payload: renderPayload(trigger.payload, vars),
    deviceIds: selectors.length ? null : affected.map((device) => device.id),
    targets: selectors.length ? selectors : null,
    scheduledAt: null,
    ttlMinutes: trigger.ttl_minutes,
    mode: "all",
    failureThresholdPercent: 0,
    maxConcurrency: 0,
    maxAttempts: 1,
  }, actor, { auditSource: "trigger", sourceId: trigger.id });
  db.prepare("UPDATE triggers SET last_fired_at=?,last_task_id=?,last_error=?,updated_at=? WHERE id=?")
    .run(now, result.ok ? result.id : null, result.ok ? null : result.message, now, trigger.id);
  return result.ok ? result.id : null;
}

/**
 * fireTrigger 的容错包装：payload 模板损坏等配置错误只记 last_error，
 * 绝不能把异常抛回设备 poll 或调度器事务，连累正常链路。
 */
function tryFire(
  db: Database.Database,
  trigger: TriggerRow,
  affected: { id: string; name: string }[],
  extraVars: Record<string, string | number>,
  now: string,
): string | null {
  try {
    return fireTrigger(db, trigger, affected, extraVars, now);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    db.prepare("UPDATE triggers SET last_error=?,updated_at=? WHERE id=?").run(message, now, trigger.id);
    return null;
  }
}

/**
 * device_offline 扫描（调度器 tick 内调用）。某设备可再次触发的条件：
 * 上次派生之后设备重连过（last_seen 晚于 fired_at），且已过了冷却期。
 */
export function advanceTriggers(db: Database.Database, at?: string): number {
  const now = at ?? new Date().toISOString();
  const triggers = db.prepare(`SELECT * FROM triggers WHERE state='active' AND kind='device_offline'`).all() as TriggerRow[];
  let fired = 0;
  for (const trigger of triggers) {
    const condition = JSON.parse(trigger.condition) as OfflineCondition;
    const actor = userActor(db, trigger.created_by);
    if (!actor) {
      db.prepare("UPDATE triggers SET state='paused',last_error=?,updated_at=? WHERE id=?")
        .run("创建者已失效或被禁用；触发器已暂停。", now, trigger.id);
      continue;
    }
    const scope = deviceScopeFilter(db, actor);
    const triggerScope = scopeClause(trigger);
    const cutoff = new Date(Date.parse(now) - Math.max(1, condition.offlineMinutes) * 60_000).toISOString();
    const cooldownStart = new Date(Date.parse(now) - Math.max(0, trigger.cooldown_minutes) * 60_000).toISOString();
    const devices = db.prepare(`SELECT d.id,d.name FROM devices d
      WHERE d.disabled_at IS NULL AND d.last_seen_at IS NOT NULL AND d.last_seen_at<?
        AND ${scope.sql} AND ${triggerScope.sql}
        AND NOT EXISTS (SELECT 1 FROM trigger_fires tf WHERE tf.trigger_id=? AND tf.device_id=d.id
          AND (tf.fired_at>=d.last_seen_at OR tf.fired_at>?))`).all(
      cutoff, ...scope.params, ...triggerScope.params, trigger.id, cooldownStart) as { id: string; name: string }[];
    if (!devices.length) continue;
    if (tryFire(db, trigger, devices, { offlineMinutes: condition.offlineMinutes }, now)) fired += 1;
  }
  return fired;
}

/**
 * crash_threshold 评估（崩溃入库后的 poll 事务内调用，只评估上报设备自身）。
 * 与离线扫描的区别：窗口计数当场判定，冷却仅看上次派生时刻。
 */
export function evaluateCrashTriggers(db: Database.Database, deviceId: string, at?: string): number {
  const now = at ?? new Date().toISOString();
  const device = db.prepare("SELECT d.id,d.name,d.org_node_id orgNodeId FROM devices d WHERE d.id=? AND d.disabled_at IS NULL AND d.last_seen_at IS NOT NULL")
    .get(deviceId) as { id: string; name: string; orgNodeId: string | null } | undefined;
  if (!device) return 0;
  const triggers = db.prepare(`SELECT t.* FROM triggers t
    WHERE t.state='active' AND t.kind='crash_threshold'
      AND (t.scope_type='school' OR (t.scope_type='organization' AND EXISTS (
        SELECT 1 FROM org_nodes dev JOIN org_nodes root ON root.id=t.scope_id
        WHERE dev.id=? AND (dev.id=root.id OR dev.path LIKE CASE WHEN root.path='/' THEN '/%' ELSE root.path || '/%' END))))`)
    .all(device.orgNodeId ?? "") as TriggerRow[];
  let fired = 0;
  for (const trigger of triggers) {
    const condition = JSON.parse(trigger.condition) as CrashCondition;
    const actor = userActor(db, trigger.created_by);
    if (!actor) continue;
    // 创建者看不见该设备时不派生：宁可漏报，也不越权操作他人范围内的设备。
    const visibleIds = visibleOrgNodeIds(db, actor);
    if (visibleIds && (!device.orgNodeId || !visibleIds.includes(device.orgNodeId))) continue;
    const windowStart = new Date(Date.parse(now) - Math.max(1, condition.windowMinutes) * 60_000).toISOString();
    const count = (db.prepare("SELECT COUNT(*) count FROM crash_reports WHERE device_id=? AND occurred_at>=?")
      .get(deviceId, windowStart) as { count: number }).count;
    if (count < Math.max(1, condition.count)) continue;
    const lastFire = (db.prepare("SELECT MAX(fired_at) firedAt FROM trigger_fires WHERE trigger_id=? AND device_id=?")
      .get(trigger.id, deviceId) as { firedAt: string | null }).firedAt;
    const cooldownStart = new Date(Date.parse(now) - Math.max(0, trigger.cooldown_minutes) * 60_000).toISOString();
    if (lastFire && lastFire > cooldownStart) continue;
    if (tryFire(db, trigger, [device], { crashCount: count, windowMinutes: condition.windowMinutes }, now)) fired += 1;
  }
  return fired;
}
