import { appendAuditWithin } from "../../../../../utils/security";
import { assertOrgNodeInScope } from "../../../../../utils/scope";
import { conditionFromBody, triggerBodySchema } from "../../../../../utils/auto-triggers";
import { scheduleVisibleWhere } from "../../../../../utils/auto-tasks";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = triggerBodySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "触发器定义无效。" });
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  if (input.data.scopeType === "organization") assertOrgNodeInScope(db, user, input.data.scopeId ?? null);
  const visible = scheduleVisibleWhere(user);
  const row = db.prepare(`SELECT state FROM triggers t WHERE t.id=? AND ${visible.sql}`).get(id, ...visible.params) as { state: string } | undefined;
  if (!row) throw createError({ statusCode: 404, message: "触发器不存在。" });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE triggers SET name=?,kind=?,condition=?,scope_type=?,scope_id=?,targets=?,capability_id=?,payload=?,
      ttl_minutes=?,cooldown_minutes=?,updated_at=? WHERE id=?`)
      .run(input.data.name, input.data.kind, JSON.stringify(conditionFromBody(input.data)),
        input.data.scopeType, input.data.scopeId ?? null, JSON.stringify(input.data.targets ?? []),
        input.data.capabilityId, JSON.stringify(input.data.payload),
        input.data.ttlMinutes, input.data.cooldownMinutes, now, id);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "trigger.update", targetType: "trigger", targetId: id,
      summary: `修改事件触发器 ${input.data.name}`,
      details: { kind: input.data.kind, capabilityId: input.data.capabilityId },
    });
  })();
  return { id, state: row.state };
});
