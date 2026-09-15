import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configurationDocumentSchema, normalizeConfigurationDocument } from "../../../../shared/schemas";

const configurationSchema = z.object({
  configurationId: z.string().uuid().optional(),
  kind: z.enum(["profile", "components", "automation", "plugin"]),
  name: z.string().trim().min(1).max(100),
  document: z.record(z.string(), z.unknown()),
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "configurations.write");
  assertSchoolWideScope(user, "配置库");
  const input = configurationSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "配置文档无效。" });
  // 版本化结构校验：根、schemaVersion 与该类型顶层节的形状。
  const documentCheck = configurationDocumentSchema(input.data.kind).safeParse(input.data.document);
  if (!documentCheck.success) throw createError({ statusCode: 400, message: documentCheck.error.issues[0]?.message || "配置文档结构无效。" });
  const document = normalizeConfigurationDocument(input.data.kind, input.data.document);
  if (JSON.stringify(document).length > 2_000_000) throw createError({ statusCode: 413, message: "配置文档超过大小限制。" });
  const db = useDatabase();
  const configurationId = input.data.configurationId ?? randomUUID();
  const save = db.transaction(() => {
    const row = db.prepare("SELECT id,current_revision_id currentRevisionId FROM configurations WHERE id=?").get(configurationId) as { id: string; currentRevisionId: string | null } | undefined;
    if (!row) {
      db.prepare("INSERT INTO configurations (id,kind,name,updated_at) VALUES (?,?,?,?)")
        .run(configurationId, input.data.kind, input.data.name, nowIso());
    }
    const current = db.prepare("SELECT COALESCE(MAX(revision),0) value FROM configuration_revisions WHERE configuration_id=?").get(configurationId) as { value: number };
    const revision = current.value + 1;
    const id = randomUUID();
    const serialized = JSON.stringify(document);
    const createdAt = nowIso();
    db.prepare(`INSERT INTO configuration_revisions
      (id,configuration_id,kind,name,revision,document,document_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, configurationId, input.data.kind, input.data.name, revision, serialized, sha256(serialized), user.id, createdAt);
    db.prepare("UPDATE configurations SET current_revision_id=?,kind=?,name=?,updated_at=? WHERE id=?").run(id, input.data.kind, input.data.name, createdAt, configurationId);
    const result = { id, configurationId, revision, schemaVersion: document.schemaVersion, documentHash: sha256(serialized) };
    appendAuditWithin(db, { actorType: "user", actorId: user.id, action: "configuration.revision.create", targetType: "configuration", targetId: configurationId, summary: `保存配置 ${input.data.name} R${result.revision}`, details: { kind: input.data.kind, schemaVersion: document.schemaVersion } });
    return result;
  });
  return save();
});