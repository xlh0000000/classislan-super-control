import { z } from "zod";
import { revokeUserSessions } from "../../../../../utils/users";

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  role: z.enum(["owner", "admin", "operator", "auditor", "viewer", "teacher"]).optional(),
  password: z.string().min(12).max(128).optional(),
  scopeOrgNodeId: z.string().uuid().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "users.write");
  assertSchoolWideScope(user, "用户管理");
  const id = getRouterParam(event, "id")!;
  const input = updateSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "用户更新信息无效。" });
  const db = useDatabase();
  const target = db.prepare("SELECT id,username,role FROM users WHERE id=?").get(id) as { id: string; username: string; role: string } | undefined;
  if (!target) throw createError({ statusCode: 404, message: "用户不存在。" });
  if (target.role === "owner" && input.data.role && input.data.role !== "owner")
    throw createError({ statusCode: 400, message: "不能降级唯一所有者。" });
  if (target.role === "owner" && input.data.scopeOrgNodeId && input.data.scopeOrgNodeId !== null)
    throw createError({ statusCode: 400, message: "所有者始终为全校范围。" });
  if (input.data.scopeOrgNodeId && !db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(input.data.scopeOrgNodeId))
    throw createError({ statusCode: 400, message: "范围组织不存在。" });
  const passwordHash = input.data.password ? await hashPassword(input.data.password) : null;
  const changedAt = nowIso();
  withAuditedTransaction(
    (database) => {
      // 编辑资料不应隐式重新启用账号；启用/停用只能走显式的 enable/disable 端点。
      if (input.data.displayName)
        database.prepare("UPDATE users SET display_name=? WHERE id=?").run(input.data.displayName, id);
      if (input.data.role)
        database.prepare("UPDATE users SET role=? WHERE id=?").run(input.data.role, id);
      if (input.data.scopeOrgNodeId !== undefined)
        database.prepare("UPDATE users SET scope_org_node_id=? WHERE id=?").run(input.data.scopeOrgNodeId, id);
      else if (input.data.role === "owner")
        database.prepare("UPDATE users SET scope_org_node_id=NULL WHERE id=?").run(id);
      // 管理员代设的口令只有操作者知道，交给本人首登时换掉。
      if (passwordHash) database.prepare("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?").run(passwordHash, id);
      // 口令、角色或组织范围变化都会改变既有会话的授权含义，必须撤销并要求重新登录。
      const roleChanged = input.data.role !== undefined && input.data.role !== target.role;
      if (passwordHash || roleChanged || input.data.scopeOrgNodeId !== undefined) revokeUserSessions(database, id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "user.update", targetType: "user", targetId: id, summary: `更新用户 ${target.username}`, details: { fields: Object.keys(input.data) } }),
  );
  return { id, updatedAt: changedAt };
});