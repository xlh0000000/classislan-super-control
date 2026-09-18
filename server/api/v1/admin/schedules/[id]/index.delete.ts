import { appendAuditWithin } from "../../../../../utils/security";
import { scheduleVisibleWhere } from "../../../../../utils/auto-tasks";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const row = db.prepare(`SELECT name FROM task_schedules s WHERE s.id=? AND ${visible.sql}`).get(id, ...visible.params) as { name: string } | undefined;
  if (!row) throw createError({ statusCode: 404, message: "调度不存在。" });
  const now = new Date().toISOString();
  db.transaction(() => {
    // 已派生的任务实例保留（tasks 不级联删除），只停止后续派生。
    db.prepare("DELETE FROM task_schedules WHERE id=?").run(id);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "schedule.delete", targetType: "schedule", targetId: id,
      summary: `删除周期调度 ${row.name}`, details: {},
    });
  })();
  return { id, deleted: true, now };
});
