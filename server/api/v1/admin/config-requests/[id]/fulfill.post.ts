import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configurationDocumentSchema, normalizeConfigurationDocument } from "../../../../../../shared/schemas";

const fulfillSchema = z.object({
  deviceId: z.string().uuid(),
  document: z.record(z.string(), z.unknown()),
  name: z.string().trim().min(1).max(100).optional(),
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "configurations.write");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const input = fulfillSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "配置回传无效。" });
  const db = useDatabase();
  const request = db.prepare("SELECT id,configuration_id configurationId,state FROM config_requests WHERE id=?").get(id) as { id: string; configurationId: string; state: string } | undefined;
  if (!request) throw createError({ statusCode: 404, message: "导出请求不存在。" });
  if (request.state !== "requested") throw createError({ statusCode: 409, message: "导出请求已结束。" });
  const device = db.prepare("SELECT 1 FROM devices WHERE id=?").get(input.data.deviceId);
  if (!device) throw createError({ statusCode: 400, message: "设备不存在。" });
  const config = db.prepare("SELECT id,kind FROM configurations WHERE id=?").get(request.configurationId) as { id: string; kind: string } | undefined;
  if (!config) throw createError({ statusCode: 404, message: "配置不存在。" });
  // 回传同样经过版本化结构校验，并补全 schemaVersion，避免设备写入未版本化文档。
  const documentCheck = configurationDocumentSchema(config.kind as "profile" | "components" | "automation" | "plugin").safeParse(input.data.document);
  if (!documentCheck.success) throw createError({ statusCode: 400, message: documentCheck.error.issues[0]?.message || "配置文档结构无效。" });
  const normalized = normalizeConfigurationDocument(config.kind as "profile" | "components" | "automation" | "plugin", input.data.document);
  if (JSON.stringify(normalized).length > 2_000_000) throw createError({ statusCode: 413, message: "配置文档超过大小限制。" });
  const save = db.transaction(() => {
    const current = db.prepare("SELECT COALESCE(MAX(revision),0) value FROM configuration_revisions WHERE configuration_id=?").get(request.configurationId) as { value: number };
    const revision = current.value + 1;
    const revisionId = randomUUID();
    const document = JSON.stringify(normalized);
    const createdAt = nowIso();
    db.prepare(`INSERT INTO configuration_revisions
      (id,configuration_id,kind,name,revision,document,document_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(revisionId, request.configurationId, config.kind, input.data.name ?? `设备回传 R${revision}`, revision, document, sha256(document), user.id, createdAt);
    db.prepare("UPDATE configurations SET current_revision_id=?,updated_at=? WHERE id=?").run(revisionId, createdAt, request.configurationId);
    db.prepare("UPDATE config_requests SET state='fulfilled' WHERE id=?").run(id);
    const result = { revision, schemaVersion: normalized.schemaVersion, documentHash: sha256(document) };
    appendAuditWithin(db, { actorType: "user", actorId: user.id, action: "configuration.export.fulfill", targetType: "configuration", targetId: request.configurationId, summary: "接收设备配置回传", details: { requestId: id, deviceId: input.data.deviceId } });
    return result;
  });
  return { id, configurationId: request.configurationId, ...save() };
});