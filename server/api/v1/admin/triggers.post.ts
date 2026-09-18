import { randomUUID } from "node:crypto";
import { appendAuditWithin } from "../../../utils/security";
import { assertOrgNodeInScope } from "../../../utils/scope";
import { conditionFromBody, triggerBodySchema } from "../../../utils/auto-triggers";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = triggerBodySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "触发器定义无效。" });
  const db = useDatabase();
  if (input.data.scopeType === "organization") assertOrgNodeInScope(db, user, input.data.scopeId ?? null);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO triggers
      (id,name,kind,condition,scope_type,scope_id,targets,capability_id,payload,ttl_minutes,cooldown_minutes,state,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active',?,?,?,?)`)
      .run(id, input.data.name, input.data.kind, JSON.stringify(conditionFromBody(input.data)),
        input.data.scopeType, input.data.scopeId ?? null, JSON.stringify(input.data.targets ?? []),
        input.data.capabilityId, JSON.stringify(input.data.payload),
        input.data.ttlMinutes, input.data.cooldownMinutes, user.id, now, now);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "trigger.create", targetType: "trigger", targetId: id,
      summary: `创建事件触发器 ${input.data.name}`,
      details: { kind: input.data.kind, capabilityId: input.data.capabilityId },
    });
  })();
  return { id };
});
