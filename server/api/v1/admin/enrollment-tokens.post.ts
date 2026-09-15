import { randomUUID } from "node:crypto";
import { enrollmentTokenSchema } from "../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const input = enrollmentTokenSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "输入无效" });
  const token = randomToken(32);
  const id = randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + input.data.ttlMinutes * 60_000).toISOString();
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "enrollment.write");
  assertSchoolWideScope(user, "设备接入凭据");
  const db = useDatabase();
  const tagIds = [...new Set(input.data.tagIds)];
  if (tagIds.length !== input.data.tagIds.length) throw createError({ statusCode: 400, message: "接入码包含重复标签。" });
  if (input.data.orgNodeId && !db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(input.data.orgNodeId))
    throw createError({ statusCode: 400, message: "接入码引用的组织不存在。" });
  if (tagIds.length) {
    const placeholders = tagIds.map(() => "?").join(",");
    const tagCount = (db.prepare(`SELECT COUNT(*) count FROM tags WHERE id IN (${placeholders})`).get(...tagIds) as { count: number }).count;
    if (tagCount !== tagIds.length) throw createError({ statusCode: 400, message: "接入码引用了不存在的标签。" });
  }
  withAuditedTransaction(
    (database) => {
      database.prepare(`INSERT INTO enrollment_tokens
        (id,token_hash,kind,org_node_id,max_uses,expires_at,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, sha256(token), input.data.kind, input.data.orgNodeId ?? null, input.data.maxUses, expiresAt, user.id, createdAt);
      const addTag = database.prepare("INSERT INTO enrollment_token_tags (enrollment_token_id,tag_id) VALUES (?,?)");
      for (const tagId of tagIds) addTag.run(id, tagId);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "enrollment.create", targetType: "enrollment_token", targetId: id, summary: `创建${input.data.kind === "code" ? "一次性接入码" : "预配置批量凭据"}`, details: { expiresAt, maxUses: input.data.maxUses } }),
  );
  return { token, expiresAt };
});