import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { appendAuditWithin } from "./security";

export type CommandRow = {
  id: string;
  task_id: string;
  device_id: string;
  capability_id: string;
  payload: string;
  not_before: string;
  expires_at: string;
  state: string;
  attempt_count: number;
  offered_at: string | null;
  acknowledged_at: string | null;
  result: string | null;
  created_at: string;
  lease_until: string | null;
  next_attempt_at: string | null;
  max_attempts: number;
  last_error: string | null;
};

export type TaskRow = {
  id: string;
  name: string;
  capability_id: string;
  state: string;
  payload: string;
  scheduled_at: string | null;
  expires_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  mode: string;
  batch_size: number | null;
  percent: number | null;
  failure_threshold: number;
  max_concurrency: number;
  cancel_requested: number;
  last_error: string | null;
  idempotency_key: string | null;
  target_snapshot: string;
};

const ACTIVE_COMMAND_STATES = ["pending", "offered", "received", "running", "cancelling"];
/** 已被设备领取、可能已在执行中的状态：取消这类命令必须等设备确认或超时。 */
const DELIVERED_COMMAND_STATES = ["offered", "received", "running"];
const TERMINAL_FAILED = ["failed", "conflict", "unsupported"];
const TERMINAL_COMMAND_STATES = ["succeeded", "failed", "conflict", "unsupported", "expired", "cancelled"];
/** 暂停语义：暂停中的任务冻结 TTL，不推进过期/回收/重试，恢复时按暂停时长整体平移截止时间。 */
const NOT_PAUSED = "task_id NOT IN (SELECT id FROM tasks WHERE state='paused')";

function countCommands(db: Database.Database, taskId: string, states: string[]): number {
  const placeholders = states.map(() => "?").join(",");
  return (db.prepare(`SELECT COUNT(*) count FROM commands WHERE task_id=? AND state IN (${placeholders})`).get(taskId, ...states) as { count: number }).count;
}
function nowIso() {
  return new Date().toISOString();
}

export function batchSizes(total: number, mode: string, batchSize: number | null, percent: number | null): number[] {
  if (mode === "all" || total === 0) return [total];
  if (mode === "percent") {
    const per = Math.max(1, Math.ceil((total * (percent ?? 10)) / 100));
    const sizes: number[] = [];
    let remaining = total;
    while (remaining > 0) { sizes.push(Math.min(per, remaining)); remaining -= per; }
    return sizes;
  }
  const per = Math.max(1, batchSize ?? 50);
  const sizes: number[] = [];
  let remaining = total;
  while (remaining > 0) { sizes.push(Math.min(per, remaining)); remaining -= per; }
  return sizes;
}

/** 在单个事务内推进所有任务状态。poll 与调度器共用。 */
type BatchRow = { id: string; state: string; device_ids: string; batch_index: number };

/**
 * 任务状态推进器。poll、调度器、ACK、管理员操作共用，必须在事务内调用。
 * 处理顺序：定时启动 → 取消传播 → 冻结语义下的过期/回收/重试 → 失败阈值 → 批次收敛与放量 → 父任务聚合。
 */
export function advanceTaskState(db: Database.Database, at?: string): void {
  const now = at ?? nowIso();

  // 1. 到点启动定时任务；已请求取消的任务不再启动。
  db.prepare(`UPDATE tasks SET state='running',updated_at=? WHERE state='scheduled' AND cancel_requested=0 AND scheduled_at IS NOT NULL AND scheduled_at<=?`).run(now, now);

  // 2. 取消传播：未投递命令可直接终态；已投递命令进入 cancelling，等设备确认或超时。
  db.prepare(`UPDATE commands SET state='cancelled',acknowledged_at=COALESCE(acknowledged_at,?)
    WHERE state='pending' AND task_id IN (SELECT id FROM tasks WHERE cancel_requested=1)`).run(now);
  db.prepare(`UPDATE commands SET state='cancelling'
    WHERE state IN ('offered','received','running') AND task_id IN (SELECT id FROM tasks WHERE cancel_requested=1)`).run();

  // 3. cancelling 超时（命令过期或租约失效）后落取消终态，而不是被误判为 expired。
  db.prepare(`UPDATE commands SET state='cancelled',acknowledged_at=COALESCE(acknowledged_at,?)
    WHERE state='cancelling' AND (expires_at<=? OR (lease_until IS NOT NULL AND lease_until<=?))`).run(now, now, now);

  // 4. 到期命令落 expired（暂停中的任务冻结 TTL，不在此推进）。
  db.prepare(`UPDATE commands SET state='expired',acknowledged_at=?
    WHERE expires_at<=? AND state IN ('pending','offered','received','running') AND ${NOT_PAUSED}`).run(now, now);

  // 5. 租约过期回收：offered -> pending。已取消/暂停中的任务不回收。
  db.prepare(`UPDATE commands SET state='pending',lease_until=NULL
    WHERE state='offered' AND lease_until IS NOT NULL AND lease_until<=? AND ${NOT_PAUSED}
      AND task_id IN (SELECT id FROM tasks WHERE cancel_requested=0)`).run(now);

  // 6. 执行级重试：到达退避时间的 failed -> pending。已取消/暂停中的任务不重试。
  db.prepare(`UPDATE commands SET state='pending',next_attempt_at=NULL
    WHERE state='failed' AND attempt_count<max_attempts AND next_attempt_at IS NOT NULL AND next_attempt_at<=?
      AND ${NOT_PAUSED} AND task_id IN (SELECT id FROM tasks WHERE cancel_requested=0)`).run(now);

  // 7. 失败阈值：已终态命令中失败占比达到阈值则取消剩余（未投递直接取消，已投递转 cancelling）。
  const thresholdTasks = db.prepare("SELECT * FROM tasks WHERE state='running' AND cancel_requested=0").all() as TaskRow[];
  for (const task of thresholdTasks) {
    if (task.failure_threshold <= 0) continue;
    const stats = db.prepare(`SELECT
      SUM(CASE WHEN state IN ('succeeded','failed','conflict','unsupported','expired','cancelled') THEN 1 ELSE 0 END) terminal,
      SUM(CASE WHEN state IN ('failed','conflict','unsupported') THEN 1 ELSE 0 END) failed
      FROM commands WHERE task_id=?`).get(task.id) as { terminal: number | null; failed: number | null };
    if ((stats.terminal ?? 0) > 0 && (stats.failed ?? 0) * 100 >= task.failure_threshold * (stats.terminal ?? 1)) {
      db.prepare("UPDATE tasks SET cancel_requested=1,last_error=?,updated_at=? WHERE id=?").run(`失败比例达到阈值 ${task.failure_threshold}%`, now, task.id);
      db.prepare("UPDATE commands SET state='cancelled',acknowledged_at=COALESCE(acknowledged_at,?) WHERE task_id=? AND state='pending'").run(now, task.id);
      db.prepare("UPDATE commands SET state='cancelling' WHERE task_id=? AND state IN ('offered','received','running')").run(task.id);
      db.prepare("UPDATE task_batches SET state='cancelled',updated_at=? WHERE task_id=? AND state='pending'").run(now, task.id);
    }
  }

  // 8. 批次收敛与放量：先收敛活动批次，再决定是否激活下一个 pending 批次。
  const batchTasks = db.prepare("SELECT * FROM tasks WHERE state IN ('running','cancelling')").all() as TaskRow[];
  for (const task of batchTasks) {
    const active = db.prepare("SELECT * FROM task_batches WHERE task_id=? AND state='active'").get(task.id) as BatchRow | undefined;
    if (active && countCommands(db, task.id, ACTIVE_COMMAND_STATES) === 0) {
      const failed = countCommands(db, task.id, ["failed", "conflict", "unsupported", "expired"]);
      db.prepare("UPDATE task_batches SET state=?,updated_at=? WHERE id=?").run(failed > 0 ? "failed" : "succeeded", now, active.id);
      // 批次失败即停止放量，避免把已知损坏的变更继续扩散。
      if (failed > 0)
        db.prepare("UPDATE task_batches SET state='cancelled',updated_at=? WHERE task_id=? AND state='pending'").run(now, task.id);
    }
    if (task.state !== "running" || task.cancel_requested === 1) continue;
    const batches = db.prepare("SELECT * FROM task_batches WHERE task_id=? ORDER BY batch_index").all(task.id) as BatchRow[];
    if (batches.some((batch) => batch.state === "active")) continue;
    const next = batches.find((batch) => batch.state === "pending");
    if (!next) continue;
    if (batches.some((batch) => batch.batch_index < next.batch_index && batch.state !== "succeeded")) continue;
    db.prepare("UPDATE task_batches SET state='active',updated_at=? WHERE id=?").run(now, next.id);
    const insertCommand = db.prepare(`INSERT INTO commands
      (id,task_id,device_id,capability_id,payload,not_before,expires_at,state,max_attempts,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const deviceId of JSON.parse(next.device_ids) as string[])
      insertCommand.run(randomUUID(), task.id, deviceId, task.capability_id, task.payload, task.scheduled_at ?? now, task.expires_at, "pending", task.mode === "all" ? 1 : 2, now);
  }

  // 9. 父任务聚合：所有命令终态且无待放量批次后，落 completed/failed/partial_failure/expired/cancelled。
  const aggregateTargets = db.prepare("SELECT * FROM tasks WHERE state IN ('running','cancelling')").all() as TaskRow[];
  for (const task of aggregateTargets) {
    const stats = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) succeeded,
      SUM(CASE WHEN state IN ('failed','conflict','unsupported') THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN state='expired' THEN 1 ELSE 0 END) expired,
      SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END) cancelled,
      SUM(CASE WHEN state IN ('pending','offered','received','running','cancelling') THEN 1 ELSE 0 END) active
      FROM commands WHERE task_id=?`).get(task.id) as { total: number; succeeded: number | null; failed: number | null; expired: number | null; cancelled: number | null; active: number | null };
    if (stats.total === 0) continue; // 尚未创建任何命令（等待批次激活或已取消）
    if ((stats.active ?? 0) > 0) continue;
    const pendingBatches = (db.prepare("SELECT COUNT(*) count FROM task_batches WHERE task_id=? AND state IN ('pending','active')").get(task.id) as { count: number }).count;
    if (pendingBatches > 0) continue;
    const succeeded = stats.succeeded ?? 0;
    const failed = stats.failed ?? 0;
    const expired = stats.expired ?? 0;
    const cancelled = stats.cancelled ?? 0;
    let next: string;
    if (succeeded === stats.total) next = "completed";
    else if (succeeded > 0 && (failed > 0 || expired > 0 || cancelled > 0)) next = "partial_failure";
    else if (failed > 0) next = "failed";
    else if (expired > 0) next = "expired";
    else if (cancelled === stats.total) next = "cancelled";
    else next = "completed";
    if (task.cancel_requested === 1 && succeeded === 0 && failed === 0 && expired === 0) next = "cancelled";
    const terminal = db.prepare("UPDATE tasks SET state=?,updated_at=? WHERE id=? AND state IN ('running','cancelling')").run(next, now, task.id);
    // 任务收敛为终态时形成审计事件，补全“只改命令、不聚合任务”的历史缺口。
    if (terminal.changes === 1)
      appendAuditWithin(db, {
        actorType: "system", action: `task.${next}`, targetType: "task", targetId: task.id,
        summary: `任务「${task.name}」收敛为 ${next}`,
        details: { from: task.state, to: next, total: stats.total ?? 0, succeeded, failed, expired, cancelled },
      });
  }
}

/**
 * 设备轮询时领取命令。默认在同一调用内先推进状态；poll 路径会传入 advance=false，
 * 以便把“推进 + ACK + 领取”合并进一个 BEGIN IMMEDIATE 事务，消除取消→offered 竞态。
 */
export function claimCommandsForDevice(db: Database.Database, deviceId: string, limit = 20, at?: string, options: { advance?: boolean } = {}): CommandRow[] {
  const now = at ?? nowIso();
  if (options.advance !== false) advanceTaskState(db, now);
  const task = db.prepare(`SELECT t.id,t.max_concurrency,t.mode,t.cancel_requested
    FROM commands c JOIN tasks t ON t.id=c.task_id
    WHERE c.device_id=? AND c.state='pending' AND c.not_before<=? AND c.expires_at>?
    AND t.state='running' AND t.cancel_requested=0 LIMIT 1`).get(deviceId, now, now) as { id: string; max_concurrency: number; mode: string; cancel_requested: number } | undefined;
  if (!task) return [];
  const capacity = task.max_concurrency > 0
    ? task.max_concurrency - ((db.prepare(`SELECT COUNT(*) count FROM commands WHERE task_id=? AND state IN ('offered','received','running')`).get(task.id) as { count: number }).count)
    : limit;
  if (capacity <= 0) return [];
  const claimLimit = Math.min(limit, capacity);
  const candidates = db.prepare(`SELECT id FROM commands
    WHERE device_id=? AND task_id=? AND state='pending' AND not_before<=? AND expires_at>? AND next_attempt_at IS NULL
    ORDER BY created_at LIMIT ?`).all(deviceId, task.id, now, now, claimLimit) as { id: string }[];
  if (!candidates.length) return [];
  // 条件更新：即使脱离显式事务，也保证取消后的命令不会被重新标记为 offered。
  const markOffered = db.prepare(`UPDATE commands SET state='offered',offered_at=?,lease_until=?,attempt_count=attempt_count+1
    WHERE id=? AND state='pending'
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=commands.task_id AND t.state='running' AND t.cancel_requested=0)`);
  const leaseUntil = new Date(Date.parse(now) + 5 * 60_000).toISOString();
  const claimed: string[] = [];
  for (const candidate of candidates) {
    if (markOffered.run(now, leaseUntil, candidate.id).changes === 1) claimed.push(candidate.id);
  }
  if (!claimed.length) return [];
  const placeholders = claimed.map(() => "?").join(",");
  return db.prepare(`SELECT id,capability_id,payload,not_before,expires_at,max_attempts FROM commands
    WHERE id IN (${placeholders}) AND state='offered'`).all(...claimed) as CommandRow[];
}
/**
 * 恢复暂停任务时按暂停时长平移截止时间，兑现“暂停冻结 TTL”的语义。
 * 只平移未终态命令与任务自身的 expires_at，避免暂停期间命令静默过期。
 */
export function shiftTaskDeadlines(db: Database.Database, taskId: string, deltaMs: number, at?: string): void {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
  const shift = (value: string | null) => (value == null ? null : new Date(Date.parse(value) + deltaMs).toISOString());
  const rows = db.prepare(`SELECT id,not_before,expires_at,next_attempt_at,lease_until FROM commands
    WHERE task_id=? AND state IN ('pending','offered','received','running','cancelling','failed')`).all(taskId) as
    { id: string; not_before: string; expires_at: string; next_attempt_at: string | null; lease_until: string | null }[];
  const update = db.prepare("UPDATE commands SET not_before=?,expires_at=?,next_attempt_at=?,lease_until=? WHERE id=?");
  for (const row of rows)
    update.run(shift(row.not_before), shift(row.expires_at), shift(row.next_attempt_at), shift(row.lease_until), row.id);
  const task = db.prepare("SELECT expires_at FROM tasks WHERE id=?").get(taskId) as { expires_at: string } | undefined;
  if (task) db.prepare("UPDATE tasks SET expires_at=?,updated_at=? WHERE id=?").run(shift(task.expires_at), at ?? nowIso(), taskId);
}

export const activeCommandStates = ACTIVE_COMMAND_STATES;
export const deliveredCommandStates = DELIVERED_COMMAND_STATES;
export const terminalFailedStates = TERMINAL_FAILED;
export const terminalCommandStates = TERMINAL_COMMAND_STATES;

export type IdempotentTaskRecord = { id: string; state: string; requestHash: string | null };

export type IdempotencyOutcome =
  | { kind: "none" }
  | { kind: "replay"; task: IdempotentTaskRecord }
  | { kind: "conflict" };

/** 按调用者 + 幂等键查询既有任务；键按用户隔离，避免跨账号撞键命中他人任务。 */
export function findIdempotentTask(db: Database.Database, actorId: string, key: string): IdempotentTaskRecord | undefined {
  return db.prepare("SELECT id,state,idempotency_request_hash requestHash FROM tasks WHERE idempotency_actor_id=? AND idempotency_key=?")
    .get(actorId, key) as IdempotentTaskRecord | undefined;
}

/**
 * 判定幂等键命中后的动作：同键同摘要回放原任务，同键不同摘要显式冲突。
 * 历史行没有摘要（NULL）时按回放处理，保持旧数据兼容。
 */
export function evaluateIdempotency(existing: IdempotentTaskRecord | undefined, requestHash: string): IdempotencyOutcome {
  if (!existing) return { kind: "none" };
  if (existing.requestHash && existing.requestHash !== requestHash) return { kind: "conflict" };
  return { kind: "replay", task: existing };
}

/** 判断错误是否为唯一约束冲突（并发创建同一幂等键时由数据库兜底）。 */
export function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}