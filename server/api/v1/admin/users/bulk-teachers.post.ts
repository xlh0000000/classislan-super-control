import { z } from "zod";
import { createTeacherAccounts, MAX_TEACHER_BATCH } from "../../../../utils/teacher-accounts";

const bulkTeacherSchema = z.object({
  accounts: z.array(z.object({
    username: z.string().min(1).max(64),
    displayName: z.string().trim().max(50).optional(),
  })).min(1).max(MAX_TEACHER_BATCH),
  scopeOrgNodeId: z.string().uuid().nullable().optional(),
});

/**
 * 批量生成教师账号：一次贴进一批用户名（可选带姓名），返回随机初始口令供当场抄给本人。
 * 口令只在这一次响应里出现，库里只有哈希；账号带强制首改标记，教师首次登录必须自己换密码。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "users.write");
  assertSchoolWideScope(user, "用户管理");
  const input = bulkTeacherSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "批量建号信息无效。" });
  const db = useDatabase();
  const scopeOrgNodeId = input.data.scopeOrgNodeId ?? null;
  if (scopeOrgNodeId && !db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(scopeOrgNodeId))
    throw createError({ statusCode: 400, message: "范围组织不存在。" });
  return createTeacherAccounts(db, user.id, { accounts: input.data.accounts, scopeOrgNodeId });
});
