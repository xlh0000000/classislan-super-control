import { z } from "zod";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "organization.write");
  assertSchoolWideScope(user, "设备标签");
  const id = getRouterParam(event, "id")!;
  const input = patchSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "标签更新信息无效。" });
  const db = useDatabase();
  const tag = db.prepare("SELECT id,name FROM tags WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!tag) throw createError({ statusCode: 404, message: "标签不存在。" });
  if (input.data.name && input.data.name !== tag.name) {
    const conflict = db.prepare("SELECT 1 FROM tags WHERE name=? COLLATE NOCASE AND id<>?").get(input.data.name, id);
    if (conflict) throw createError({ statusCode: 409, message: "标签名已存在。" });
  }
  withAuditedTransaction(
    (database) => {
      database.prepare("UPDATE tags SET name=COALESCE(?,name),color=COALESCE(?,color) WHERE id=?")
        .run(input.data.name ?? null, input.data.color ?? null, id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "organization.tag.update", targetType: "tag", targetId: id, summary: `更新标签 ${tag.name}`, details: { fields: Object.keys(input.data) } }),
  );
  return { id, updatedAt: nowIso() };
});