import { roomPatchSchema } from "../../../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const input = roomPatchSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "教室更新信息无效。" });
  const db = useDatabase();
  const room = db.prepare("SELECT id,name,sort_order sortOrder FROM building_rooms WHERE id=?").get(id) as { id: string; name: string; sortOrder: number } | undefined;
  if (!room) throw createError({ statusCode: 404, message: "教室不存在。" });
  const name = input.data.name ?? room.name;
  const sortOrder = input.data.sortOrder ?? room.sortOrder;
  withAuditedTransaction(
    (database) => {
      database.prepare("UPDATE building_rooms SET name=?,sort_order=? WHERE id=?").run(name, sortOrder, id);
      return { id, name, sortOrder };
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.room.update", targetType: "building_room", targetId: id, summary: `更新教室 ${name}`, details: { fields: Object.keys(input.data) } }),
  );
  return { id, name, sortOrder };
});