export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "configurations.read");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const config = db.prepare(`SELECT c.id configurationId,c.kind,c.name,c.updated_at updatedAt,
    cr.revision currentRevision, cr.document_hash currentHash, cr.created_at revisionCreatedAt
    FROM configurations c LEFT JOIN configuration_revisions cr ON cr.id=c.current_revision_id
    WHERE c.id=?`).get(id) as Record<string, unknown> | undefined;
  if (!config) throw createError({ statusCode: 404, message: "配置不存在。" });
  return config;
});