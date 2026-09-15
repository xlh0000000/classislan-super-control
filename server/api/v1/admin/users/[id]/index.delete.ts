export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "users.write");
  assertSchoolWideScope(user, "用户管理");
  const id = getRouterParam(event, "id")!;
  if (id === user.id) throw createError({ statusCode: 400, message: "不能删除当前登录账号。" });
  const db = useDatabase();
  const target = db.prepare("SELECT id,username,role FROM users WHERE id=?").get(id) as { id: string; username: string; role: string } | undefined;
  if (!target) throw createError({ statusCode: 404, message: "用户不存在。" });
  if (target.role === "owner") throw createError({ statusCode: 400, message: "不能删除唯一所有者。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      database.prepare("DELETE FROM users WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "user.delete", targetType: "user", targetId: id, summary: `删除用户 ${target.username}` }),
  );
  return { id, deleted: true };
});