import { z } from "zod";
import { applyPasswordChange } from "../../../utils/users";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(128),
});

/**
 * 自助改密：教师账号由管理员批量生成，首登即从这里把初始密码换成自己的密码。
 * 走的是当前会话本身，因此不需要额外授权；改完只留下这个会话，其余会话作废。
 */
export default defineEventHandler(async (event) => {
  const user = requireUser(event);
  const input = changePasswordSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "新密码至少 12 位。" });
  if (input.data.currentPassword === input.data.newPassword)
    throw createError({ statusCode: 400, message: "新密码不能与当前密码相同。" });
  const db = useDatabase();
  const row = db.prepare("SELECT password_hash passwordHash FROM users WHERE id=? AND disabled_at IS NULL").get(user.id) as { passwordHash: string } | undefined;
  if (!row) throw createError({ statusCode: 401, message: "账号不可用，请重新登录。" });
  if (!await verifyPassword(row.passwordHash, input.data.currentPassword))
    throw createError({ statusCode: 403, message: "当前密码不正确。" });
  applyPasswordChange(db, { userId: user.id, sessionId: user.sessionId, passwordHash: await hashPassword(input.data.newPassword) });
  return { changed: true };
});
