import { randomUUID } from "node:crypto";
import { appendAuditWithin } from "../../../utils/security";
import { validateScheduleRule } from "../../../utils/schedule-rules";
import { firstNextRunAt, ruleFromBody, scheduleBodySchema } from "../../../utils/auto-tasks";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = scheduleBodySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "调度定义无效。" });
  const ruleError = validateScheduleRule(ruleFromBody(input.data));
  if (ruleError) throw createError({ statusCode: 400, message: ruleError });
  const now = new Date().toISOString();
  const nextRunAt = firstNextRunAt(input.data, now);
  if (!nextRunAt) throw createError({ statusCode: 400, message: "按当前时间计算，该规则此后没有触发点，请调整规则。" });
  const id = randomUUID();
  const db = useDatabase();
  db.transaction(() => {
    db.prepare(`INSERT INTO task_schedules
      (id,name,capability_id,payload,targets,device_ids,repeat,time_of_day,weekdays,day_of_month,interval_minutes,
       tz_offset_minutes,start_at,end_at,ttl_minutes,mode,batch_size,percent,failure_threshold,max_concurrency,max_attempts,
       state,next_run_at,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?,?)`)
      .run(id, input.data.name, input.data.capabilityId, JSON.stringify(input.data.payload),
        JSON.stringify(input.data.targets ?? []), JSON.stringify(input.data.deviceIds ?? []),
        input.data.repeat, input.data.timeOfDay ?? null,
        input.data.weekdays ? JSON.stringify(input.data.weekdays) : null,
        input.data.dayOfMonth ?? null, input.data.intervalMinutes ?? null,
        input.data.tzOffsetMinutes, input.data.startAt, input.data.endAt ?? null,
        input.data.ttlMinutes, input.data.mode, input.data.batchSize ?? null, input.data.percent ?? null,
        input.data.failureThresholdPercent, input.data.maxConcurrency, input.data.maxAttempts,
        nextRunAt, user.id, now, now);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "schedule.create", targetType: "schedule", targetId: id,
      summary: `创建周期调度 ${input.data.name}`,
      details: { repeat: input.data.repeat, capabilityId: input.data.capabilityId, nextRunAt },
    });
  })();
  return { id, nextRunAt };
});
