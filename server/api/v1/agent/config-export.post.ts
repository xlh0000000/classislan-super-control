import { randomUUID } from "node:crypto";
import { z } from "zod";

const requestSchema = z.object({
  configurationId: z.string().uuid(),
  ttlMinutes: z.number().int().min(1).max(1440).default(60),
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "configurations.write");
  const input = requestSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "导出请求无效。" });
  const db = useDatabase();
  const config = db.prepare("SELECT id FROM configurations WHERE id=?").get(input.data.configurationId);
  if (!config) throw createError({ statusCode: 404, message: "配置不存在。" });
  const id = randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + input.data.ttlMinutes * 60_000).toISOString();
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO config_requests (id,configuration_id,requested_by,state,expires_at,created_at) VALUES (?,?,?,?,?,?)")
        .run(id, input.data.configurationId, user.id, "requested", expiresAt, createdAt);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "configuration.export.request", targetType: "configuration", targetId: input.data.configurationId, summary: "请求设备导出配置", details: { requestId: id } }),
  );
  return { id, configurationId: input.data.configurationId, expiresAt };
});