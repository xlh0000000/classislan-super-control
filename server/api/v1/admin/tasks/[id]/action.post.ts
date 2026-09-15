import { z } from "zod";
import { appendAuditWithin } from "../../../../../utils/security";
import { deviceScopeFilter } from "../../../../../utils/scope";
import { advanceTaskState, shiftTaskDeadlines } from "../../../../../utils/tasks";

const actionSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) });

/** 合法任务状态转换表；推进器与管理员操作共享同一语义。 */
const taskTransitions = {
  pause: { from: ["scheduled", "running"], to: "paused" },
  resume: { from: ["paused"], to: "running" },
  cancel: { from: ["scheduled", "running", "paused", "cancelling"], to: "cancelled" },
} as const;

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = actionSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "任务操作无效。" });
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const scope = deviceScopeFilter(db, user);
  const taskFilter = scope.sql === "1=1" ? "1=1" : `EXISTS (SELECT 1 FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.task_id=t.id AND ${scope.sql})`;
  const task = db.prepare(`SELECT t.state,t.paused_at pausedAt FROM tasks t WHERE t.id=? AND ${taskFilter}`).get(id, ...scope.params) as { state: string; pausedAt: string | null } | undefined;
  if (!task) throw createError({ statusCode: 404, message: "任务不存在。" });
  const transition = taskTransitions[input.data.action];
  const allowedFrom: readonly string[] = transition.from;
  if (!allowedFrom.includes(task.state))
    throw createError({ statusCode: 409, message: `任务当前状态 ${task.state} 不允许执行 ${input.data.action}。` });
  const changedAt = nowIso();
  const fromPlaceholders = transition.from.map(() => "?").join(",");
  const result = db.transaction(() => {
    let target: string = transition.to;
    if (input.data.action === "cancel") {
      const delivered = (db.prepare("SELECT COUNT(*) count FROM commands WHERE task_id=? AND state IN ('offered','received','running')").get(id) as { count: number }).count;
      // 未投递命令可直接取消；已投递命令必须转入 cancelling，等设备确认或超时后才终态。
      target = delivered > 0 ? "cancelling" : "cancelled";
      const updated = db.prepare(`UPDATE tasks SET state=?,cancel_requested=1,updated_at=? WHERE id=? AND state IN (${fromPlaceholders})`)
        .run(target, changedAt, id, ...transition.from);
      if (updated.changes !== 1) throw new Error("invalid-transition");
      db.prepare("UPDATE commands SET state='cancelled' WHERE task_id=? AND state='pending'").run(id);
      db.prepare("UPDATE commands SET state='cancelling' WHERE task_id=? AND state IN ('offered','received','running')").run(id);
      db.prepare("UPDATE task_batches SET state='cancelled',updated_at=? WHERE task_id=? AND state='pending'").run(changedAt, id);
    } else if (input.data.action === "pause") {
      // 暂停冻结 TTL：记录暂停时刻，恢复时按该时长平移截止时间。
      const updated = db.prepare(`UPDATE tasks SET state=?,paused_at=?,updated_at=? WHERE id=? AND state IN (${fromPlaceholders})`)
        .run(target, changedAt, changedAt, id, ...transition.from);
      if (updated.changes !== 1) throw new Error("invalid-transition");
      // 尚未被设备取走的命令回到 pending；received/running 保持执行中。
      db.prepare("UPDATE commands SET state='pending',lease_until=NULL WHERE task_id=? AND state='offered'").run(id);
    } else {
      const deltaMs = task.pausedAt ? Math.max(0, Date.parse(changedAt) - Date.parse(task.pausedAt)) : 0;
      const updated = db.prepare(`UPDATE tasks SET state=?,paused_at=NULL,updated_at=? WHERE id=? AND state IN (${fromPlaceholders})`)
        .run(target, changedAt, id, ...transition.from);
      if (updated.changes !== 1) throw new Error("invalid-transition");
      shiftTaskDeadlines(db, id, deltaMs, changedAt);
    }
    advanceTaskState(db, changedAt);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: `task.${input.data.action}`, targetType: "task", targetId: id,
      summary: `${input.data.action} 任务 ${id}（${task.state} → ${target}）`,
      details: { from: task.state, to: target },
    });
    return { id, state: target, from: task.state };
  })();
  return result;
});