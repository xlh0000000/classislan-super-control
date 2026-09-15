import { randomUUID } from "node:crypto";
import { floorCreateSchema } from "../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const input = floorCreateSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "楼层信息无效。" });
  const db = useDatabase();
  const building = db.prepare("SELECT id,name FROM buildings WHERE id=?").get(input.data.buildingId) as { id: string; name: string } | undefined;
  if (!building) throw createError({ statusCode: 404, message: "楼栋不存在。" });
  const id = randomUUID();
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO building_floors (id,building_id,name,level,sort_order,created_at) VALUES (?,?,?,?,?,?)")
        .run(id, input.data.buildingId, input.data.name, input.data.level, 0, nowIso());
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.floor.create", targetType: "building_floor", targetId: id, summary: `${building.name} 新增楼层 ${input.data.name}`, details: { buildingId: building.id } }),
  );
  return { id, buildingId: input.data.buildingId, name: input.data.name, level: input.data.level, sortOrder: 0 };
});