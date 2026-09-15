import { randomUUID } from "node:crypto";
import { z } from "zod";

const createTagSchema = z.object({ name: z.string().trim().min(1).max(50), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb") });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "organization.write");
  assertSchoolWideScope(user, "设备标签");
  const input = createTagSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "标签信息无效。" });
  const id = randomUUID();
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO tags (id,name,color,created_at) VALUES (?,?,?,?)")
        .run(id, input.data.name, input.data.color, nowIso());
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "organization.tag.create", targetType: "tag", targetId: id, summary: `创建设备标签 ${input.data.name}` }),
  );
  return { id, ...input.data };
});