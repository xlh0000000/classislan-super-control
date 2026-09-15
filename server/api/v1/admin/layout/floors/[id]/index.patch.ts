import { floorPatchSchema } from "../../../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const input = floorPatchSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "楼层更新信息无效。" });
  const db = useDatabase();
  const floor = db.prepare("SELECT id,name,level,sort_order sortOrder FROM building_floors WHERE id=?").get(id) as { id: string; name: string; level: number; sortOrder: number } | undefined;
  if (!floor) throw createError({ statusCode: 404, message: "楼层不存在。" });
  const name = input.data.name ?? floor.name;
  const level = input.data.level ?? floor.level;
  const sortOrder = input.data.sortOrder ?? floor.sortOrder;
  withAuditedTransaction(
    (database) => {
      database.prepare("UPDATE building_floors SET name=?,level=?,sort_order=? WHERE id=?").run(name, level, sortOrder, id);
      return { id, name, level, sortOrder };
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.floor.update", targetType: "building_floor", targetId: id, summary: `更新楼层 ${name}`, details: { fields: Object.keys(input.data) } }),
  );
  return { id, name, level, sortOrder };
});