export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const room = db.prepare("SELECT id,name FROM building_rooms WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!room) throw createError({ statusCode: 404, message: "教室不存在。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM building_rooms WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "layout.room.delete", targetType: "building_room", targetId: id, summary: `删除教室 ${room.name}` }),
  );
  return { id, deleted: true };
});