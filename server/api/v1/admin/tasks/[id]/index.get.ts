import { z } from "zod";
import { deviceScopeFilter } from "../../../../../utils/scope";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  state: z.string().max(32).optional(),
});

/**
 * 任务详情：稳定聚合计数、批次进度、逐目标阶段/尝试/结果与审计时间线。
 * 逐目标列表分页，避免 1000 目标任务把响应撑爆。
 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.read");
  const id = getRouterParam(event, "id")!;
  const query = querySchema.safeParse(getQuery(event));
  if (!query.success) throw createError({ statusCode: 400, message: "任务查询参数无效。" });
  const db = useDatabase();
  const scope = deviceScopeFilter(db, user);
  const taskFilter = scope.sql === "1=1" ? "1=1" : `EXISTS (SELECT 1 FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.task_id=t.id AND ${scope.sql})`;
  const task = db.prepare(`SELECT t.id,t.name,t.capability_id capabilityId,t.state,t.payload,t.scheduled_at scheduledAt,
    t.expires_at expiresAt,t.created_by createdBy,t.created_at createdAt,t.updated_at updatedAt,t.mode,t.batch_size batchSize,
    t.percent,t.failure_threshold failureThreshold,t.max_concurrency maxConcurrency,t.cancel_requested cancelRequested,
    t.last_error lastError,t.idempotency_key idempotencyKey,t.target_snapshot targetSnapshot,t.paused_at pausedAt
    FROM tasks t WHERE t.id=? AND ${taskFilter}`).get(id, ...scope.params) as Record<string, unknown> | undefined;
  if (!task) throw createError({ statusCode: 404, message: "任务不存在。" });

  const stats = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN c.state='succeeded' THEN 1 ELSE 0 END) succeeded,
    SUM(CASE WHEN c.state IN ('failed','conflict','unsupported') THEN 1 ELSE 0 END) failed,
    SUM(CASE WHEN c.state='expired' THEN 1 ELSE 0 END) expired,
    SUM(CASE WHEN c.state='cancelled' THEN 1 ELSE 0 END) cancelled,
    SUM(CASE WHEN c.state='cancelling' THEN 1 ELSE 0 END) cancelling,
    SUM(CASE WHEN c.state IN ('pending','offered','received','running','cancelling') THEN 1 ELSE 0 END) active
    FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.task_id=? AND ${scope.sql}`).get(id, ...scope.params) as Record<string, number | null>;

  const batches = db.prepare(`SELECT id,batch_index batchIndex,state,device_ids deviceIds,created_at createdAt,updated_at updatedAt
    FROM task_batches WHERE task_id=? ORDER BY batch_index`).all(id) as { deviceIds: string }[];
  for (const batch of batches) {
    const parsed = JSON.parse(batch.deviceIds) as string[];
    Object.assign(batch, { deviceCount: parsed.length, deviceIds: parsed });
  }

  const where = ["c.task_id=?", scope.sql];
  const params: unknown[] = [id, ...scope.params];
  if (query.data.state) { where.push("c.state=?"); params.push(query.data.state); }
  const whereSql = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) count FROM commands c JOIN devices d ON d.id=c.device_id WHERE ${whereSql}`).get(...params) as { count: number }).count;
  const offset = (query.data.page - 1) * query.data.pageSize;
  const commands = db.prepare(`SELECT c.id,c.device_id deviceId,d.name deviceName,d.org_node_id orgNodeId,c.capability_id capabilityId,
    c.state,c.attempt_count attemptCount,c.max_attempts maxAttempts,c.offered_at offeredAt,c.acknowledged_at acknowledgedAt,
    c.created_at createdAt,c.expires_at expiresAt,c.next_attempt_at nextAttemptAt,c.last_error lastError,c.result
    FROM commands c JOIN devices d ON d.id=c.device_id WHERE ${whereSql}
    ORDER BY c.created_at LIMIT ? OFFSET ?`).all(...params, query.data.pageSize, offset) as Record<string, unknown>[];
  for (const command of commands) {
    if (typeof command.result === "string") {
      try { command.result = JSON.parse(command.result); } catch { /* 保留原始文本 */ }
    }
  }

  const timeline = db.prepare(`SELECT sequence,action,actor_type actorType,actor_id actorId,summary,details,created_at createdAt
    FROM audit_events WHERE (target_type='task' AND target_id=?)
      OR (target_type='command' AND target_id IN (SELECT id FROM commands WHERE task_id=?))
    ORDER BY sequence DESC LIMIT 100`).all(id, id) as Record<string, unknown>[];
  for (const entry of timeline) {
    if (typeof entry.details === "string") {
      try { entry.details = JSON.parse(entry.details); } catch { /* 保留原始文本 */ }
    }
  }

  if (typeof task.payload === "string") {
    try { task.payload = JSON.parse(task.payload); } catch { /* 保留原始文本 */ }
  }
  if (typeof task.targetSnapshot === "string") {
    try { task.targetSnapshot = JSON.parse(task.targetSnapshot); } catch { /* 保留原始文本 */ }
  }

  return {
    task,
    stats: {
      total: stats.total ?? 0, succeeded: stats.succeeded ?? 0, failed: stats.failed ?? 0,
      expired: stats.expired ?? 0, cancelled: stats.cancelled ?? 0, cancelling: stats.cancelling ?? 0, active: stats.active ?? 0,
    },
    batches,
    commands: { items: commands, total, page: query.data.page, pageSize: query.data.pageSize },
    timeline,
  };
});