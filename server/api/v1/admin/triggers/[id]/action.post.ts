import { z } from "zod";
import { appendAuditWithin } from "../../../../../utils/security";
import { scheduleVisibleWhere } from "../../../../../utils/auto-tasks";

const actionSchema = z.object({ action: z.enum(["pause", "resume"]) });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = actionSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "触发器操作无效。" });
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const row = db.prepare(`SELECT state,name FROM triggers t WHERE t.id=? AND ${visible.sql}`).get(id, ...visible.params) as { state: string; name: string } | undefined;
  if (!row) throw createError({ statusCode: 404, message: "触发器不存在。" });
  const want = input.data.action === "pause" ? "active" : "paused";
  if (row.state !== want)
    throw createError({ statusCode: 409, message: `触发器当前状态 ${row.state} 不允许执行 ${input.data.action}。` });
  const now = new Date().toISOString();
  const target = input.data.action === "pause" ? "paused" : "active";
  db.transaction(() => {
    db.prepare("UPDATE triggers SET state=?,last_error=NULL,updated_at=? WHERE id=? AND state=?").run(target, now, id, want);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: `trigger.${input.data.action}`, targetType: "trigger", targetId: id,
      summary: `${input.data.action} 触发器 ${row.name}`,
      details: { from: row.state, to: target },
    });
  })();
  return { id, state: target };
});
