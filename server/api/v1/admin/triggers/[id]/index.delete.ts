import { appendAuditWithin } from "../../../../../utils/security";
import { scheduleVisibleWhere } from "../../../../../utils/auto-tasks";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const row = db.prepare(`SELECT name FROM triggers t WHERE t.id=? AND ${visible.sql}`).get(id, ...visible.params) as { name: string } | undefined;
  if (!row) throw createError({ statusCode: 404, message: "触发器不存在。" });
  db.transaction(() => {
    // 派生出的任务实例保留；trigger_fires 由外键级联清理。
    db.prepare("DELETE FROM triggers WHERE id=?").run(id);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "trigger.delete", targetType: "trigger", targetId: id,
      summary: `删除事件触发器 ${row.name}`, details: {},
    });
  })();
  return { id, deleted: true };
});
