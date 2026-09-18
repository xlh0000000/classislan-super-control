import { z } from "zod";
import { scheduleVisibleWhere } from "../../../utils/auto-tasks";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  state: z.enum(["active", "paused", "finished"]).optional(),
});

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.read");
  const query = querySchema.safeParse(getQuery(event));
  if (!query.success) throw createError({ statusCode: 400, message: "调度查询参数无效。" });
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const where = query.data.state ? `${visible.sql} AND s.state=?` : visible.sql;
  const params = query.data.state ? [...visible.params, query.data.state] : [...visible.params];
  const total = (db.prepare(`SELECT COUNT(*) count FROM task_schedules s WHERE ${where}`).get(...params) as { count: number }).count;
  const offset = (query.data.page - 1) * query.data.pageSize;
  const items = db.prepare(`SELECT s.id,s.name,s.capability_id capabilityId,s.payload,s.targets,s.device_ids deviceIds,
    s.repeat,s.time_of_day timeOfDay,s.weekdays,s.day_of_month dayOfMonth,s.interval_minutes intervalMinutes,
    s.tz_offset_minutes tzOffsetMinutes,s.start_at startAt,s.end_at endAt,s.ttl_minutes ttlMinutes,
    s.mode,s.batch_size batchSize,s.percent,s.failure_threshold failureThreshold,s.max_concurrency maxConcurrency,s.max_attempts maxAttempts,
    s.state,s.next_run_at nextRunAt,s.last_run_at lastRunAt,s.last_task_id lastTaskId,s.last_error lastError,
    s.created_by createdBy,u.display_name createdByName,s.created_at createdAt,s.updated_at updatedAt
    FROM task_schedules s LEFT JOIN users u ON u.id=s.created_by
    WHERE ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(...params, query.data.pageSize, offset) as Record<string, unknown>[];
  const parsed = items.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload as string),
    targets: JSON.parse(row.targets as string),
    deviceIds: JSON.parse(row.deviceIds as string),
    weekdays: row.weekdays ? JSON.parse(row.weekdays as string) : null,
  }));
  return { items: parsed, total, page: query.data.page, pageSize: query.data.pageSize };
});
