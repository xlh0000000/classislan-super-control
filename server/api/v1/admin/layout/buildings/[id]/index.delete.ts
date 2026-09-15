export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const building = db.prepare("SELECT id,name FROM buildings WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!building) throw createError({ statusCode: 404, message: "楼栋不存在。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM buildings WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.building.delete", targetType: "building", targetId: id, summary: `删除楼栋 ${building.name}` }),
  );
  return { id, deleted: true };
});