import { randomUUID } from "node:crypto";
import { buildingCreateSchema } from "../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const input = buildingCreateSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "楼栋信息无效。" });
  const id = randomUUID();
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO buildings (id,name,sort_order,created_at) VALUES (?,?,?,?)")
        .run(id, input.data.name, input.data.sortOrder, nowIso());
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.building.create", targetType: "building", targetId: id, summary: `新建楼栋 ${input.data.name}` }),
  );
  return { id, name: input.data.name, sortOrder: input.data.sortOrder };
});