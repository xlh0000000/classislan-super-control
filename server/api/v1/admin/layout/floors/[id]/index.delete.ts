export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const floor = db.prepare("SELECT id,name FROM building_floors WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!floor) throw createError({ statusCode: 404, message: "楼层不存在。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM building_floors WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.floor.delete", targetType: "building_floor", targetId: id, summary: `删除楼层 ${floor.name}` }),
  );
  return { id, deleted: true };
});