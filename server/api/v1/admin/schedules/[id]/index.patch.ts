import { appendAuditWithin } from "../../../../../utils/security";
import { validateScheduleRule } from "../../../../../utils/schedule-rules";
import { firstNextRunAt, ruleFromBody, scheduleBodySchema, scheduleVisibleWhere } from "../../../../../utils/auto-tasks";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = scheduleBodySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "调度定义无效。" });
  const ruleError = validateScheduleRule(ruleFromBody(input.data));
  if (ruleError) throw createError({ statusCode: 400, message: ruleError });
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const row = db.prepare(`SELECT state FROM task_schedules s WHERE s.id=? AND ${visible.sql}`).get(id, ...visible.params) as { state: string } | undefined;
  if (!row) throw createError({ statusCode: 404, message: "调度不存在。" });
  if (row.state === "finished") throw createError({ statusCode: 409, message: "已结束的调度不允许修改。" });
  const now = new Date().toISOString();
  // 暂停中的调度不抢先算下次触发：恢复时会按恢复时刻重算。
  const nextRunAt = row.state === "active" ? firstNextRunAt(input.data, now) : null;
  if (row.state === "active" && !nextRunAt)
    throw createError({ statusCode: 400, message: "按当前时间计算，该规则此后没有触发点，请调整规则。" });
  db.transaction(() => {
    db.prepare(`UPDATE task_schedules SET
      name=?,capability_id=?,payload=?,targets=?,device_ids=?,repeat=?,time_of_day=?,weekdays=?,day_of_month=?,interval_minutes=?,
      tz_offset_minutes=?,start_at=?,end_at=?,ttl_minutes=?,mode=?,batch_size=?,percent=?,failure_threshold=?,max_concurrency=?,max_attempts=?,
      next_run_at=COALESCE(?,next_run_at),last_error=NULL,updated_at=? WHERE id=?`)
      .run(input.data.name, input.data.capabilityId, JSON.stringify(input.data.payload),
        JSON.stringify(input.data.targets ?? []), JSON.stringify(input.data.deviceIds ?? []),
        input.data.repeat, input.data.timeOfDay ?? null,
        input.data.weekdays ? JSON.stringify(input.data.weekdays) : null,
        input.data.dayOfMonth ?? null, input.data.intervalMinutes ?? null,
        input.data.tzOffsetMinutes, input.data.startAt, input.data.endAt ?? null,
        input.data.ttlMinutes, input.data.mode, input.data.batchSize ?? null, input.data.percent ?? null,
        input.data.failureThresholdPercent, input.data.maxConcurrency, input.data.maxAttempts,
        nextRunAt, now, id);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "schedule.update", targetType: "schedule", targetId: id,
      summary: `修改周期调度 ${input.data.name}`,
      details: { repeat: input.data.repeat, capabilityId: input.data.capabilityId },
    });
  })();
  return { id, state: row.state, nextRunAt };
});
