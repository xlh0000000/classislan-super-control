import { buildingPatchSchema } from "../../../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const input = buildingPatchSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "楼栋更新信息无效。" });
  const db = useDatabase();
  const building = db.prepare("SELECT id,name,sort_order sortOrder FROM buildings WHERE id=?").get(id) as { id: string; name: string; sortOrder: number } | undefined;
  if (!building) throw createError({ statusCode: 404, message: "楼栋不存在。" });
  const name = input.data.name ?? building.name;
  const sortOrder = input.data.sortOrder ?? building.sortOrder;
  withAuditedTransaction(
    (database) => {
      database.prepare("UPDATE buildings SET name=?,sort_order=? WHERE id=?").run(name, sortOrder, id);
      return { id, name, sortOrder };
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.building.update", targetType: "building", targetId: id, summary: `更新楼栋 ${name}`, details: { fields: Object.keys(input.data) } }),
  );
  return { id, name, sortOrder };
});