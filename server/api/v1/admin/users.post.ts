import { randomUUID } from "node:crypto";
import { z } from "zod";

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(50).optional(),
  role: z.enum(["admin", "operator", "auditor", "viewer", "teacher"]),
  scopeOrgNodeId: z.string().uuid().nullable().optional(),
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "users.write");
  assertSchoolWideScope(user, "用户管理");
  const input = createUserSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "用户信息无效。" });
  const db = useDatabase();
  const existing = db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(input.data.username);
  if (existing) throw createError({ statusCode: 409, message: "用户名已存在。" });
  const scopeOrgNodeId = input.data.scopeOrgNodeId ?? null;
  if (scopeOrgNodeId && !db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(scopeOrgNodeId))
    throw createError({ statusCode: 400, message: "范围组织不存在。" });
  const id = randomUUID();
  const createdAt = nowIso();
  const passwordHash = await hashPassword(input.data.password);
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, input.data.username, passwordHash, input.data.displayName ?? input.data.username, input.data.role, scopeOrgNodeId, createdAt);
      return { id, username: input.data.username, role: input.data.role, scopeOrgNodeId };
    },
    (created) => ({ actorType: "user", actorId: user.id, action: "user.create", targetType: "user", targetId: created.id, summary: `创建用户 ${created.username}`, details: { role: created.role, scopeOrgNodeId: created.scopeOrgNodeId } }),
  );
  return { id, username: input.data.username, role: input.data.role, scopeOrgNodeId };
});