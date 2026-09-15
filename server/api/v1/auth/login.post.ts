import { z } from "zod";

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

export default defineEventHandler(async (event) => {
  const input = loginSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "账号或密码格式无效。" });
  const row = useDatabase().prepare("SELECT id,username,password_hash passwordHash FROM users WHERE username=? COLLATE NOCASE AND disabled_at IS NULL")
    .get(input.data.username) as { id: string; username: string; passwordHash: string } | undefined;
  const valid = row ? await verifyPassword(row.passwordHash, input.data.password) : false;
  if (!valid || !row) throw createError({ statusCode: 401, message: "账号或密码不正确。" });
  withAuditedTransaction(
    () => { createSession(event, row.id); return row.id; },
    () => ({ actorType: "user", actorId: row.id, action: "auth.login", targetType: "session", summary: `${row.username} 登录控制平面` }),
  );
  return { authenticated: true };
});
