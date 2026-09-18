import { z } from "zod";
import { appendAuditWithin } from "../../../../../utils/security";
import { nextOccurrence } from "../../../../../utils/schedule-rules";
import { scheduleRuleOf, scheduleVisibleWhere, type ScheduleRow } from "../../../../../utils/auto-tasks";

const actionSchema = z.object({ action: z.enum(["pause", "resume", "run"]) });

/**
 * 调度操作：pause 冻结派生（保留 next_run_at 供展示但不会被推进器命中）；
 * resume 按恢复时刻重算下次触发（错过窗口只补算未来，不追溯历史）；
 * run 把下次触发挪到现在，由推进器在下一个 tick 立即派生。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = actionSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "调度操作无效。" });
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const row = db.prepare(`SELECT * FROM task_schedules s WHERE s.id=? AND ${visible.sql}`).get(id, ...visible.params) as
    (Record<string, unknown> & { state: string; name: string }) | undefined;
  if (!row) throw createError({ statusCode: 404, message: "调度不存在。" });
  const now = new Date().toISOString();
  let next: { state: string; nextRunAt: string | null };
  switch (input.data.action) {
    case "pause":
      if (row.state !== "active") throw createError({ statusCode: 409, message: `调度当前状态 ${row.state} 不允许暂停。` });
      next = { state: "paused", nextRunAt: (row.next_run_at as string | null) ?? null };
      break;
    case "resume": {
      if (row.state !== "paused") throw createError({ statusCode: 409, message: `调度当前状态 ${row.state} 不允许恢复。` });
      const nextRunAt = nextOccurrence(scheduleRuleOf(row as unknown as ScheduleRow, (row.last_run_at as string | null) ?? null), now);
      if (!nextRunAt) throw createError({ statusCode: 409, message: "该规则此后没有触发点，无法恢复。" });
      next = { state: "active", nextRunAt };
      break;
    }
    case "run":
      if (row.state !== "active") throw createError({ statusCode: 409, message: `调度当前状态 ${row.state} 不允许立即执行。` });
      next = { state: "active", nextRunAt: now };
      break;
  }
  db.transaction(() => {
    db.prepare("UPDATE task_schedules SET state=?,next_run_at=?,updated_at=? WHERE id=? AND state=?")
      .run(next.state, next.nextRunAt, now, id, row.state);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: `schedule.${input.data.action}`, targetType: "schedule", targetId: id,
      summary: `${input.data.action} 调度 ${row.name}`,
      details: { from: row.state, to: next.state, nextRunAt: next.nextRunAt },
    });
  })();
  return { id, state: next.state, nextRunAt: next.nextRunAt };
});
