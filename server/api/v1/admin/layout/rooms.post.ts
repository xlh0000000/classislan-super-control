import { randomUUID } from "node:crypto";
import { roomCreateSchema } from "../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const input = roomCreateSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "教室信息无效。" });
  const db = useDatabase();
  const floor = db.prepare("SELECT id,name FROM building_floors WHERE id=?").get(input.data.floorId) as { id: string; name: string } | undefined;
  if (!floor) throw createError({ statusCode: 404, message: "楼层不存在。" });
  const id = randomUUID();
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO building_rooms (id,floor_id,name,sort_order,created_at) VALUES (?,?,?,?,?)")
        .run(id, input.data.floorId, input.data.name, 0, nowIso());
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.room.create", targetType: "building_room", targetId: id, summary: `${floor.name} 新增教室 ${input.data.name}`, details: { floorId: floor.id } }),
  );
  return { id, floorId: input.data.floorId, name: input.data.name, sortOrder: 0 };
});