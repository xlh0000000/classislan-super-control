import { randomUUID } from "node:crypto";
import { z } from "zod";

const rollbackSchema = z.object({ revision: z.number().int().positive() });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "configurations.write");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const input = rollbackSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "回滚参数无效。" });
  const db = useDatabase();
  const target = db.prepare("SELECT document,name FROM configuration_revisions WHERE configuration_id=? AND revision=?").get(id, input.data.revision) as { document: string; name: string } | undefined;
  if (!target) throw createError({ statusCode: 404, message: "回滚目标修订不存在。" });
  const save = db.transaction(() => {
    const current = db.prepare("SELECT COALESCE(MAX(revision),0) value FROM configuration_revisions WHERE configuration_id=?").get(id) as { value: number };
    const revision = current.value + 1;
    const revisionId = randomUUID();
    const document = target.document;
    const createdAt = nowIso();
    db.prepare(`INSERT INTO configuration_revisions
      (id,configuration_id,kind,name,revision,document,document_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(revisionId, id, "profile", `回滚到 R${input.data.revision}`, revision, document, sha256(document), user.id, createdAt);
    db.prepare("UPDATE configurations SET current_revision_id=?,updated_at=? WHERE id=?").run(revisionId, createdAt, id);
    const result = { revision, documentHash: sha256(document) };
    appendAuditWithin(db, { actorType: "user", actorId: user.id, action: "configuration.rollback", targetType: "configuration", targetId: id, summary: `回滚配置 ${target.name} 到 R${input.data.revision}`, details: { from: input.data.revision, to: result.revision } });
    return result;
  });
  return { id, ...save() };
});